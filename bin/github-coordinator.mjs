#!/usr/bin/env node

/**
 * One local GitHub API/CLI queue for all agents in this workspace.
 *
 * There are no third-party dependencies.  The daemon is deliberately small:
 * it serializes mutations, bounds concurrent reads, deduplicates identical
 * GETs, keeps a short in-memory ETag cache, and turns rate-limit responses
 * into bucket-wide backpressure.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createUtf8ChunkDecoder,
  normalizeIdentity,
  coordinatorOwnerLockPath,
  legacyStateDirectory,
  socketPath,
  stateDirectory,
} from './github-coordinator-client.mjs';
import {
  GitHubEventBroker,
  normalizeReconciliationEvent,
  pullRequestMergeability,
  shaMatches,
} from './github-event-broker.mjs';
import { assertEventIdentity, hasEventRoute } from './github-event-routing.mjs';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const COORDINATOR_PROTOCOL_VERSION = 6;
const DEFAULT_API_VERSION = process.env.FRONTALIERE_GITHUB_API_VERSION || '2022-11-28';
function positiveIntegerFromEnvironment(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

// Global ceiling of GitHub work in flight. The quota was never the constraint
// (6% of 5,000/h used at peak): the old ceiling of 8 was shared by 50 ms REST
// reads, multi-second `gh` spawns and 240 MB artifact downloads alike, so a
// handful of slow commands queued every agent behind them. Each kind of work
// now has its own lane below; this ceiling only bounds their sum and still
// shrinks with the observed rate-limit headroom.
export const MAX_IN_FLIGHT = positiveIntegerFromEnvironment('FRONTALIERE_GH_MAX_IN_FLIGHT', 16);
export const LANE_LIMITS = Object.freeze({
  // In-process fetch: REST GETs, GraphQL queries and the `gh api` subset
  // parsed natively. Cheap locally; bounded by the global ceiling.
  api: positiveIntegerFromEnvironment('FRONTALIERE_GH_API_LANE', 16),
  // A spawn of the real `gh` binary per job: CPU and memory on this machine.
  cli: positiveIntegerFromEnvironment('FRONTALIERE_GH_CLI_LANE', 6),
  // Long transfers (downloads, clones, job logs, --paginate): they must not
  // hold the slots of short reads for minutes.
  bulk: positiveIntegerFromEnvironment('FRONTALIERE_GH_BULK_LANE', 2),
  // GitHub asks for serialized mutations spaced by one second.
  mutation: 1,
});
export const LANES = Object.freeze(['api', 'cli', 'bulk', 'mutation']);
const HEADROOM_CONCURRENCY_STEPS = [
  { ratio: 0.30, max: 6 },
  { ratio: 0.15, max: 4 },
  { ratio: 0.05, max: 2 },
];
// GitHub secondary limits: 900 points/min for REST (GET 1, mutation 5) and
// 2,000 for GraphQL. With 16 slots a runaway loop could cross them in a
// minute and pause every agent on a 403; stay at 80% of each window.
export const SECONDARY_LIMIT_WINDOW_MS = 60 * 1_000;
export const SECONDARY_LIMIT_BUDGETS = Object.freeze({ rest: 720, graphql: 1_600 });
const MAX_API_ATTEMPTS = 3;
const MUTATION_GAP_MS = 1_000;
const CLI_CACHE_TTL_MS = 15_000;
// A `gh` child that outlives these deadlines is hung (stdin is closed): it
// would otherwise keep a lane slot until the daemon restarts.
export const CLI_TIMEOUT_MS = Object.freeze({
  cli: 5 * 60 * 1_000,
  bulk: 30 * 60 * 1_000,
  mutation: 15 * 60 * 1_000,
});
const CLI_KILL_GRACE_MS = 5_000;
// Response caches are bounded LRUs; stale entries survive only to carry
// ETag/Last-Modified for a conditional request (a 304 costs no quota).
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_REVALIDATION_BODY_BYTES = 512 * 1024;
const STALE_CACHE_RETENTION_MS = 30 * 60 * 1_000;
const MAX_CLI_CACHE_ENTRIES = 256;
const CACHE_SWEEP_INTERVAL_MS = 60 * 1_000;
const LATENCY_SAMPLE_LIMIT = 256;
const MAX_REQUEST_KINDS = 64;
const WORKING_DIRECTORY_REPO_TTL_MS = 10 * 60 * 1_000;
const ANONYMOUS_BUDGET = 45;
const ANONYMOUS_WINDOW_MS = 60 * 60 * 1_000;
const CANCELLATION_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_CACHE_TTL_MS = 60_000;
export const WORKFLOW_CATALOG_CACHE_TTL_MS = 60 * 60 * 1_000;
export const WORKFLOW_CATALOG_REFRESH_COOLDOWN_MS = 5 * 60 * 1_000;
const MAX_PAGINATED_API_PAGES = 1_000;
const configuredMaxBodyBytes = Number(process.env.FRONTALIERE_GH_MAX_BODY_BYTES || 0);
const MAX_BODY_BYTES = Number.isFinite(configuredMaxBodyBytes) && configuredMaxBodyBytes >= 1024
  ? Math.floor(configuredMaxBodyBytes)
  : 8 * 1024 * 1024;
// The persistent services have exactly these two identities.  Other names are
// used by isolated coordinator unit fixtures and do not represent a production
// receiver/token route; they remain deliberately unbound here.
const EVENT_ROUTING_IDENTITIES = new Set(['default', 'nanako']);

// Fairness key of the coordinator's own reads (reconciliation, workflow names).
const EVENT_CLIENT_KEY = 'coordinator:events';
export const EVENT_SWEEP_INTERVAL_MS = 2 * 60 * 1_000;
export const EVENT_SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1_000;
// A sweep is a recovery hint, not a second event-delivery plane. Its reads
// run in the API lane with their own fairness key, so a few per turn cannot
// occupy the queue; one per two minutes could not even revisit every live
// observer once per interval.
export const EVENT_SWEEP_MAX_PER_RUN = 3;
// Observers without a listener are revisited less often than live ones.
export const EVENT_SWEEP_ORPHAN_INTERVAL_FACTOR = 3;
// Orphan lifecycle. A subscription whose listener is gone is archived (not
// deleted): `events listen` on its id restores it, pending events included,
// and reconciles it. Nothing is archived in the first minutes after a start,
// while listeners of live sessions reconnect.
export const ORPHAN_RETIRE_STARTUP_GRACE_MS = 10 * 60 * 1_000;
export const ORPHAN_PENDING_RETIRE_MS = 60 * 60 * 1_000;
export const ORPHAN_IDLE_RETIRE_MS = 6 * 60 * 60 * 1_000;
export const ORPHAN_RETIRE_INTERVAL_MS = 60 * 1_000;
// GitHub sends no webhook to a PR that becomes CONFLICTING because its base
// moved, and computes `mergeable` lazily: a GET starts the computation and
// may answer null. When a base branch moves (merged PR, push-triggered run)
// the followed open PRs on it are re-read, with retries on null.
export const MERGEABILITY_RECHECK_DELAY_MS = 10 * 1_000;
export const MERGEABILITY_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 45_000]);
export const MERGEABILITY_RECHECK_MAX_PULL_REQUESTS = 25;
export const DEFAULT_SCHEDULED_GC_AGE_MS = 60 * 60 * 1_000;
export const SCHEDULED_GC_BOOTSTRAP_DELAY_MS = 250;
export const SCHEDULED_GC_BATCH_SIZE = 16;
// Kept for compatibility with older diagnostics; all scheduled inspections
// now yield in batches regardless of state size.
export const SCHEDULED_GC_SYNC_SUBSCRIPTION_LIMIT = 32;
export const SOCKET_IDLE_TIMEOUT_MS = 10 * 1_000;
export const SCHEDULED_GC_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * The branch whose head moved, from a verified webhook payload, or null.
 * GitHub delivers no `push` to this receiver today (none among 256 audited
 * deliveries), so a merged PR and a push-triggered workflow run are the
 * signals that actually arrive; `push` is handled for when it is enabled.
 */
export function baseBranchMovement(eventName, payload) {
  const repo = payload?.repository?.full_name;
  if (!repo || !payload) return null;
  const event = String(eventName || '').toLowerCase();
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged === true) {
    const branch = payload.pull_request?.base?.ref;
    return branch ? { repo, branch, excludeNumber: payload.pull_request?.number ?? null } : null;
  }
  if (event === 'workflow_run' && payload.action === 'requested' && payload.workflow_run?.event === 'push') {
    const branch = payload.workflow_run?.head_branch;
    return branch ? { repo, branch } : null;
  }
  if (event === 'push' && typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/') && payload.deleted !== true) {
    return { repo, branch: payload.ref.slice('refs/heads/'.length) };
  }
  return null;
}

function reconcilableSubscription(subscription) {
  if (subscription.resource === 'pull_request') return Boolean(subscription.number);
  if (subscription.resource === 'workflow_run') {
    return Boolean(subscription.runId || subscription.workflow || subscription.branch || subscription.sha || subscription.followLatest);
  }
  if (subscription.resource === 'deployment') return Boolean(subscription.deploymentId);
  return false;
}

function routeAllowsIdentity(subscription, identity) {
  try {
    assertEventIdentity({ spec: subscription, actualIdentity: identity, operation: 'reconcile' });
    return true;
  } catch {
    return false;
  }
}

function eventRoutingRequired(identity, spec) {
  return EVENT_ROUTING_IDENTITIES.has(identity) || hasEventRoute(spec?.repo);
}

function scheduledGcView(report, compact) {
  if (!report || !compact) return report || null;
  const orphanedWithPending = Array.isArray(report.orphanedWithPending)
    ? report.orphanedWithPending
    : [];
  const subscriptionCount = Number(report.orphanedWithPendingSubscriptionCount);
  const eventCount = Number(report.orphanedWithPendingEventCount);
  return {
    at: report.at,
    olderThanMs: report.olderThanMs,
    orphanCandidateCount: report.orphanCandidateCount,
    orphanedWithPendingSubscriptionCount: Number.isFinite(subscriptionCount)
      ? subscriptionCount
      : orphanedWithPending.length,
    orphanedWithPendingEventCount: Number.isFinite(eventCount)
      ? eventCount
      : orphanedWithPending.reduce((total, subscription) => total + Number(subscription.pendingCount || 1), 0),
    orphanedWithPendingOldestAt: report.orphanedWithPendingOldestAt
      || orphanedWithPending.map(({ pendingSince }) => pendingSince).filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0]
      || null,
    nextAction: report.nextAction || 'reattach_or_explicit_ack',
  };
}

export const RESPONSE_TRUNCATED_CODE = 'response_body_truncated';
// Exit code dedicato (sysexits EX_DATAERR): distingue «risposta tagliata dal
// nostro cap» da 1 (errore HTTP/rete) e da 0 (risposta completa).
export const RESPONSE_TRUNCATED_EXIT_CODE = 65;
// Oltre questo tetto non contiamo piu' i byte scartati: l'errore dice
// «almeno N byte» invece di drenare un body senza fine.
const TRUNCATION_MEASURE_CEILING = MAX_BODY_BYTES * 16;

export function describeTruncation(method, path, bytes, bytesAtLeast = false) {
  const actual = Number.isInteger(bytes) && bytes > 0
    ? `${bytesAtLeast ? 'almeno ' : ''}${bytes} byte`
    : 'dimensione non misurabile';
  return `${RESPONSE_TRUNCATED_CODE}: ${method} ${path} ha un body di ${actual}, oltre il cap locale di ${MAX_BODY_BYTES} byte; il body NON viene consegnato (sarebbe JSON invalido). Alza FRONTALIERE_GH_MAX_BODY_BYTES o pagina la richiesta.`;
}
export const SOURCE_RELOAD_DEBOUNCE_MS = 3_000;
export const SOURCE_RELOAD_QUIESCENCE_MS = 250;
const OBSERVED_HEADERS = [
  'etag',
  'last-modified',
  'link',
  'location',
  'retry-after',
  'x-github-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
];

function eventStatePath(identity) {
  return join(stateDirectory(), `github-events-${normalizeIdentity(identity)}.json`);
}

function legacyEventStatePath(identity) {
  if (process.env.FRONTALIERE_GH_STATE_DIR) return null;
  const directory = legacyStateDirectory();
  return directory ? join(directory, `github-events-${normalizeIdentity(identity)}.json`) : null;
}

function loadEventBrokerStateInWorker({ stateFile, legacyStateFile }) {
  const worker = new Worker(new URL('./github-event-broker-loader.mjs', import.meta.url), {
    workerData: { stateFile, legacyStateFile: legacyStateFile || null },
  });
  let settled = false;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    worker.once('error', rejectOnce);
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) {
        rejectOnce(Object.assign(new Error(`event state loader exited with code ${code}`), {
          code: 'event_state_loader_exit',
        }));
      }
    });
    worker.once('message', (result) => {
      if (!result?.ok) {
        rejectOnce(Object.assign(new Error(result?.error?.message || 'event state load failed'), {
          code: result?.error?.code || 'event_state_load_failed',
        }));
        return;
      }
      settled = true;
      resolvePromise(result.state);
      worker.terminate().catch(() => {});
    });
  });
  return { worker, promise };
}

export const WATCHED_SOURCE_NAMES = new Set([
  'github-coordinator-client.mjs',
  'github-coordinator.mjs',
  'github-event-broker.mjs',
  'github-event-broker-loader.mjs',
  'github-event-routing.mjs',
  'github-coordinator-launcher',
]);

function describeError(error, { includeStack = true } = {}) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(includeStack && error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: typeof error, message: String(error) };
}

const CLIENT_ERROR_LOG_DEDUPE_MS = 1_000;
const clientErrorLogAt = new Map();

function logStructuredError(event, error, details = {}) {
  try {
    const isClientRequestError = event === 'client_request_failed';
    if (isClientRequestError) {
      const code = error?.code || 'coordinator_error';
      const key = `${code}:${error?.message || String(error)}`;
      const nowMs = Date.now();
      const previousAt = clientErrorLogAt.get(key) || 0;
      if (nowMs - previousAt < CLIENT_ERROR_LOG_DEDUPE_MS) return;
      clientErrorLogAt.set(key, nowMs);
      if (clientErrorLogAt.size > 512) {
        for (const [candidate, observedAt] of clientErrorLogAt) {
          if (nowMs - observedAt >= CLIENT_ERROR_LOG_DEDUPE_MS) clientErrorLogAt.delete(candidate);
        }
      }
    }
    process.stderr.write(`${JSON.stringify({
      component: 'github-coordinator',
      event,
      // Client validation/webhook failures are expected RPC outcomes. Avoid
      // formatting a deep V8 stack for every rejected delivery: a burst of
      // invalid requests must not starve ping/status on the same loop.
      error: describeError(error, { includeStack: !isClientRequestError }),
      ...details,
    })}\n`);
  } catch {
    // Logging must not turn a contained failure into a process failure.
  }
}

export function createDebouncedReloadScheduler({
  onReload,
  getActiveRequests = () => 0,
  debounceMs = SOURCE_RELOAD_DEBOUNCE_MS,
  quiescenceMs = SOURCE_RELOAD_QUIESCENCE_MS,
} = {}) {
  if (typeof onReload !== 'function') throw new TypeError('source_reload_callback_required');
  let debounceTimer = null;
  let quiescenceTimer = null;
  let pending = false;
  let stopped = false;

  const attemptReload = () => {
    debounceTimer = null;
    if (stopped || !pending) return;
    if (getActiveRequests() > 0) {
      quiescenceTimer = setTimeout(attemptReload, quiescenceMs);
      quiescenceTimer.unref?.();
      return;
    }
    pending = false;
    quiescenceTimer = null;
    onReload();
  };

  return {
    request() {
      if (stopped) return false;
      const firstRequest = !pending;
      pending = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (quiescenceTimer) clearTimeout(quiescenceTimer);
      quiescenceTimer = null;
      debounceTimer = setTimeout(attemptReload, debounceMs);
      debounceTimer.unref?.();
      return firstRequest;
    },
    stop() {
      stopped = true;
      pending = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (quiescenceTimer) clearTimeout(quiescenceTimer);
      debounceTimer = null;
      quiescenceTimer = null;
    },
    isPending() {
      return pending;
    },
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readOwnerRecord(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) {
      throw Object.assign(new Error('coordinator owner lock has no valid pid'), { code: 'coordinator_owner_lock_invalid' });
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error('coordinator owner lock is not valid JSON'), {
        code: 'coordinator_owner_lock_invalid',
        cause: error,
      });
    }
    throw error;
  }
}

const OWNER_LOCK_RECORD_PENDING = Symbol('owner_lock_record_pending');

function readOwnerRecordForClaim(lockPath) {
  try {
    return readOwnerRecord(lockPath);
  } catch (error) {
    if (error.code !== 'coordinator_owner_lock_invalid') throw error;
    // A legacy contender may still be between O_EXCL and its write. Never
    // unlink a fresh partial record: let that owner finish or launchd retry.
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < 5_000) return OWNER_LOCK_RECORD_PENDING;
    } catch (statError) {
      if (statError.code === 'ENOENT') return null;
      throw statError;
    }
    try { unlinkSync(lockPath); } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    }
    return null;
  }
}

function removePendingOwnerLockWithoutSocket(lockPath, socket) {
  try {
    if (statSync(socket).isSocket()) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { unlinkSync(lockPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

function createAtomicOwnerLock(lockPath, record) {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    const bytes = Buffer.from(record, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    // A hard link to a fully written inode is an atomic create-if-absent for
    // the owner path; readers can never observe partial JSON.
    linkSync(temporary, lockPath);
    unlinkSync(temporary);
    return fd;
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* no temporary */ }
    throw error;
  }
}

function claimCoordinatorOwner(identity, socket) {
  const lockPath = coordinatorOwnerLockPath(identity);
  let existing = readOwnerRecordForClaim(lockPath);
  if (existing === OWNER_LOCK_RECORD_PENDING) {
    if (!removePendingOwnerLockWithoutSocket(lockPath, socket)) return null;
    existing = null;
  }
  if (existing && processIsAlive(existing.pid)) return null;
  if (existing) unlinkSync(lockPath);
  const ownerId = randomUUID();
  try {
    // Keep the record in one write. The fully written inode is linked into the
    // owner path atomically, so a contender can never observe partial JSON;
    // the generation token also
    // prevents a reloader from unlinking a newer owner's lock after PID reuse.
    const record = `${JSON.stringify({
      pid: process.pid,
      identity,
      socket,
      ownerId,
      startedAt: new Date().toISOString(),
      // A supervised standby may reclaim the socket only from an owner that
      // launchd does not supervise.
      supervised: supervisedStandbyEnabled(),
    })}\n`;
    const fd = createAtomicOwnerLock(lockPath, record);
    return { fd, lockPath, socket, ownerId };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const competing = readOwnerRecordForClaim(lockPath);
    if (competing === OWNER_LOCK_RECORD_PENDING) return null;
    if (competing && processIsAlive(competing.pid)) return null;
    if (competing) unlinkSync(lockPath);
    return claimCoordinatorOwner(identity, socket);
  }
}

function ownsCoordinatorLock(ownerLock) {
  if (!ownerLock) return false;
  try {
    const record = readOwnerRecord(ownerLock.lockPath);
    return record?.pid === process.pid
      && (!ownerLock.ownerId || record.ownerId === ownerLock.ownerId);
  } catch {
    return false;
  }
}

function releaseCoordinatorOwner(ownerLock, { removeSocket = false } = {}) {
  if (!ownerLock) return;
  const ownsLock = ownsCoordinatorLock(ownerLock);
  if (ownsLock && removeSocket) {
    try { unlinkSync(ownerLock.socket); } catch { /* already gone */ }
  }
  if (ownsLock) {
    try { unlinkSync(ownerLock.lockPath); } catch { /* already gone */ }
  }
  try { closeSync(ownerLock.fd); } catch { /* already closed */ }
}

function removeStaleCoordinatorSocket(socket) {
  try {
    unlinkSync(socket);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export const SUPERVISED_STANDBY_POLL_MS = 2_000;
const SOCKET_ENDPOINT_CHECK_MS = 5_000;

export function socketEndpointVerdict(socket, boundInode, stat = statSync) {
  let current;
  try {
    current = stat(socket);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    return 'ok';
  }
  if (!current.isSocket()) return 'replaced';
  if (boundInode !== null && boundInode !== undefined && current.ino !== boundInode) return 'replaced';
  return 'ok';
}

// launchd sets FRONTALIERE_GH_SUPERVISED=1 (see github-coordinator-release).
// Without it, a second `serve` keeps the historical contract: exit at once.
export function supervisedStandbyEnabled(env = process.env) {
  return env.FRONTALIERE_GH_SUPERVISED === '1';
}

function describeOwnerProcess(pid) {
  try {
    const result = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    return String(result.stdout || '').trim().slice(0, 200) || null;
  } catch {
    return null;
  }
}

export const UNSUPERVISED_OWNER_GRACE_MS = 30_000;

export function unsupervisedOwnerGraceMs(env = process.env) {
  const value = Number(env.FRONTALIERE_GH_RECLAIM_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : UNSUPERVISED_OWNER_GRACE_MS;
}

// One JSON request/response over the coordinator socket, without the client
// helpers (they may auto-start a daemon).
function coordinatorSocketRequest(socket, request, timeoutMs = 3_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const connection = createConnection(socket);
    let buffer = '';
    const timer = setTimeout(() => {
      connection.destroy();
      rejectPromise(new Error(`coordinator request timed out: ${request.type}`));
    }, timeoutMs);
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      connection.end();
      try {
        resolvePromise(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        rejectPromise(error);
      }
    });
    connection.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

// Twice on 2026-09-24 an agent started `serve` by hand after an ECONNREFUSED,
// the copy took the lock first and launchd was left waiting behind it. The
// supervised standby reclaims such an owner: only an unsupervised `serve` of
// the same identity, only after a grace period (a legitimate manual start has
// time to finish its work) and only while it has no queued or running request.
async function reclaimUnsupervisedOwner({ identity, socket, record, describeOwner, log }) {
  const command = describeOwner(record.pid) || '';
  if (!command.includes('github-coordinator.mjs serve') || !command.includes(`--identity ${identity}`)) {
    return false;
  }
  const status = (await coordinatorSocketRequest(socket, { type: 'status', compact: true }))?.status || {};
  if (Number(status.queueLength || 0) > 0 || Number(status.active || 0) > 0) return false;
  log(`github-coordinator: standby reclaims ${identity} socket from unsupervised pid ${record.pid} (${command})`);
  await coordinatorSocketRequest(socket, { type: 'shutdown' });
  return true;
}

// Under launchd KeepAlive, returning while another live process owns the lock
// exits 0 and is respawned every ThrottleInterval: 4,123 respawns on nanako,
// each one reloading Remote Config, while a copy started outside launchd kept
// the socket. The supervised process waits instead and claims the lock as soon
// as that owner is gone, so the control plane returns to launchd by itself.
export function standbyForCoordinatorOwner({
  identity,
  socket,
  claim = () => claimCoordinatorOwner(identity, socket),
  onClaimed,
  pollMs = SUPERVISED_STANDBY_POLL_MS,
  lockPath = coordinatorOwnerLockPath(identity),
  log = (line) => process.stderr.write(`${line}\n`),
  describeOwner = describeOwnerProcess,
  reclaimGraceMs = null,
  reclaim = reclaimUnsupervisedOwner,
  now = () => Date.now(),
} = {}) {
  let announcedOwner = null;
  let lastClaimError = null;
  let timer = null;
  let reclaimInFlight = false;
  const unsupervisedSince = new Map();
  const considerReclaim = () => {
    if (reclaimGraceMs === null || reclaimInFlight) return;
    let record = null;
    try { record = readOwnerRecord(lockPath); } catch { record = null; }
    if (!record || record.supervised === true) return;
    const key = `${record.pid}:${record.ownerId || ''}`;
    if (!unsupervisedSince.has(key)) unsupervisedSince.set(key, now());
    if (now() - unsupervisedSince.get(key) < reclaimGraceMs) return;
    reclaimInFlight = true;
    Promise.resolve()
      .then(() => reclaim({ identity, socket, record, describeOwner, log }))
      .catch((error) => log(`github-coordinator: standby reclaim failed: ${error?.message || error}`))
      .finally(() => { reclaimInFlight = false; });
  };
  const announce = () => {
    let record = null;
    try { record = readOwnerRecord(lockPath); } catch { record = null; }
    const key = record ? `${record.pid}:${record.ownerId || ''}` : null;
    if (!key || key === announcedOwner) return;
    announcedOwner = key;
    const command = describeOwner(record.pid);
    log(`github-coordinator: standby; ${identity} socket owned by pid ${record.pid}`
      + `${command ? ` (${command})` : ''}; waiting to take over`);
  };
  const tick = () => {
    let ownerLock = null;
    try {
      ownerLock = claim();
      lastClaimError = null;
    } catch (error) {
      const message = error?.message || String(error);
      if (message !== lastClaimError) log(`github-coordinator: standby claim failed: ${message}`);
      lastClaimError = message;
    }
    if (!ownerLock) {
      announce();
      considerReclaim();
      return;
    }
    clearInterval(timer);
    timer = null;
    log(`github-coordinator: standby over; pid ${process.pid} owns the ${identity} socket`);
    onClaimed(ownerLock);
  };
  announce();
  timer = setInterval(tick, pollMs);
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    isWaiting() {
      return timer !== null;
    },
  };
}

function installSourceReloadWatcher(onReload, { getActiveRequests = () => 0 } = {}) {
  let triggered = false;
  let watcher;
  let scheduler;
  const sourceSnapshots = new Map();
  for (const name of WATCHED_SOURCE_NAMES) {
    try {
      sourceSnapshots.set(name, readFileSync(join(THIS_DIR, name)));
    } catch {
      sourceSnapshots.set(name, null);
    }
  }
  const sourceContentChanged = (name) => {
    let current;
    try {
      current = readFileSync(join(THIS_DIR, name));
    } catch {
      current = null;
    }
    const previous = sourceSnapshots.get(name);
    if (current === null || previous === null) return current !== previous;
    return !current.equals(previous);
  };
  const triggerReload = () => {
    if (triggered) return;
    // Editors and atomic writers can emit several directory events for a
    // temporary replacement, including an eventual write-back of identical
    // bytes. Do not take the control plane offline for those metadata-only
    // events. The initial snapshot stays fixed until this process exits, so a
    // real source change remains visible through the debounce window.
    if (![...WATCHED_SOURCE_NAMES].some(sourceContentChanged)) return;
    triggered = true;
    scheduler.stop();
    try { watcher?.close(); } catch { /* watcher already closed */ }
    process.stderr.write('github-coordinator: source quiescent; restarting under supervisor\n');
    onReload();
  };
  scheduler = createDebouncedReloadScheduler({
    onReload: triggerReload,
    getActiveRequests,
  });
  try {
    watcher = watch(THIS_DIR, { persistent: false }, (_eventType, filename) => {
      const name = String(filename || '');
      if (triggered || !WATCHED_SOURCE_NAMES.has(name) || !sourceContentChanged(name)) return;
      if (scheduler.request()) {
        process.stderr.write(
          `github-coordinator: source changed; restart scheduled (debounce=${SOURCE_RELOAD_DEBOUNCE_MS}ms, quiescence=${SOURCE_RELOAD_QUIESCENCE_MS}ms)\n`,
        );
      }
    });
  } catch (error) {
    process.stderr.write(`github-coordinator: source watcher unavailable: ${error.message}\n`);
  }
  return () => {
    scheduler.stop();
    try { watcher?.close(); } catch { /* watcher already closed */ }
  };
}

function installProcessSafetyHandlers(terminate) {
  let handlingFailure = false;
  const handleFailure = (event, error) => {
    logStructuredError(event, error, { pid: process.pid });
    if (handlingFailure) {
      process.exitCode = 1;
      return;
    }
    handlingFailure = true;
    terminate(1);
  };
  process.on('uncaughtException', (error) => handleFailure('uncaught_exception', error));
  process.on('unhandledRejection', (reason) => handleFailure('unhandled_rejection', reason));
}

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const OWNER_CONFIRMATION = Symbol('frontaliere-owner-confirmation');

export function classifyBucket(pathname, method = 'GET') {
  const path = String(pathname || '').split('?')[0];
  if (path === '/graphql' || path === 'graphql') return 'graphql';
  if (/^\/search\/code(?:\/|$)/.test(path)) return 'code_search';
  if (/^\/search(?:\/|$)/.test(path)) return 'search';
  if (String(method).toUpperCase() !== 'GET') return 'core-write';
  return 'core';
}

export function isSafeRead(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

export function retryDelayMilliseconds({ headers = {}, remaining, resetAt, attempt = 1, now = Date.now(), random = Math.random }) {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(24 * 60 * 60 * 1_000, retryAfter * 1_000);

  const remainingValue = remaining ?? headers['x-ratelimit-remaining'];
  const resetSeconds = Number(headers['x-ratelimit-reset'] || resetAt);
  if (String(remainingValue) === '0' && Number.isFinite(resetSeconds)) {
    return Math.max(1_000, resetSeconds * 1_000 - now + 250);
  }

  const base = Math.min(5 * 60 * 1_000, 60 * 1_000 * (2 ** Math.max(0, attempt - 1)));
  return base + Math.floor(Math.max(0, Math.min(1, random())) * 1_000);
}

function spillCliOutput(buffer) {
  const dir = join(tmpdir(), 'frontaliere-gh-cli-output');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${randomUUID()}.out`);
  const fd = openSync(file, 'w', 0o600);
  try {
    writeSync(fd, buffer);
  } finally {
    closeSync(fd);
  }
  return file;
}

function trimOutput(value, maxBytes = MAX_BODY_BYTES) {
  const text = String(value || '');
  return Buffer.byteLength(text, 'utf8') <= maxBytes
    ? text
    : `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`;
}

// Attenzione: `headers.get` rende `null` quando l'header manca e `''` quando
// e' vuoto, e `Number(null) === 0`: senza questo filtro una risposta chunked
// (che non dichiara `content-length`) verrebbe descritta come «0 byte».
function declaredBodyBytes(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Restituisce sempre { body, truncated, bytes }.  `truncated: true` significa
 * che il body e' stato tagliato dal NOSTRO cap: il chiamante non deve
 * consegnarlo come risposta valida, perche' un JSON tagliato a meta' stringa
 * esce da JSON.parse come errore di sintassi e non come errore di trasporto.
 * `bytes` e' la dimensione reale quando GitHub manda `content-length`.
 */
async function readResponseBody(response) {
  const declaredBytes = declaredBodyBytes(response);
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = String((await response.text()) || '');
    const bytes = Buffer.byteLength(text, 'utf8');
    return bytes <= MAX_BODY_BYTES
      ? { body: text, truncated: false, bytes }
      : { body: trimOutput(text), truncated: true, bytes };
  }

  const chunks = [];
  let bytes = 0;
  let buffered = 0;
  let truncated = false;
  let bytesAtLeast = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    const remaining = MAX_BODY_BYTES - buffered;
    if (remaining > 0) {
      const keep = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(keep);
      buffered += keep.length;
    }
    if (bytes > MAX_BODY_BYTES) {
      truncated = true;
      // Oltre il cap non teniamo piu' nulla in memoria, ma continuiamo a
      // contare: senza `content-length` (le risposte chunked di GitHub non lo
      // mandano) questo e' l'unico modo di nominare la dimensione reale
      // nell'errore.  Il tetto evita di drenare un body patologico.
      if (declaredBytes !== null || bytes > TRUNCATION_MEASURE_CEILING) {
        bytesAtLeast = declaredBytes === null;
        break;
      }
    }
  }
  if (truncated) {
    try { await reader.cancel(); } catch { /* best effort */ }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!truncated) return { body, truncated: false, bytes };
  return {
    body: `${body}\n[truncated]`,
    truncated: true,
    bytes: declaredBytes ?? bytes,
    bytesAtLeast,
  };
}

function observedHeaders(headers) {
  const result = {};
  for (const name of OBSERVED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

function bodyLooksRateLimited(body) {
  return /rate limit|secondary rate|abuse detection|api rate limit/i.test(String(body || ''));
}

function responseIsRateLimited(status, headers, body) {
  return status === 429
    || (status === 403 && (
      headers['retry-after'] !== undefined
      || headers['x-ratelimit-remaining'] === '0'
      || bodyLooksRateLimited(body)
    ));
}

function safeCwd(value) {
  if (typeof value !== 'string' || value.length === 0) return process.env.WORKSPACE || process.cwd();
  try {
    return statSync(value).isDirectory() ? value : process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * Prepare the one secret-bearing CLI input that the client protocol may use.
 *
 * The coordinator deliberately does not forward client stdin: doing so would
 * make the queue hang for commands that wait for EOF. `gh secret set` has no
 * native file option, though, so the workspace shim exposes `--body-file` for
 * that command only. The path crosses the local socket; the file contents are
 * read by this daemon and written directly to gh's stdin, never serialized in
 * the request, arguments, logs, or error messages.
 */
function prepareSecretSetInput(args) {
  const bodyFileIndexes = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--body-file') {
      bodyFileIndexes.push({ index, value: args[index + 1] });
      index += 1;
    } else if (args[index].startsWith('--body-file=')) {
      bodyFileIndexes.push({ index, value: args[index].slice('--body-file='.length) });
    }
  }

  if (bodyFileIndexes.length === 0) return { args, stdin: null };
  if (args[0] !== 'secret' || args[1] !== 'set') return { args, stdin: null };
  if (bodyFileIndexes.length > 1) throw new Error('--body-file può essere specificato una sola volta');
  if (args.some((arg) => arg === '--body' || arg.startsWith('--body='))) {
    throw new Error('--body-file e --body non possono essere usati insieme');
  }

  const bodyFile = bodyFileIndexes[0].value;
  if (!bodyFile || bodyFile.startsWith('-') || !bodyFile.startsWith('/')) {
    throw new Error('--body-file richiede un percorso assoluto');
  }
  let fileStat;
  try {
    fileStat = statSync(bodyFile);
  } catch {
    throw new Error('--body-file non leggibile');
  }
  if (!fileStat.isFile()) throw new Error('--body-file deve indicare un file regolare');
  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error('--body-file deve essere accessibile solo dal proprietario (0600 o più restrittivo)');
  }

  const preparedArgs = args.filter((arg, index) => {
    if (index === bodyFileIndexes[0].index) return false;
    if (args[bodyFileIndexes[0].index] === '--body-file' && index === bodyFileIndexes[0].index + 1) return false;
    return true;
  });
  return { args: preparedArgs, stdin: readFileSync(bodyFile) };
}

function resolveRealGh() {
  const explicit = process.env.FRONTALIERE_REAL_GH;
  if (explicit) {
    accessSync(resolve(explicit), fsConstants.X_OK);
    return resolve(explicit);
  }

  const shimDir = resolve(THIS_DIR);
  const preferred = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  for (const candidate of preferred) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the normal PATH fallback.
    }
  }
  const candidates = String(process.env.PATH || '').split(':')
    .filter(Boolean)
    .map((directory) => join(directory, 'gh'))
    .filter((candidate) => resolve(dirname(candidate)) !== shimDir);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error('github_cli_not_found');
}

function tokenFromEnvironment(identity) {
  const candidates = identity === 'nanako'
    ? [process.env.GITHUB_PAT_NANAKO, process.env.FRONTALIERE_GH_TOKEN_NANAKO, process.env.GH_TOKEN]
    : [process.env.FRONTALIERE_GH_TOKEN, process.env.GITHUB_PAT, process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
  return candidates.find((value) => typeof value === 'string' && value.length > 0) || null;
}

// 19-09 20:00: with the machine at load average 72 the keychain read behind
// `gh auth token` exceeded the old 10 s timeout, the daemon exited and launchd
// restarted it in a loop, leaving every agent without the default coordinator
// for minutes. A slow keychain is not a missing token: allow more time and
// retry before giving up.
export const TOKEN_READ_TIMEOUT_MS = 30_000;
export const TOKEN_READ_ATTEMPTS = 3;

export function resolveToken(identity, realGh, {
  exec = execFileSync,
  timeoutMs = TOKEN_READ_TIMEOUT_MS,
  attempts = TOKEN_READ_ATTEMPTS,
} = {}) {
  const fromEnvironment = tokenFromEnvironment(identity);
  if (fromEnvironment) return fromEnvironment;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const token = String(exec(realGh, ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
      })).trim();
      if (token) return token;
    } catch {
      // Report a redacted, actionable error below after the last attempt.
    }
  }
  throw new Error(`github_token_unavailable_for_identity: ${identity}`);
}

function apiUrl(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    throw new Error('invalid_github_api_path');
  }
  return `https://api.github.com${pathname}`;
}

function externalRedirectTarget(response, sourceUrl) {
  if (response.status !== 301 && response.status !== 302) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  let target;
  try {
    target = new URL(location, sourceUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(target.protocol)) return null;
  if (['api.github.com', 'github.com'].includes(target.hostname.toLowerCase())) return null;
  return target.toString();
}

function workflowFilename(value) {
  if (typeof value !== 'string') return null;
  const filename = value.trim().split('/').pop();
  return /\.ya?ml$/i.test(filename) ? filename.toLowerCase() : null;
}

function workflowCatalog(data) {
  const namesByFilename = new Map();
  const idsByName = new Map();
  const names = new Set();
  for (const workflow of Array.isArray(data?.workflows) ? data.workflows : []) {
    const name = typeof workflow?.name === 'string' ? workflow.name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    names.add(key);
    for (const candidate of [workflow.path, workflow.file_name, workflow.filename]) {
      const filename = workflowFilename(candidate);
      if (filename) namesByFilename.set(filename, name);
    }
    if (workflow.id !== null && workflow.id !== undefined && String(workflow.id).trim() !== '') {
      idsByName.set(key, [...(idsByName.get(key) || []), String(workflow.id)]);
    }
  }
  return { namesByFilename, idsByName, names };
}

const EMPTY_WORKFLOW_CATALOG = Object.freeze({ namesByFilename: new Map(), idsByName: new Map(), names: new Set() });

function workflowSelectorForms(value) {
  if (value === null || value === undefined) return [];
  const raw = String(value).trim().toLowerCase();
  if (!raw) return [];
  const forms = new Set([raw]);
  const filename = workflowFilename(raw);
  if (filename) {
    forms.add(filename);
    forms.add(filename.replace(/\.ya?ml$/i, ''));
  } else if (!raw.includes('/') && !raw.includes('.')) {
    forms.add(`${raw}.yml`);
  }
  return [...forms];
}

function workflowSelectorMatchesRun(run, selector) {
  const expected = new Set(workflowSelectorForms(selector));
  if (expected.size === 0) return true;
  const candidates = [
    run?.workflow,
    run?.name,
    run?.workflow_name,
    run?.workflowPath,
    run?.workflow_path,
    run?.path,
    run?.workflowId,
    run?.workflow_id,
  ]
    .flatMap((value) => workflowSelectorForms(value));
  return candidates.some((candidate) => expected.has(candidate));
}

// GitHub serves a run listing filtered by `branch` alone from an index that can
// put months-old runs first: on 28-09 `actions/runs?branch=main` returned June
// runs, and a follow-latest observer waiting for `success` on main received a
// green `tests` run from 24-09 while every run of that day was red. A `created`
// window brings the listing back to recent-first, and the pick below never
// trusts the API order anyway.
const RECONCILE_RUN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1_000;

function reconcileRunsCreatedFilter(subscription, nowMs = Date.now()) {
  const createdAtMs = Date.parse(subscription?.createdAt || '');
  const anchorMs = Number.isFinite(createdAtMs) ? createdAtMs : nowMs;
  return `>=${new Date(anchorMs - RECONCILE_RUN_LOOKBACK_MS).toISOString().slice(0, 10)}`;
}

// The per-workflow endpoint keeps unrelated workflows from crowding the page.
// It takes the file name as written (case-sensitive), so only a selector that
// names a file, or a bare name that the selector forms already read as
// `<name>.yml`, qualifies.
function reconcileWorkflowFile(selector) {
  if (selector === null || selector === undefined) return null;
  const raw = String(selector).trim();
  if (!raw) return null;
  const basename = raw.split('/').pop();
  if (/\.ya?ml$/i.test(basename)) return basename;
  return /^[A-Za-z0-9_-]+$/.test(raw) ? `${raw}.yml` : null;
}

function latestRunFirst(left, right) {
  const delta = Date.parse(right?.created_at || '') - Date.parse(left?.created_at || '');
  if (Number.isFinite(delta) && delta !== 0) return delta;
  return Number(right?.id || 0) - Number(left?.id || 0);
}

// Headers select the representation (`Accept: …raw` vs JSON) and object bodies
// must be serialized: `${body}` collapsed every GraphQL query onto
// "[object Object]".
function cacheKeyFor(request) {
  const body = request.body === undefined || request.body === null
    ? ''
    : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  const headers = request.headers && typeof request.headers === 'object'
    ? Object.entries(request.headers)
      .filter(([name]) => name.toLowerCase() !== 'authorization')
      .map(([name, value]) => `${name.toLowerCase()}:${value}`)
      .sort()
      .join('\n')
    : '';
  return `${request.identity || 'default'}|${request.anonymous ? 'anonymous' : 'authenticated'}|${String(request.method || 'GET').toUpperCase()}|${request.path}|${body}|${headers}`;
}

function scopedCacheKeyFor(request) {
  if (!request.cacheKey) return cacheKeyFor(request);
  return `${request.identity || 'default'}|${request.anonymous ? 'anonymous' : 'authenticated'}|custom:${request.cacheKey}`;
}

function cliCacheKeyFor(request) {
  // An explicit --repo makes the command independent of where it ran, so the same
  // status read issued from different worktrees shares one entry. Without it gh
  // resolves the repo from the working directory, which then stays in the key.
  const repo = repoFromCliArguments(request.args || []);
  return `${request.identity || 'default'}|${request.anonymous ? 'anonymous' : 'authenticated'}|${repo || request.cwd || ''}|${JSON.stringify(request.args || [])}`;
}

function isEmergencyPublicRestPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return /^\/repos\/[^/]+\/[^/]+(?:\/|$)/.test(path)
    || /^\/users\/[^/]+(?:\/|$)/.test(path)
    || /^\/orgs\/[^/]+(?:\/|$)/.test(path);
}

function requestApiDetails(request) {
  if (request?.type === 'api') {
    return { path: request.path, method: request.method };
  }
  if (request?.type === 'exec' && request.args?.[0] === 'api') {
    const parsed = parseGhApiArguments(request.args);
    return parsed ? { path: parsed.path, method: parsed.method } : null;
  }
  return null;
}

function cancellationApiDetails(pathname, method) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (normalizedMethod !== 'POST') return null;
  const path = String(pathname || '').split('?')[0];
  const match = path.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/cancel$/);
  if (!match) return null;
  return {
    kind: 'workflow-run-cancellation',
    repo: `${match[1]}/${match[2]}`,
    runId: match[3],
    target: path,
  };
}

function repoFromCliArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if ((value === '--repo' || value === '-R') && args[index + 1]) return String(args[index + 1]);
    if (value.startsWith('--repo=')) return value.slice('--repo='.length);
  }
  return null;
}

function cancellationFromCliApiArguments(args, inheritedRepo = null) {
  if (args[0] !== 'api') return null;
  let endpoint = null;
  let method = 'GET';
  let repo = inheritedRepo;
  const optionsWithValue = new Set([
    '--cache', '--field', '--header', '--hostname', '--input', '--jq', '--method',
    '--preview', '--raw-field', '--repo', '--template', '-F', '-H', '-f', '-t', '-X',
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === '--method' || value === '-X') {
      method = String(args[index + 1] || '');
      index += 1;
      continue;
    }
    if (value.startsWith('--method=')) {
      method = value.slice('--method='.length);
      continue;
    }
    if (value === '--repo' && args[index + 1]) {
      repo = String(args[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith('--repo=')) {
      repo = value.slice('--repo='.length);
      continue;
    }
    if (optionsWithValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    if (endpoint === null) endpoint = value;
  }
  if (!endpoint) return null;
  let path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (repo && /^\/actions\/runs\/\d+\/cancel$/.test(path)) path = `/repos/${repo}${path}`;
  return cancellationApiDetails(path, method);
}

/**
 * Identify GitHub Actions run cancellations before they reach the queue.
 * This covers both the normal CLI command and the equivalent REST mutation
 * routed through `gh api`/the coordinator protocol.
 */
export function cancellationRequestDetails(request) {
  if (request?.type === 'api') {
    return cancellationApiDetails(request.path, request.method);
  }
  if (request?.type !== 'exec' || !Array.isArray(request.args)) return null;

  const args = request.args.map(String);
  const runCancelIndex = args.findIndex((value, index) => value === 'run' && args[index + 1] === 'cancel');
  if (runCancelIndex >= 0) {
    const runId = args.slice(runCancelIndex + 2).find((value) => /^\d+$/.test(value)) || null;
    return {
      kind: 'workflow-run-cancellation',
      repo: repoFromCliArguments(args),
      runId,
      target: runId ? `actions run ${runId}` : 'Actions run selezionata da gh',
    };
  }

  const apiIndex = args.indexOf('api');
  if (apiIndex >= 0) {
    const apiArgs = args.slice(apiIndex);
    const parsed = parseGhApiArguments(apiArgs);
    return (parsed ? cancellationApiDetails(parsed.path, parsed.method) : null)
      || cancellationFromCliApiArguments(apiArgs, repoFromCliArguments(args));
  }
  return null;
}

function ownerConfirmationPhrase(requestId) {
  return `CONFERMA ${requestId}`;
}

function isEmergencyPublicRead(request) {
  const details = requestApiDetails(request);
  return Boolean(details)
    && isSafeRead(details.method)
    && isEmergencyPublicRestPath(details.path);
}

function cacheResponse(entry, cacheState) {
  return {
    ok: true,
    status: entry.status,
    headers: {
      ...entry.headers,
      'x-frontaliere-cache': cacheState,
    },
    body: entry.body,
    fromCache: true,
  };
}

const UNSUPPORTED_FIELD = Symbol('unsupported gh api field');

// `-F` like gh's magicFieldValue: only `true`/`false`/`null` and integers
// (strconv.Atoi) change type; floats and JSON stay strings. `@file`/`@-` and
// the `{owner}`/`{repo}`/`{branch}` placeholders depend on the caller's cwd
// and stdin, so they go to the real CLI instead of being sent literally.
function fieldValue(raw, typed) {
  if (!typed) return raw;
  if (raw.startsWith('@') || /\{(?:owner|repo|branch)\}/.test(raw)) return UNSUPPORTED_FIELD;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^[+-]?\d+$/.test(raw)) {
    const number = Number(raw);
    // Beyond 2^53 JSON would round the integer gh sends exactly.
    return Number.isSafeInteger(number) ? number : UNSUPPORTED_FIELD;
  }
  return raw;
}

function splitField(raw, typed) {
  const separator = raw.indexOf('=');
  if (separator <= 0) return null;
  const name = raw.slice(0, separator);
  // `key[]=a` / `key[sub]=b` build arrays and objects in gh: real CLI only.
  if (name.includes('[')) return null;
  const value = fieldValue(raw.slice(separator + 1), typed);
  return value === UNSUPPORTED_FIELD ? null : { name, value };
}

/**
 * The payload gh sends to `graphql`: `query` and `operationName` at the top,
 * every other field under `variables` (pkg/cmd/api groupGraphQLVariables).
 */
export function graphqlRequestBody(data) {
  const body = {};
  const variables = {};
  for (const [name, value] of Object.entries(data)) {
    if (name === 'query' || name === 'operationName') body[name] = value;
    else variables[name] = value;
  }
  if (Object.keys(variables).length > 0) body.variables = variables;
  return body;
}

/**
 * The error gh prints as `gh: …` (and exits 1) for a GraphQL response:
 * a top-level `message`, or the messages of `errors` joined by newlines.
 * `null` when the response carries no error.
 */
export function graphqlResponseError(body, status) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.message === 'string' && parsed.message !== '') return `${parsed.message} (HTTP ${status})`;
  if (!Array.isArray(parsed.errors)) return null;
  const messages = parsed.errors
    .map((error) => (typeof error === 'string' ? error : error && typeof error === 'object' ? error.message : null))
    .filter((message) => typeof message === 'string');
  return messages.length > 0 ? messages.join('\n') : null;
}

/**
 * Parse the useful, stable subset of `gh api`.  Unknown options fall back to
 * the real CLI so the shim never silently changes an unsupported command.
 */
export function parseGhApiArguments(args) {
  if (!Array.isArray(args) || args[0] !== 'api') return null;
  let endpoint = null;
  let method = null;
  let jq = null;
  let include = false;
  let silent = false;
  let paginate = false;
  let slurp = false;
  const fields = [];
  const headers = {};

  for (let index = 1; index < args.length; index += 1) {
    const arg = String(args[index]);
    const next = () => {
      if (index + 1 >= args.length) return null;
      index += 1;
      return String(args[index]);
    };
    if (arg === 'graphql' && endpoint === null) {
      endpoint = 'graphql';
    } else if (arg === '--method' || arg === '-X') {
      method = next();
    } else if (arg.startsWith('--method=')) {
      method = arg.slice('--method='.length);
    } else if (arg === '--raw-field' || arg === '-f') {
      const value = next();
      const field = value === null ? null : splitField(value, false);
      if (!field) return null;
      fields.push(field);
    } else if (arg.startsWith('--raw-field=')) {
      const field = splitField(arg.slice('--raw-field='.length), false);
      if (!field) return null;
      fields.push(field);
    } else if (arg === '--field' || arg === '-F') {
      const value = next();
      const field = value === null ? null : splitField(value, true);
      if (!field) return null;
      fields.push(field);
    } else if (arg.startsWith('--field=')) {
      const field = splitField(arg.slice('--field='.length), true);
      if (!field) return null;
      fields.push(field);
    } else if (arg === '--header' || arg === '-H') {
      const value = next();
      const separator = value?.indexOf(':') ?? -1;
      if (separator <= 0) return null;
      headers[value.slice(0, separator).trim().toLowerCase()] = value.slice(separator + 1).trim();
    } else if (arg === '--jq') {
      jq = next();
    } else if (arg === '--include') {
      include = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if (arg === '--paginate') {
      paginate = true;
    } else if (arg === '--slurp') {
      slurp = true;
    } else if (arg === '--repo' || arg === '--hostname' || arg === '--cache') {
      if (next() === null) return null;
    } else if (arg === '--input' || arg === '--template' || arg === '-t' || arg === '--preview') {
      return null;
    } else if (arg.startsWith('-')) {
      return null;
    } else if (endpoint === null) {
      endpoint = arg;
    } else {
      return null;
    }
  }

  if (!endpoint || endpoint.includes('{') || endpoint.includes('}')) return null;
  // The real CLI rejects `--slurp` with `--jq` and `--slurp` without
  // `--paginate`: hand both to it so a local run fails exactly like CI.
  if (slurp && (jq !== null || !paginate)) return null;
  const isGraphql = endpoint === 'graphql';
  const normalizedMethod = String(method || (isGraphql ? 'POST' : fields.length ? 'GET' : 'GET')).toUpperCase();
  let path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const data = Object.fromEntries(fields.map(({ name, value }) => [name, value]));
  let body;
  if (isGraphql) {
    if (normalizedMethod !== 'POST' || typeof data.query !== 'string') return null;
    // gh pages GraphQL through `$endCursor`/`pageInfo`, not Link headers:
    // here only the first page would come back.
    if (paginate) return null;
    body = graphqlRequestBody(data);
    path = '/graphql';
  } else if (isSafeRead(normalizedMethod)) {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(data)) query.set(name, String(value));
    if (query.size > 0) path += `${path.includes('?') ? '&' : '?'}${query.toString()}`;
  } else {
    body = data;
  }
  return {
    path,
    method: normalizedMethod,
    body,
    headers,
    jq,
    include,
    silent,
    paginate,
    slurp,
  };
}

function nextPagePath(linkHeader) {
  const match = String(linkHeader || '').match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function renderJq(body, expression) {
  const result = spawnSync('jq', ['-r', expression], { input: body, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error?.message || result.stderr || 'jq failed' };
  }
  return { ok: true, output: result.stdout };
}

/**
 * Pagine REST JSON array unite in UN array, come il gh reale con `--paginate`
 * senza `--jq`/`--slurp`/`--include` (paginatedArrayReader): verificato su
 * 129 commenti in due pagine, `JSON.parse` dell'output riesce. `null` quando
 * il gh reale non unirebbe (GraphQL, una pagina sola, pagina non array).
 */
function mergedPaginatedArray(bodies, parsed) {
  if (bodies.length < 2 || parsed.include || parsed.path === '/graphql') return null;
  const items = [];
  for (const body of bodies) {
    let value;
    try { value = JSON.parse(body); } catch { return null; }
    if (!Array.isArray(value)) return null;
    items.push(...value);
  }
  return `${JSON.stringify(items)}\n`;
}

export function renderGhApiResponse(pages, parsed) {
  const bodies = pages.map((page) => page.body || '');
  let output;
  if (parsed.jq) {
    // Il gh reale applica `--jq` pagina per pagina anche con `--paginate`
    // (`--jq length` su 129 commenti stampa `100` e `29`).
    const rendered = bodies.map((body) => renderJq(body, parsed.jq));
    const failed = rendered.find((item) => !item.ok);
    if (failed) return failed;
    output = rendered.map((item) => item.output).join('');
  } else if (parsed.slurp) {
    try { output = `${JSON.stringify(bodies.map((body) => JSON.parse(body)))}\n`; }
    catch { return { ok: false, error: 'cannot slurp non-JSON response' }; }
  } else {
    output = mergedPaginatedArray(bodies, parsed)
      ?? bodies.map((body) => (body.endsWith('\n') ? body : `${body}\n`)).join('');
  }

  if (parsed.include && !parsed.silent) {
    const first = pages[0];
    const headerLines = [`HTTP/2 ${first.status}`];
    for (const [name, value] of Object.entries(first.headers || {})) headerLines.push(`${name}: ${value}`);
    output = `${headerLines.join('\n')}\n\n${output}`;
  }
  return { ok: true, output: parsed.silent ? '' : output };
}

export function latencySummary(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { samples: 0, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (percentile) => sorted[Math.min(sorted.length - 1, Math.floor(percentile * sorted.length))];
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function isPastRateLimitReset(observed, now = Date.now()) {
  const reset = observed?.reset;
  if (reset === null || reset === undefined) return false;
  if (typeof reset !== 'number' && (typeof reset !== 'string' || reset.trim() === '')) return false;
  const resetSeconds = Number(reset);
  // GitHub reports reset as epoch seconds while Date.now() returns milliseconds.
  return Number.isFinite(resetSeconds) && resetSeconds * 1_000 < now;
}

export class GitHubCoordinator {
  constructor({ identity, token, realGh, socket, eventBroker = null }) {
    this.identity = normalizeIdentity(identity);
    this.token = token;
    this.realGh = realGh;
    this.socket = socket;
    this.eventBroker = eventBroker;
    this.eventBrokerLoading = false;
    this.eventNotifier = null;
    this.eventListenerInspector = null;
    this.eventListenerCountInspector = null;
    this.eventListenerInfoInspector = null;
    this.queue = [];
    this.active = 0;
    this.activeMutations = 0;
    this.lastMutationAt = 0;
    this.lastMutationStartedAt = 0;
    this.laneActive = Object.fromEntries(LANES.map((lane) => [lane, 0]));
    this.activeByClient = new Map();
    this.secondaryWindow = { rest: [], graphql: [] };
    this.secondaryWindowPoints = { rest: 0, graphql: 0 };
    this.latencySamples = Object.fromEntries(LANES.map((lane) => [lane, { queueWait: [], run: [] }]));
    this.requestKinds = new Map();
    this.wakeAt = 0;
    this.pendingGets = new Map();
    this.pendingCli = new Map();
    this.cache = new Map();
    this.cacheBytes = 0;
    this.cliCache = new Map();
    this.lastCacheSweepAt = Date.now();
    this.invalidationEpoch = 0;
    this.globalInvalidationEpoch = 0;
    this.scopeInvalidationEpoch = new Map();
    this.workflowFilenameCache = new Map();
    this.workflowCatalogRefreshAt = new Map();
    this.bucketPausedUntil = new Map();
    this.buckets = new Map();
    this.pendingCancellations = new Map();
    this.anonymousWindowStartedAt = Date.now();
    this.anonymousUsed = 0;
    this.anonymousPausedUntil = 0;
    this.wakeTimer = null;
    this.metrics = {
      startedAt: new Date().toISOString(),
      requests: 0,
      networkRequests: 0,
      cacheHits: 0,
      cacheRevalidations: 0,
      cliCacheHits: 0,
      rateLimited: 0,
      cliCommands: 0,
      anonymousRequests: 0,
      anonymousFallbacks: 0,
      anonymousRateLimited: 0,
      anonymousBudgetExhausted: 0,
      cancellationRequests: 0,
      cancellationConfirmed: 0,
      cancellationExpired: 0,
      socketConnections: 0,
      socketErrors: 0,
      socketDisconnects: 0,
      socketTimeouts: 0,
      eventListenerHeartbeats: 0,
      eventListenerTimeouts: 0,
      sourceReloads: 0,
      eventSweepReconciliations: 0,
      eventSweepDeliveries: 0,
      eventSweepErrors: 0,
      eventScheduledGcRuns: 0,
      baseMovements: 0,
      mergeabilityChecks: 0,
      mergeabilityRetries: 0,
      mergeabilityConflicts: 0,
      peakQueueLength: 0,
      peakActive: 0,
      cacheEvictions: 0,
      cacheInvalidations: 0,
      cacheScopedInvalidations: 0,
      secondaryLimitDeferrals: 0,
      cliTimeouts: 0,
    };
    this.sweepReconciledAt = new Map();
    this.startedAtMs = Date.now();
    this.listenerSeenAt = new Map();
    this.mergeabilityRecheckDelayMs = MERGEABILITY_RECHECK_DELAY_MS;
    this.mergeabilityRetryDelaysMs = MERGEABILITY_RETRY_DELAYS_MS;
    this.mergeabilityRecheckTimers = new Map();
    this.mergeabilityWork = new Set();
    this.reportedConflicts = new Map();
    this.lastScheduledGc = null;
    this.scheduledGcBootstrapAttempted = false;
    this.scheduledGcBootstrapInProgress = false;
    this.scheduledGcBootstrapTimer = null;
    this.lastScheduledGcLogKey = null;
  }

  eventLivenessStatus() {
    const signatureFailures = Number(this.eventBroker?.metrics?.webhookSignatureFailures || 0);
    const activeListeners = this.eventListenerCountInspector?.() ?? null;
    return {
      enabled: Boolean(this.eventBroker?.webhookSecret),
      loading: this.eventBrokerLoading === true,
      webhookSecretConfigured: Boolean(this.eventBroker?.webhookSecret),
      activeListeners,
      // This is a process-local count, not a subscription scan. Keep the
      // alias for older health consumers while compact status remains a
      // liveness snapshot rather than an event report.
      listenerCount: activeListeners,
      listenerHeartbeatMetrics: {
        heartbeats: this.metrics.eventListenerHeartbeats,
        timeouts: this.metrics.eventListenerTimeouts,
      },
      scheduledGc: scheduledGcView(this.lastScheduledGc, true),
      ...(signatureFailures > 0
        ? {
          webhookSignatureFailures: signatureFailures,
          lastWebhookSignatureFailureAt: this.eventBroker?.metrics?.lastWebhookSignatureFailureAt || null,
        }
        : {}),
    };
  }

  status({ compact = false } = {}) {
    this.resetAnonymousBudget();
    this.prunePendingCancellations();
    if (compact) {
      return {
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        identity: this.identity,
        socket: this.socket,
        queueLength: this.queue.length,
        active: this.active,
        maxInFlight: MAX_IN_FLIGHT,
        effectiveMaxInFlight: this.effectiveMaxInFlight(),
        buckets: Object.fromEntries(this.buckets.entries()),
        pausedUntil: Object.fromEntries(this.bucketPausedUntil.entries()),
        metrics: { ...this.metrics },
        scheduler: this.schedulerStatus(),
        cacheEntries: this.cache.size,
        cacheBytes: this.cacheBytes,
        cliCacheEntries: this.cliCache.size,
        // Compact status is deliberately liveness-only. Event counts and
        // subscription details belong to the explicit events-summary/status
        // RPCs; neither this path nor the socket preflight scans the backlog.
        events: this.eventLivenessStatus(),
        pendingCancellations: this.pendingCancellations.size,
        anonymous: {
          budget: ANONYMOUS_BUDGET,
          used: this.anonymousUsed,
          remaining: Math.max(0, ANONYMOUS_BUDGET - this.anonymousUsed),
          windowStartedAt: this.anonymousWindowStartedAt,
          windowResetAt: this.anonymousWindowStartedAt + ANONYMOUS_WINDOW_MS,
          pausedUntil: this.anonymousPausedUntil,
        },
      };
    }
    return {
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      identity: this.identity,
      socket: this.socket,
      queueLength: this.queue.length,
      active: this.active,
      maxInFlight: MAX_IN_FLIGHT,
      effectiveMaxInFlight: this.effectiveMaxInFlight(),
      buckets: Object.fromEntries(this.buckets.entries()),
      pausedUntil: Object.fromEntries(this.bucketPausedUntil.entries()),
      metrics: { ...this.metrics },
      scheduler: this.schedulerStatus({ detailed: true }),
      cacheEntries: this.cache.size,
      cacheBytes: this.cacheBytes,
      cliCacheEntries: this.cliCache.size,
      events: this.eventBroker
        ? {
          enabled: Boolean(this.eventBroker.webhookSecret),
          webhookSecretConfigured: Boolean(this.eventBroker.webhookSecret),
          listenerHeartbeatMetrics: {
            heartbeats: this.metrics.eventListenerHeartbeats,
            timeouts: this.metrics.eventListenerTimeouts,
          },
          ...this.eventBroker.status({
            listenerAttached: this.eventListenerInspector,
            listenerInfo: this.eventListenerInfoInspector,
          }),
          webhookSignatureFailures: Number(this.eventBroker.metrics.webhookSignatureFailures || 0),
          lastWebhookSignatureFailureAt: this.eventBroker.metrics.lastWebhookSignatureFailureAt,
          scheduledGc: this.lastScheduledGc,
        }
        : {
          enabled: false,
          loading: this.eventBrokerLoading === true,
        },
      pendingCancellations: [...this.pendingCancellations.values()]
        .map((pending) => this.publicCancellationDetails(pending)),
      anonymous: {
        budget: ANONYMOUS_BUDGET,
        used: this.anonymousUsed,
        remaining: Math.max(0, ANONYMOUS_BUDGET - this.anonymousUsed),
        windowStartedAt: this.anonymousWindowStartedAt,
        windowResetAt: this.anonymousWindowStartedAt + ANONYMOUS_WINDOW_MS,
        pausedUntil: this.anonymousPausedUntil,
      },
    };
  }

  /**
   * Cheap liveness/protocol probe used before every client request.
   *
   * A ping must not inspect the durable event broker: every `gh` invocation
   * performs one, and serializing hundreds of persisted subscriptions made a
   * reconnect storm monopolize the event loop while listeners were restoring.
   * Detailed event state remains available through the explicit `status`
   * request.
   */
  ping() {
    return {
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      identity: this.identity,
      socket: this.socket,
      metrics: { startedAt: this.metrics.startedAt },
      events: {
        enabled: Boolean(this.eventBroker),
        loading: this.eventBrokerLoading === true,
        webhookSecretConfigured: Boolean(this.eventBroker?.webhookSecret),
      },
    };
  }

  resetAnonymousBudget() {
    if (Date.now() >= this.anonymousWindowStartedAt + ANONYMOUS_WINDOW_MS) {
      this.anonymousWindowStartedAt = Date.now();
      this.anonymousUsed = 0;
    }
  }

  anonymousBudgetAvailable() {
    this.resetAnonymousBudget();
    return this.anonymousUsed < ANONYMOUS_BUDGET && Date.now() >= this.anonymousPausedUntil;
  }

  reserveAnonymousRequest() {
    if (!this.anonymousBudgetAvailable()) return false;
    this.anonymousUsed += 1;
    return true;
  }

  effectiveMaxInFlight() {
    let effective = MAX_IN_FLIGHT;
    const now = Date.now();
    for (const [bucket, observed] of this.buckets.entries()) {
      if (bucket.endsWith('-anonymous')) continue;
      const remaining = Number(observed.remaining);
      if (!Number.isFinite(remaining)) continue;
      if (remaining <= 0) {
        if (isPastRateLimitReset(observed, now)) continue;
        return 1;
      }

      const limit = Number(observed.limit);
      if (!Number.isFinite(limit) || limit <= 0) continue;
      const ratio = remaining / limit;
      for (const step of HEADROOM_CONCURRENCY_STEPS) {
        if (ratio <= step.ratio) effective = Math.min(effective, step.max);
      }
    }
    return Math.max(1, effective);
  }

  shouldRouteEmergencyAnonymous(request) {
    if (request?.anonymous || !isEmergencyPublicRead(request)) return false;
    const details = requestApiDetails(request);
    const bucket = request.bucket || classifyBucket(details.path, details.method);
    const observed = this.buckets.get(bucket);
    return observed?.remaining === '0'
      && !isPastRateLimitReset(observed)
      && this.anonymousBudgetAvailable();
  }

  setEventNotifier(notifier) {
    this.eventNotifier = typeof notifier === 'function' ? notifier : null;
  }

  setEventListenerInspector(inspector) {
    this.eventListenerInspector = typeof inspector === 'function' ? inspector : null;
  }

  ensureScheduledEventGarbageCollection() {
    if (!this.eventBroker
      || !this.eventListenerInspector
      || this.lastScheduledGc
      || this.scheduledGcBootstrapAttempted
      || this.scheduledGcBootstrapInProgress) return;
    this.scheduledGcBootstrapAttempted = true;
    this.scheduledGcBootstrapInProgress = true;
    // This is a local, dry-run inspection only. It is deliberately scheduled
    // after the server has started listening and performs bounded batches with
    // setImmediate between them. In particular, status/ping never enters this
    // path and a large persisted backlog cannot monopolize the socket loop.
    const runBootstrap = () => {
      this.scheduledGcBootstrapTimer = null;
      this.scheduledEventGarbageCollectionAsync()
        .catch((error) => logStructuredError('event_initial_gc_failed', error))
        .finally(() => {
          this.scheduledGcBootstrapInProgress = false;
        });
    };
    this.scheduledGcBootstrapTimer = setImmediate(runBootstrap);
    this.scheduledGcBootstrapTimer.unref?.();
  }

  // A pending event with a live listener is being drained through the control
  // plane, and the recovery sweep must not compete with it. Pending events of
  // an orphaned subscription wait for a listener that may never come back:
  // counting them kept the sweep disabled for every subscription as long as
  // one dead session had left an unacknowledged event behind.
  pendingBacklogNeedsControlPlane() {
    if (!this.eventBroker) return false;
    return this.eventBroker.state.subscriptions.some((subscription) => (
      (subscription.pending?.length || 0) > 0
      && this.eventListenerInspector?.(subscription.id) !== false
    ));
  }

  setEventListenerCountInspector(inspector) {
    this.eventListenerCountInspector = typeof inspector === 'function' ? inspector : null;
  }

  setEventListenerInfoInspector(inspector) {
    this.eventListenerInfoInspector = typeof inspector === 'function' ? inspector : null;
  }

  async fetchWorkflowCatalog(repo) {
    const workflows = [];
    let path = `/repos/${repo}/actions/workflows?per_page=100`;
    for (let page = 0; page < MAX_PAGINATED_API_PAGES; page += 1) {
      const response = await this.submit({
        type: 'api',
        identity: this.identity,
        client: EVENT_CLIENT_KEY,
        method: 'GET',
        path,
        cacheTtlMs: 0,
      });
      if (!response.ok) throw new Error('workflow_catalog_request_failed');
      const data = JSON.parse(response.body || 'null');
      if (!Array.isArray(data?.workflows)) throw new Error('workflow_catalog_invalid');
      workflows.push(...data.workflows);
      const next = nextPagePath(response.headers?.link);
      if (!next) return workflowCatalog({ workflows });
      path = next;
    }
    throw new Error('workflow_catalog_pagination_limit');
  }

  workflowCatalog(repo, { force = false } = {}) {
    const cached = this.workflowFilenameCache.get(repo);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.promise;
    if (cached) this.workflowFilenameCache.delete(repo);

    const entry = { promise: null, expiresAt: Number.POSITIVE_INFINITY };
    const promise = this.fetchWorkflowCatalog(repo).then(
      (catalog) => {
        if (this.workflowFilenameCache.get(repo) === entry) {
          entry.expiresAt = Date.now() + WORKFLOW_CATALOG_CACHE_TTL_MS;
        }
        return catalog;
      },
      () => {
        if (this.workflowFilenameCache.get(repo) === entry) this.workflowFilenameCache.delete(repo);
        return EMPTY_WORKFLOW_CATALOG;
      },
    );
    entry.promise = promise;
    this.workflowFilenameCache.set(repo, entry);
    return promise;
  }

  async resolveWorkflowFilename(repo, workflow) {
    const filename = workflowFilename(workflow);
    if (!filename || typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return workflow;
    const { namesByFilename } = await this.workflowCatalog(repo);
    return namesByFilename.get(filename) || workflow;
  }

  // The id behind a workflow name. REST runs carry the run title in `name`,
  // so a reconciliation for a name selector has to find the runs through the
  // workflow itself; only an unambiguous name qualifies.
  async resolveWorkflowNameId(repo, workflow) {
    const name = typeof workflow === 'string' ? workflow.trim().toLowerCase() : '';
    if (!name || workflowFilename(name) || typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
    let catalog = await this.workflowCatalog(repo);
    let ids = catalog.idsByName.get(name) || [];
    if (ids.length === 0 && !catalog.names.has(name)) {
      const now = Date.now();
      const refreshedAt = this.workflowCatalogRefreshAt.get(repo);
      if (refreshedAt === undefined || now >= refreshedAt + WORKFLOW_CATALOG_REFRESH_COOLDOWN_MS) {
        this.workflowCatalogRefreshAt.set(repo, now);
        catalog = await this.workflowCatalog(repo, { force: true });
        ids = catalog.idsByName.get(name) || [];
      }
    }
    return ids.length === 1 ? ids[0] : null;
  }

  async eventSubscription(spec) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    if (eventRoutingRequired(this.identity, spec)) {
      assertEventIdentity({ spec, actualIdentity: this.identity, operation: 'subscribe' });
    }
    if (!this.eventBroker.webhookSecret) {
      const error = new Error('event subscriptions require a configured webhook secret');
      error.code = 'event_webhook_secret_unconfigured';
      throw error;
    }
    const resource = String(spec?.resource || '').trim().toLowerCase().replace(/-/g, '_');
    const workflow = resource === 'workflow_run' || resource === 'workflow' || resource === 'ci'
      ? await this.resolveWorkflowFilename(spec?.repo, spec?.workflow)
      : spec?.workflow;
    const normalizedSpec = workflow === spec?.workflow ? spec : { ...spec, workflow };
    // Only a known absence counts: without a listener inspector (library use)
    // joins behave as before.
    const unattended = (subscriptionId) => this.eventListenerInspector?.(subscriptionId) === false;
    const createdSubscription = this.eventBroker.subscribe(normalizedSpec, {
      // Pending events of an unattended record were meant for sessions that
      // are gone; the joining agent gets its own observer and reconciliation.
      canJoin: (existing) => existing.pending.length === 0 || !unattended(existing.id),
    });
    let reconciliation = null;
    // A join onto an unattended record has nobody who saw its past webhooks:
    // reconcile it like a new subscription.
    const needsReconciliation = !createdSubscription.sharedJoin || unattended(createdSubscription.id);
    if (needsReconciliation && createdSubscription.remainingMs > 1_000) {
      try {
        reconciliation = await this.reconcileEvents(createdSubscription.id);
        this.sweepReconciledAt.set(createdSubscription.id, Date.now());
      } catch (error) {
        reconciliation = {
          ok: false,
          source: 'reconciliation',
          error: {
            code: error.code || 'event_reconcile_failed',
            message: error.message,
          },
        };
      }
    }
    const record = this.eventBroker.getSubscriptionRecord(createdSubscription.id);
    return {
      ok: true,
      subscription: record
        ? this.eventBroker.publicSubscription(record, {
          listenerAttached: this.eventListenerInspector?.(record.id) ?? null,
          listenerInfo: this.eventListenerInfoInspector?.(record.id) ?? [],
          sharedJoin: createdSubscription.sharedJoin === true,
        })
        : createdSubscription,
      ...(reconciliation ? { reconciliation } : {}),
    };
  }

  eventSubscriptions(options = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    return {
      ok: true,
      webhookSecretConfigured: Boolean(this.eventBroker.webhookSecret),
      activeListeners: this.eventListenerCountInspector?.() ?? null,
      listenerHeartbeatMetrics: {
        heartbeats: this.metrics.eventListenerHeartbeats,
        timeouts: this.metrics.eventListenerTimeouts,
      },
      ...this.eventBroker.status({
        ...options,
        listenerAttached: this.eventListenerInspector,
        listenerInfo: this.eventListenerInfoInspector,
      }),
    };
  }

  eventSubscriptionSummary(options = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    return {
      ok: true,
      webhookSecretConfigured: Boolean(this.eventBroker.webhookSecret),
      activeListeners: this.eventListenerCountInspector?.() ?? null,
      listenerHeartbeatMetrics: {
        heartbeats: this.metrics.eventListenerHeartbeats,
        timeouts: this.metrics.eventListenerTimeouts,
      },
      ...this.eventBroker.summary({
        ...options,
        compact: options.compact !== false,
        includePendingDetails: options.includePendingDetails === true,
        listenerAttached: this.eventListenerInspector,
        listenerInfo: this.eventListenerInfoInspector,
      }),
    };
  }

  eventGarbageCollect(options = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    return {
      ok: true,
      webhookSecretConfigured: Boolean(this.eventBroker.webhookSecret),
      ...this.eventBroker.garbageCollect({
        ...options,
        listenerAttached: this.eventListenerInspector,
      }),
    };
  }

  eventUnsubscribe(subscriptionId, { agentId = null } = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    const result = this.eventBroker.unsubscribe(subscriptionId, { agentId });
    if (result.removed) this.eventNotifier?.(String(subscriptionId), { removed: true });
    return result;
  }

  eventSubscriptionDetails(subscriptionId) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    const subscription = this.eventBroker.getSubscriptionRecord(subscriptionId);
    if (!subscription) {
      const retired = this.eventBroker.retiredSubscription?.(subscriptionId);
      return {
        ok: false,
        error: retired
          ? {
            code: 'event_subscription_not_found',
            message: `event subscription archived at ${retired.retiredAt} (${retired.retiredReason}); `
              + '`events listen` on this id restores it with its pending events',
            nextAction: 'listen_to_revive',
          }
          : { code: 'event_subscription_not_found', message: 'event subscription not found' },
      };
    }
    return {
      ok: true,
      subscription: this.eventBroker.publicSubscription(subscription, {
        listenerAttached: this.eventListenerInspector?.(subscription.id) ?? null,
        listenerInfo: this.eventListenerInfoInspector?.(subscription.id) ?? [],
      }),
      recentEvents: this.eventBroker.audit({
        repo: subscription.repo,
        resource: subscription.resource,
        number: subscription.number,
        runId: subscription.runId,
        sha: subscription.sha,
        branch: subscription.branch,
        workflow: subscription.workflow,
        environment: subscription.environment,
        deploymentId: subscription.deploymentId,
        limit: 10,
      }).events,
    };
  }

  eventAudit(options = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    return {
      ok: true,
      webhookSecretConfigured: Boolean(this.eventBroker.webhookSecret),
      ...this.eventBroker.audit(options),
    };
  }

  eventSubscriptionTarget(options = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    return {
      ok: true,
      ...this.eventBroker.status({
        ...options,
        listenerAttached: this.eventListenerInspector,
        listenerInfo: this.eventListenerInfoInspector,
      }),
    };
  }

  ingestWebhook(request) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    let verifiedPayload = null;
    const result = this.eventBroker.ingestWebhook(request, {
      beforePersist: (payload) => {
        const spec = { repo: payload?.repository?.full_name };
        if (eventRoutingRequired(this.identity, spec)) {
          assertEventIdentity({ spec, actualIdentity: this.identity, operation: 'webhook' });
        }
        verifiedPayload = payload;
      },
    });
    for (const subscriptionId of result.matchedSubscriptionIds || []) {
      this.eventNotifier?.(subscriptionId);
    }
    if (!result.duplicate) {
      const movement = baseBranchMovement(request.eventName, verifiedPayload);
      if (movement) this.scheduleMergeabilityRecheck(movement);
    }
    return result;
  }

  // Debounced per repo and branch: a merge produces a pull_request webhook
  // and several workflow runs within seconds, and GitHub needs a moment to
  // start recomputing mergeability anyway.
  scheduleMergeabilityRecheck({ repo, branch, excludeNumber = null }) {
    this.metrics.baseMovements += 1;
    const key = `${repo}|${branch}`;
    const previous = this.mergeabilityRecheckTimers.get(key);
    if (previous) clearTimeout(previous.timer);
    const excluded = new Set([...(previous?.excluded || []), ...(excludeNumber ? [Number(excludeNumber)] : [])]);
    const timer = setTimeout(() => {
      this.mergeabilityRecheckTimers.delete(key);
      this.trackMergeabilityWork(this.recheckMergeability({ repo, branch, excluded })
        .catch((error) => logStructuredError('event_mergeability_recheck_failed', error, { repo, branch })));
    }, this.mergeabilityRecheckDelayMs);
    timer.unref?.();
    this.mergeabilityRecheckTimers.set(key, { timer, excluded });
  }

  trackMergeabilityWork(promise) {
    this.mergeabilityWork.add(promise);
    promise.finally(() => this.mergeabilityWork.delete(promise)).catch(() => {});
    return promise;
  }

  /** Resolves once no recheck is scheduled, running or waiting to retry. */
  async mergeabilityRecheckIdle() {
    while (this.mergeabilityRecheckTimers.size > 0 || this.mergeabilityWork.size > 0) {
      await Promise.allSettled([...this.mergeabilityWork]);
      if (this.mergeabilityWork.size === 0 && this.mergeabilityRecheckTimers.size > 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
  }

  /**
   * Re-read every followed open PR of `repo` (one GET per PR number, however
   * many observers) and record a `conflict` for those whose base moved under
   * them. Observers known to be orphaned are skipped.
   */
  async recheckMergeability({ repo, branch, excluded = new Set() }) {
    if (!this.eventBroker) return [];
    const nowMs = Date.now();
    const numbers = new Set();
    for (const subscription of this.eventBroker.state.subscriptions) {
      if (subscription.repo !== repo || subscription.resource !== 'pull_request') continue;
      if (subscription.number === null || subscription.number === undefined) continue;
      if (excluded.has(Number(subscription.number)) || subscription.expiresAtMs <= nowMs) continue;
      if (this.eventListenerInspector?.(subscription.id) === false) continue;
      if (eventRoutingRequired(this.identity, subscription) && !routeAllowsIdentity(subscription, this.identity)) continue;
      numbers.add(Number(subscription.number));
      if (numbers.size >= MERGEABILITY_RECHECK_MAX_PULL_REQUESTS) break;
    }
    return Promise.all([...numbers].map((number) => this.checkPullRequestMergeability({ repo, number, branch })));
  }

  async checkPullRequestMergeability({ repo, number, branch = null, attempt = 0 }) {
    this.metrics.mergeabilityChecks += 1;
    const response = await this.submit({
      type: 'api',
      identity: this.identity,
      client: EVENT_CLIENT_KEY,
      method: 'GET',
      path: `/repos/${repo}/pulls/${number}`,
      cacheTtlMs: 0,
    });
    if (!response.ok) return { number, ok: false, status: response.status };
    let data;
    try { data = JSON.parse(response.body || 'null'); } catch { return { number, ok: false }; }
    if (!data || data.state !== 'open') return { number, ok: true, open: false };
    if (branch && data.base?.ref && data.base.ref !== branch) return { number, ok: true, otherBase: true };
    const { conflict, mergeable } = pullRequestMergeability(data);
    if (!conflict && mergeable === null && attempt < this.mergeabilityRetryDelaysMs.length) {
      this.metrics.mergeabilityRetries += 1;
      const retry = new Promise((resolvePromise) => {
        const timer = setTimeout(resolvePromise, this.mergeabilityRetryDelaysMs[attempt]);
        timer.unref?.();
      }).then(() => this.checkPullRequestMergeability({ repo, number, branch, attempt: attempt + 1 }));
      this.trackMergeabilityWork(retry.catch(() => {}));
      return { number, ok: true, retrying: true };
    }
    const prKey = `${repo}#${number}`;
    if (!conflict) {
      this.reportedConflicts.delete(prKey);
      return { number, ok: true, conflict: false };
    }
    const headSha = data.head?.sha || 'head';
    if (this.reportedConflicts.get(prKey) === headSha) return { number, ok: true, conflict: true, alreadyReported: true };
    const recorded = [];
    for (const subscription of this.eventBroker.state.subscriptions) {
      if (subscription.repo !== repo || subscription.resource !== 'pull_request') continue;
      if (Number(subscription.number) !== Number(number)) continue;
      const event = normalizeReconciliationEvent({ subscription, data });
      if (!event) continue;
      // One conflict per head: a later base move re-reports it only after the
      // agent pushed a new head that still conflicts.
      event.id = `conflict:${prKey}:${headSha}`;
      event.deliveryId = event.id;
      const result = this.eventBroker.recordEvent(event);
      for (const matchedSubscriptionId of result.matchedSubscriptionIds || []) {
        this.eventNotifier?.(matchedSubscriptionId);
      }
      recorded.push(...(result.matchedSubscriptionIds || []));
      // recordEvent fans the event out to every observer of the PR.
      break;
    }
    if (recorded.length > 0) this.metrics.mergeabilityConflicts += 1;
    this.reportedConflicts.delete(prKey);
    this.reportedConflicts.set(prKey, headSha);
    if (this.reportedConflicts.size > 1_000) this.reportedConflicts.delete(this.reportedConflicts.keys().next().value);
    return { number, ok: true, conflict: true, matchedSubscriptionIds: recorded };
  }

  eventPending(subscriptionId) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    const subscription = this.eventBroker.getSubscriptionRecord(subscriptionId);
    if (!subscription) {
      return {
        ok: false,
        error: { code: 'event_subscription_not_found', message: 'event subscription not found' },
      };
    }
    return { ok: true, event: this.eventBroker.pendingEvent(subscriptionId) };
  }

  acknowledgeEvent(subscriptionId, eventId) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    const subscription = this.eventBroker.getSubscriptionRecord(subscriptionId);
    return this.eventBroker.acknowledge(subscriptionId, eventId, {
      deferOnceRemoval: subscription?.shared === true,
    });
  }

  renewEventSubscription(subscriptionId, options = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    return this.eventBroker.renew(subscriptionId, options);
  }

  heartbeatEventListener(subscriptionId, options = {}) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    if (options.renew === false) {
      const subscription = this.eventBroker.getSubscriptionRecord(subscriptionId);
      if (!subscription) {
        return {
          ok: false,
          error: { code: 'event_subscription_not_found', message: 'event subscription not found' },
        };
      }
      return {
        ok: true,
        subscription: this.eventBroker.publicSubscription(subscription, { nowMs: Date.now() }),
      };
    }
    const subscription = this.eventBroker.getSubscriptionRecord(subscriptionId);
    if (!subscription) {
      return {
        ok: false,
        error: { code: 'event_subscription_not_found', message: 'event subscription not found' },
      };
    }
    const leaseMs = Number(options.ttlMs ?? options.leaseMs ?? 6 * 60 * 60 * 1_000);
    const renewThresholdMs = Math.max(60_000, Number.isFinite(leaseMs) ? leaseMs / 3 : 2 * 60 * 60 * 1_000);
    if (subscription.expiresAtMs - Date.now() <= renewThresholdMs) {
      return this.eventBroker.renew(subscriptionId, {
        ...options,
        ttlMs: Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : undefined,
      });
    }
    return {
      ok: true,
      renewed: false,
      subscription: this.eventBroker.publicSubscription(subscription, { nowMs: Date.now() }),
    };
  }

  noteListenerActivity(subscriptionId, nowMs = Date.now()) {
    this.listenerSeenAt.set(String(subscriptionId), nowMs);
  }

  // Why an unattended subscription should be archived now, or null.
  // The quiet period is measured on durable timestamps and on listener
  // activity seen by this process, not on the process start: the start-up
  // grace already lets live listeners reconnect, and counting from the start
  // meant every deploy (several a day) postponed the archive by another hour.
  // A late listener loses nothing: `events listen` revives the archive.
  orphanRetirementReason(subscription, nowMs) {
    const createdAtMs = Date.parse(subscription.createdAt || '');
    const renewedAtMs = Date.parse(subscription.lastRenewedAt || '');
    const quietSinceMs = Math.max(
      this.listenerSeenAt.get(subscription.id) || 0,
      Number.isFinite(createdAtMs) ? createdAtMs : 0,
      Number.isFinite(renewedAtMs) ? renewedAtMs : 0,
    );
    if (subscription.pending.length > 0) {
      if (subscription.expiresAtMs <= nowMs && nowMs - quietSinceMs >= ORPHAN_RETIRE_STARTUP_GRACE_MS) {
        return 'expired_without_listener';
      }
      const pendingAtMs = Date.parse(subscription.pending[0]?.receivedAt || '');
      const since = Math.max(quietSinceMs, Number.isFinite(pendingAtMs) ? pendingAtMs : 0);
      return nowMs - since >= ORPHAN_PENDING_RETIRE_MS ? 'pending_without_listener' : null;
    }
    // Waiting observers are archived only when a revival can reconcile what
    // they missed; the others keep waiting until their own expiry.
    if (!reconcilableSubscription(subscription)) return null;
    return nowMs - quietSinceMs >= ORPHAN_IDLE_RETIRE_MS ? 'listener_absent' : null;
  }

  /**
   * Archive subscriptions nobody listens to: the pending events of a dead
   * session (130 of them, 8 days old, measured on 2026-09-28) and observers
   * idle for hours. Lossless by construction: `events listen` revives them.
   */
  retireOrphanedSubscriptions({ nowMs = Date.now() } = {}) {
    if (!this.eventBroker || !this.eventListenerInspector) return [];
    if (nowMs - this.startedAtMs < ORPHAN_RETIRE_STARTUP_GRACE_MS) return [];
    const retirements = [];
    for (const subscription of this.eventBroker.state.subscriptions) {
      if (this.eventListenerInspector(subscription.id) !== false) continue;
      const reason = this.orphanRetirementReason(subscription, nowMs);
      if (reason) retirements.push({ id: subscription.id, reason });
    }
    const retired = this.eventBroker.retireSubscriptions(retirements);
    for (const id of retired) {
      this.listenerSeenAt.delete(id);
      this.sweepReconciledAt.delete(id);
    }
    return retired;
  }

  /** Restore an archived subscription for a listener that came back. */
  async reviveRetiredSubscription(subscriptionId) {
    if (!this.eventBroker?.reviveSubscription) return null;
    const revived = this.eventBroker.reviveSubscription(subscriptionId);
    if (!revived) return null;
    this.noteListenerActivity(revived.id);
    // With nothing pending the archive may have missed webhooks meanwhile.
    if (revived.pending.length === 0 && reconcilableSubscription(revived)) {
      this.sweepReconciledAt.set(revived.id, Date.now());
      this.reconcileEvents(revived.id)
        .catch((error) => logStructuredError('event_revival_reconcile_failed', error, { subscriptionId: revived.id }));
    }
    return revived;
  }

  expireEventSubscriptions() {
    if (!this.eventBroker) return [];
    const expiredIds = this.eventBroker.expireSubscriptions();
    for (const subscriptionId of expiredIds) {
      this.eventNotifier?.(subscriptionId, { expired: true });
    }
    // Orphan cleanup is an explicit operator action (`events gc --apply`),
    // never a one-second background side effect.  Applying GC while the
    // control plane is degraded can delete an orphan subscription before its
    // listener is reattached and makes the expiry timer compete with RPCs.
    return expiredIds;
  }

  // Webhook deliveries are lost whenever the tunnel or a receiver is down
  // (GitHub answers 502/530 and never retries), and a restart of this daemon
  // loses whatever arrived meanwhile. Without a server-side sweep an observer
  // then waits until its TTL for a PR merged hours earlier. The sweep re-reads
  // each targeted subscription at most once per interval; on startup the map is
  // empty, so every persisted subscription is caught up first.
  async reconcileStaleSubscriptions({
    nowMs = Date.now(),
    minIntervalMs = EVENT_SWEEP_MIN_INTERVAL_MS,
    maxPerSweep = EVENT_SWEEP_MAX_PER_RUN,
  } = {}) {
    if (!this.eventBroker) return { ok: false, reconciled: [] };
    const liveIds = new Set(this.eventBroker.state.subscriptions.map(({ id }) => id));
    for (const id of this.sweepReconciledAt.keys()) {
      if (!liveIds.has(id)) this.sweepReconciledAt.delete(id);
    }
    // Live observers first: somebody is waiting on them. An observer without
    // a listener is revisited EVENT_SWEEP_ORPHAN_INTERVAL_FACTOR times less
    // often; without a listener inspector every observer counts as live.
    const orphaned = (subscription) => this.eventListenerInspector?.(subscription.id) === false;
    const due = [...this.eventBroker.state.subscriptions]
      .filter((subscription) => subscription
        && subscription.pending.length === 0
        && reconcilableSubscription(subscription)
        && (!eventRoutingRequired(this.identity, subscription) || routeAllowsIdentity(subscription, this.identity))
        && nowMs - (this.sweepReconciledAt.get(subscription.id) ?? 0)
          >= minIntervalMs * (orphaned(subscription) ? EVENT_SWEEP_ORPHAN_INTERVAL_FACTOR : 1))
      .sort((left, right) => (Number(orphaned(left)) - Number(orphaned(right)))
        || (this.sweepReconciledAt.get(left.id) ?? 0) - (this.sweepReconciledAt.get(right.id) ?? 0))
      .slice(0, maxPerSweep);
    const reconciled = [];
    for (const subscription of due) {
      this.sweepReconciledAt.set(subscription.id, nowMs);
      this.metrics.eventSweepReconciliations += 1;
      try {
        const result = await this.reconcileEvents(subscription.id);
        const delivered = (result?.matchedSubscriptionIds || []).length;
        this.metrics.eventSweepDeliveries += delivered;
        reconciled.push({ id: subscription.id, ok: result?.ok !== false, delivered });
      } catch (error) {
        this.metrics.eventSweepErrors += 1;
        reconciled.push({ id: subscription.id, ok: false, error: error.code || error.message });
      }
    }
    return { ok: true, reconciled };
  }

  recordScheduledEventGarbageCollection({
    nowMs,
    olderThanMs,
    candidateIds,
    orphanedWithPending,
  }) {
    const orphanedWithPendingEventCount = orphanedWithPending.reduce(
      (total, subscription) => total + Number(subscription.pendingCount || 1),
      0,
    );
    this.metrics.eventScheduledGcRuns += 1;
    this.lastScheduledGc = {
      at: new Date(nowMs).toISOString(),
      olderThanMs,
      orphanCandidateCount: candidateIds.length,
      orphanCandidateIds: candidateIds,
      orphanedWithPending,
      orphanedWithPendingSubscriptionCount: orphanedWithPending.length,
      orphanedWithPendingEventCount,
      orphanedWithPendingOldestAt: orphanedWithPending
        .map(({ pendingSince }) => pendingSince)
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null,
      nextAction: 'reattach_or_explicit_ack',
    };
    const logKey = JSON.stringify({
      orphanCandidateCount: candidateIds.length,
      orphanedWithPendingSubscriptionCount: orphanedWithPending.length,
      orphanedWithPendingEventCount,
      orphanedWithPendingOldestAt: this.lastScheduledGc.orphanedWithPendingOldestAt,
    });
    if (candidateIds.length > 0 || orphanedWithPending.length > 0) {
      if (logKey === this.lastScheduledGcLogKey) return this.lastScheduledGc;
      this.lastScheduledGcLogKey = logKey;
      logStructuredError('event_gc_orphans_detected', new Error('orphaned event subscriptions'), {
        identity: this.identity,
        orphanCandidateCount: candidateIds.length,
        orphanedWithPendingSubscriptionCount: orphanedWithPending.length,
        orphanedWithPendingEventCount,
        orphanedWithPendingOldestAt: this.lastScheduledGc.orphanedWithPendingOldestAt,
        nextAction: 'reattach_or_explicit_ack',
      });
    } else {
      this.lastScheduledGcLogKey = null;
    }
    return this.lastScheduledGc;
  }

  // Background inspection never calls broker.garbageCollect(): that method is
  // an explicit operator API and may prune when --apply is requested. Read
  // the in-memory snapshot in bounded turns so a large backlog yields to RPCs.
  async scheduledEventGarbageCollectionAsync({
    nowMs = Date.now(),
    olderThanMs = DEFAULT_SCHEDULED_GC_AGE_MS,
    batchSize = SCHEDULED_GC_BATCH_SIZE,
  } = {}) {
    if (!this.eventBroker || !this.eventListenerInspector) return null;
    const subscriptions = [...this.eventBroker.state.subscriptions];
    const candidateIds = [];
    const orphanedWithPending = [];
    const boundedBatchSize = Number.isFinite(Number(batchSize))
      ? Math.max(1, Math.floor(Number(batchSize)))
      : SCHEDULED_GC_BATCH_SIZE;
    for (let offset = 0; offset < subscriptions.length; offset += boundedBatchSize) {
      const batch = subscriptions.slice(offset, offset + boundedBatchSize);
      for (const subscription of batch) {
        if (!subscription || this.eventListenerInspector(subscription.id) === true) continue;
        const pending = Array.isArray(subscription.pending) ? subscription.pending : [];
        const pendingSince = pending[0]?.receivedAt ?? subscription.createdAt ?? null;
        if (nowMs - Date.parse(pendingSince || '') < olderThanMs) continue;
        if (pending.length > 0) {
          orphanedWithPending.push({
            id: subscription.id,
            agentId: subscription.agentId,
            repo: subscription.repo,
            resource: subscription.resource,
            number: subscription.number ?? null,
            runId: subscription.runId ?? null,
            pendingCount: pending.length,
            pendingState: pending[0]?.state ?? null,
            pendingSince: pending[0]?.receivedAt ?? null,
          });
        } else {
          candidateIds.push(subscription.id);
        }
      }
      if (offset + boundedBatchSize < subscriptions.length) {
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
    }
    return this.recordScheduledEventGarbageCollection({
      nowMs,
      olderThanMs,
      candidateIds,
      orphanedWithPending,
    });
  }

  // Dry-run only: removal stays an explicit `events gc --apply`. The report is
  // kept for status/health and logged when an orphan needs a human or agent.
  scheduledEventGarbageCollection({ nowMs = Date.now(), olderThanMs = DEFAULT_SCHEDULED_GC_AGE_MS } = {}) {
    if (!this.eventBroker || !this.eventListenerInspector) return null;
    const report = this.eventBroker.garbageCollect({
      listenerAttached: this.eventListenerInspector,
      olderThanMs,
      apply: false,
      includeUnique: true,
    });
    const orphanedWithPending = [...this.eventBroker.state.subscriptions]
      .filter((subscription) => subscription
        && subscription.pending.length > 0
        && this.eventListenerInspector(subscription.id) !== true
        && nowMs - Date.parse(subscription.pending[0]?.receivedAt || subscription.createdAt) >= olderThanMs)
      .map((subscription) => ({
        id: subscription.id,
        agentId: subscription.agentId,
        repo: subscription.repo,
        resource: subscription.resource,
        number: subscription.number ?? null,
        runId: subscription.runId ?? null,
        pendingCount: subscription.pending.length,
        pendingState: subscription.pending[0]?.state ?? null,
        pendingSince: subscription.pending[0]?.receivedAt ?? null,
      }));
    return this.recordScheduledEventGarbageCollection({
      nowMs,
      olderThanMs,
      candidateIds: report.candidates.map(({ id }) => id),
      orphanedWithPending,
    });
  }

  async reconcileEvents(subscriptionId) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    const subscription = this.eventBroker.getSubscriptionRecord(subscriptionId);
    if (!subscription) {
      return {
        ok: false,
        error: { code: 'event_subscription_not_found', message: 'event subscription not found' },
      };
    }
    if (eventRoutingRequired(this.identity, subscription)) {
      assertEventIdentity({
        spec: subscription,
        actualIdentity: this.identity,
        operation: 'reconcile',
      });
    }
    let path;
    let listWorkflowRuns = false;
    let workflowRunsFallbackPath = null;
    let workflowNameId = null;
    if (subscription.resource === 'pull_request' && subscription.number) {
      path = `/repos/${subscription.repo}/pulls/${subscription.number}`;
    } else if (subscription.resource === 'workflow_run' && subscription.runId) {
      path = `/repos/${subscription.repo}/actions/runs/${subscription.runId}`;
    } else if (subscription.resource === 'workflow_run'
      && (subscription.workflow || subscription.branch || subscription.sha || subscription.followLatest)) {
      const query = new URLSearchParams({ created: reconcileRunsCreatedFilter(subscription) });
      if (subscription.branch) query.set('branch', subscription.branch);
      // `head_sha` only filters on the full SHA; an abbreviated one stays a
      // client-side prefix match below.
      if (/^[0-9a-f]{40}$/i.test(String(subscription.sha || ''))) query.set('head_sha', subscription.sha);
      const workflowFile = reconcileWorkflowFile(subscription.workflow);
      if (!workflowFile) workflowNameId = await this.resolveWorkflowNameId(subscription.repo, subscription.workflow);
      const workflowRef = workflowFile || workflowNameId;
      const listQuery = new URLSearchParams(query);
      listQuery.set('per_page', '100');
      const listPath = `/repos/${subscription.repo}/actions/runs?${listQuery.toString()}`;
      if (workflowRef) {
        query.set('per_page', '30');
        path = `/repos/${subscription.repo}/actions/workflows/${encodeURIComponent(workflowRef)}/runs?${query.toString()}`;
        workflowRunsFallbackPath = listPath;
      } else {
        path = listPath;
      }
      listWorkflowRuns = true;
    } else if (subscription.resource === 'deployment' && subscription.deploymentId) {
      path = `/repos/${subscription.repo}/deployments/${subscription.deploymentId}/statuses?per_page=1`;
    } else {
      return {
        ok: false,
        error: {
          code: 'event_reconcile_target_required',
          message: 'reconciliation requires a subscription number, runId, or deploymentId',
        },
      };
    }

    let response = await this.submit({
      type: 'api',
      identity: this.identity,
      client: EVENT_CLIENT_KEY,
      method: 'GET',
      path,
      cacheTtlMs: 0,
    });
    // A bare selector read as `<name>.yml` may not be a file of the repo: the
    // per-workflow endpoint answers 404 and the generic listing still applies.
    if (!response.ok && response.status === 404 && workflowRunsFallbackPath) {
      response = await this.submit({
        type: 'api',
        identity: this.identity,
        client: EVENT_CLIENT_KEY,
        method: 'GET',
        path: workflowRunsFallbackPath,
        cacheTtlMs: 0,
      });
    }
    if (!response.ok) return { ok: false, source: 'reconciliation', response };
    let data;
    try {
      data = JSON.parse(response.body || 'null');
    } catch (error) {
      return {
        ok: false,
        error: { code: 'event_reconcile_response_invalid', message: error.message },
      };
    }
    if (listWorkflowRuns) {
      const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
      data = runs
        .filter((run) => (
          (workflowSelectorMatchesRun(run, subscription.workflow)
            || (workflowNameId !== null && String(run.workflow_id) === workflowNameId))
          && (!subscription.sha || shaMatches(run.head_sha, subscription.sha))
          && (!subscription.branch || run.head_branch === subscription.branch)
        ))
        .sort(latestRunFirst)[0] || null;
      // With `run-name` the REST `name` is the run title: a run found through
      // the workflow its name selector resolved to gets the workflow name
      // back, as the webhook reports it, so the event matches the observer.
      if (data && workflowNameId !== null && !workflowSelectorMatchesRun(data, subscription.workflow)) {
        data = { ...data, workflow_name: subscription.workflow };
      }
    }
    if (subscription.resource === 'deployment') data = Array.isArray(data) ? data[0] : null;
    const events = [];
    const results = [];
    const record = (event) => {
      if (!event) return;
      const result = this.eventBroker.recordEvent(event);
      events.push(result.event);
      results.push(result);
      for (const matchedSubscriptionId of result.matchedSubscriptionIds || []) {
        this.eventNotifier?.(matchedSubscriptionId);
      }
    };

    const event = normalizeReconciliationEvent({ subscription, data });
    record(event);

    // A pull-request GET exposes the PR lifecycle, not the result of its
    // Actions checks. When a PR observer also waits for `failed`, a missed
    // workflow_run webhook must be recoverable from the current head SHA.
    if (subscription.resource === 'pull_request'
      && subscription.waitFor.includes('failed')
      && data?.head?.sha) {
      const headBranch = data.head?.ref || null;
      const query = new URLSearchParams({
        ...(headBranch ? { branch: headBranch } : { head_sha: data.head.sha }),
        created: reconcileRunsCreatedFilter(subscription),
        per_page: '100',
      });
      const runsResponse = await this.submit({
        type: 'api',
        identity: this.identity,
        client: EVENT_CLIENT_KEY,
        method: 'GET',
        path: `/repos/${subscription.repo}/actions/runs?${query.toString()}`,
        cacheTtlMs: 0,
      });
      if (!runsResponse.ok) {
        return {
          ...(results[0] || { ok: false, event: null, matchedSubscriptionIds: [] }),
          ok: false,
          source: 'reconciliation',
          workflowRuns: { ok: false, response: runsResponse },
        };
      }
      let runsData;
      try {
        runsData = JSON.parse(runsResponse.body || 'null');
      } catch (error) {
        return {
          ...(results[0] || { ok: false, event: null, matchedSubscriptionIds: [] }),
          ok: false,
          source: 'reconciliation',
          workflowRuns: {
            ok: false,
            error: { code: 'event_reconcile_workflow_runs_invalid', message: error.message },
          },
        };
      }
      const failedRuns = (Array.isArray(runsData?.workflow_runs) ? runsData.workflow_runs : [])
        .filter((run) => {
          if (String(run.status).toLowerCase() !== 'completed') return false;
          if (!headBranch && run?.head_sha !== data.head.sha) return false;
          if (headBranch && run?.head_branch && run.head_branch !== headBranch) return false;
          if (!['failure', 'startup_failure', 'timed_out'].includes(String(run.conclusion).toLowerCase())) return false;
          const runUpdatedAtMs = Date.parse(run.updated_at || run.completed_at || run.created_at || '');
          const subscriptionCreatedAtMs = Date.parse(subscription.createdAt || '');
          if (Number.isFinite(runUpdatedAtMs)
            && Number.isFinite(subscriptionCreatedAtMs)
            && runUpdatedAtMs < subscriptionCreatedAtMs) return false;
          const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : [];
          return pullRequests.length === 0
            || pullRequests.some((pullRequest) => Number(pullRequest?.number) === subscription.number);
        })
        .sort((left, right) => Date.parse(right.updated_at || right.completed_at || right.created_at || '')
          - Date.parse(left.updated_at || left.completed_at || left.created_at || ''));
      const latestFailedRun = failedRuns[0];
      if (latestFailedRun) {
        const workflowSubscription = { ...subscription, resource: 'workflow_run', runId: null };
        const workflowData = Array.isArray(latestFailedRun.pull_requests)
          && latestFailedRun.pull_requests.length > 0
          ? latestFailedRun
          : { ...latestFailedRun, pull_requests: [{ number: subscription.number }] };
        record(normalizeReconciliationEvent({
          subscription: workflowSubscription,
          data: workflowData,
        }));
      }
    }

    if (results.length === 0) {
      return { ok: true, source: 'reconciliation', event: null, matchedSubscriptionIds: [] };
    }
    if (results.length === 1) return { ...results[0], source: 'reconciliation' };
    return {
      ...results.at(-1),
      source: 'reconciliation',
      events,
      targetMatchedSubscriptionIds: [...new Set(results.flatMap((result) => result.targetMatchedSubscriptionIds || []))],
      matchedSubscriptionIds: [...new Set(results.flatMap((result) => result.matchedSubscriptionIds || []))],
      subscriptionRemoved: results.some((result) => result.subscriptionRemoved),
    };
  }

  publicCancellationDetails(pending) {
    return {
      id: pending.id,
      kind: pending.details.kind,
      repo: pending.details.repo,
      runId: pending.details.runId,
      target: pending.details.target,
      source: pending.request.type === 'exec' ? 'gh-cli' : 'coordinator-api',
      command: pending.command,
      requestedAt: pending.requestedAt,
      expiresAt: pending.expiresAt,
    };
  }

  prunePendingCancellations() {
    const now = Date.now();
    for (const [requestId, pending] of this.pendingCancellations.entries()) {
      if (pending.expiresAtMs <= now) {
        this.pendingCancellations.delete(requestId);
        this.metrics.cancellationExpired += 1;
      }
    }
  }

  ownerConfirmationRequired(request, details) {
    this.prunePendingCancellations();
    const id = `cancel-${randomUUID()}`;
    const requestedAt = new Date().toISOString();
    const expiresAtMs = Date.now() + CANCELLATION_CONFIRMATION_TTL_MS;
    const pending = {
      id,
      request: { ...request, anonymous: false },
      details,
      command: request.type === 'exec'
        ? ['gh', ...(request.args || []).map(String)]
        : ['gh', 'api', '-X', 'POST', request.path],
      requestedAt,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.pendingCancellations.set(id, pending);
    this.metrics.cancellationRequests += 1;
    const publicDetails = this.publicCancellationDetails(pending);
    const message = [
      'owner_confirmation_required: cancellazione GitHub bloccata.',
      `request_id=${id}`,
      `target=${publicDetails.target}`,
      `owner_command=bin/gh-frontaliere confirm-cancel ${id}`,
      `expires_at=${publicDetails.expiresAt}`,
    ].join('\n');
    return {
      ok: false,
      exitCode: 2,
      stdout: '',
      stderr: `${message}\n`,
      error: {
        code: 'owner_confirmation_required',
        message,
        requestId: id,
        cancellation: publicDetails,
        exitCode: 2,
      },
    };
  }

  getPendingCancellation(requestId) {
    this.prunePendingCancellations();
    const pending = this.pendingCancellations.get(String(requestId || ''));
    if (!pending) {
      return {
        ok: false,
        error: {
          code: 'cancellation_confirmation_not_found',
          message: 'richiesta di cancellazione inesistente o scaduta',
        },
      };
    }
    return { ok: true, cancellation: this.publicCancellationDetails(pending) };
  }

  async confirmCancellation(requestId, confirmation) {
    this.prunePendingCancellations();
    const normalizedId = String(requestId || '');
    const pending = this.pendingCancellations.get(normalizedId);
    if (!pending) {
      return this.getPendingCancellation(normalizedId);
    }
    if (String(confirmation || '').trim() !== ownerConfirmationPhrase(normalizedId)) {
      return {
        ok: false,
        error: {
          code: 'owner_confirmation_invalid',
          message: 'conferma proprietario non valida; nessuna cancellazione eseguita',
        },
      };
    }

    this.pendingCancellations.delete(normalizedId);
    this.metrics.cancellationConfirmed += 1;
    const confirmedRequest = { ...pending.request };
    confirmedRequest[OWNER_CONFIRMATION] = normalizedId;
    return this.submit(confirmedRequest);
  }

  submit(request) {
    const cancellation = cancellationRequestDetails(request);
    if (cancellation && request[OWNER_CONFIRMATION] !== undefined) {
      // The symbol is added only by confirmCancellation inside this process;
      // JSON clients cannot forge it by sending a similarly named property.
    } else if (cancellation) {
      return Promise.resolve(this.ownerConfirmationRequired(request, cancellation));
    }
    const queuedRequest = this.shouldRouteEmergencyAnonymous(request)
      ? { ...request, anonymous: true }
      : request;
    const meta = classifyJob(queuedRequest);
    const now = Date.now();
    this.sweepCachesIfDue(now);
    const isRead = !meta.mutation;
    const key = queuedRequest.type === 'api' && isRead ? scopedCacheKeyFor(queuedRequest) : null;
    const isReadCli = queuedRequest.type === 'exec'
      && isRead
      && !cliCommandWritesLocalOutput((queuedRequest.args || []).map(String));
    const cliKey = isReadCli ? cliCacheKeyFor(queuedRequest) : null;
    const cachedCli = cliKey ? this.cliCache.get(cliKey) : null;
    if (cachedCli && cachedCli.expiresAt > now) {
      this.metrics.cliCacheHits += 1;
      this.cliCache.delete(cliKey);
      this.cliCache.set(cliKey, cachedCli);
      return Promise.resolve({ ...cachedCli.response, fromCache: true });
    }
    if (cachedCli) this.cliCache.delete(cliKey);
    const existing = key
      ? this.pendingGets.get(key)
      : cliKey ? this.pendingCli.get(cliKey) : null;
    if (existing) return existing;

    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.queue.push({
        request: queuedRequest,
        resolve: resolvePromise,
        reject: rejectPromise,
        attempts: 0,
        key,
        cliKey,
        meta,
        enqueuedAtMs: now,
      });
      this.metrics.peakQueueLength = Math.max(this.metrics.peakQueueLength, this.queue.length);
      this.pump();
    });
    if (key) {
      this.pendingGets.set(key, promise);
      promise.finally(() => {
        if (this.pendingGets.get(key) === promise) this.pendingGets.delete(key);
      }).catch(() => {});
    }
    if (cliKey) {
      this.pendingCli.set(cliKey, promise);
      promise.finally(() => {
        if (this.pendingCli.get(cliKey) === promise) this.pendingCli.delete(cliKey);
      }).catch(() => {});
      const epochAtSubmit = this.invalidationEpoch;
      promise.then((response) => {
        if (response?.ok && !response.stdoutFile && !this.invalidatedSince(meta.scope, epochAtSubmit)) {
          this.cliCache.delete(cliKey);
          this.cliCache.set(cliKey, {
            response,
            scope: meta.scope,
            expiresAt: Date.now() + CLI_CACHE_TTL_MS,
          });
          while (this.cliCache.size > MAX_CLI_CACHE_ENTRIES) {
            this.cliCache.delete(this.cliCache.keys().next().value);
          }
        }
      }).catch(() => {});
    }
    if (meta.mutation) this.invalidateCaches(meta.scope);
    return promise;
  }

  /**
   * Forget cached reads a mutation may have changed: the ones of the same
   * repository plus every entry of unknown scope, or everything when the
   * mutation's repository is unknown. It used to clear both caches whole on
   * every write of any agent, which is why a day of traffic produced a single
   * cache hit. Entries carrying a validator stay as stale: the next read sends
   * a conditional request instead of refetching the body.
   */
  invalidateCaches(scope = null) {
    this.metrics.cacheInvalidations += 1;
    this.invalidationEpoch += 1;
    if (scope) {
      this.metrics.cacheScopedInvalidations += 1;
      this.scopeInvalidationEpoch.set(scope, this.invalidationEpoch);
    } else {
      this.globalInvalidationEpoch = this.invalidationEpoch;
    }
    for (const [cacheKey, entry] of this.cache) {
      if (scope && entry.scope && entry.scope !== scope) continue;
      if (entry.headers?.etag || entry.headers?.['last-modified']) {
        entry.expiresAt = 0;
      } else {
        this.cacheDelete(cacheKey);
      }
    }
    for (const [cacheKey, entry] of this.cliCache) {
      if (scope && entry.scope && entry.scope !== scope) continue;
      this.cliCache.delete(cacheKey);
    }
  }

  cacheDelete(cacheKey) {
    const entry = this.cache.get(cacheKey);
    if (!entry) return;
    this.cache.delete(cacheKey);
    this.cacheBytes = Math.max(0, this.cacheBytes - (entry.bytes || 0));
  }

  cacheStore(cacheKey, entry) {
    this.cacheDelete(cacheKey);
    this.cache.set(cacheKey, entry);
    this.cacheBytes += entry.bytes || 0;
    while (this.cache.size > MAX_CACHE_ENTRIES || (this.cacheBytes > MAX_CACHE_BYTES && this.cache.size > 1)) {
      this.cacheDelete(this.cache.keys().next().value);
      this.metrics.cacheEvictions += 1;
    }
  }

  cacheTouch(cacheKey, entry) {
    entry.lastUsedAt = Date.now();
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
  }

  sweepCachesIfDue(now = Date.now()) {
    if (now - this.lastCacheSweepAt < CACHE_SWEEP_INTERVAL_MS) return;
    this.lastCacheSweepAt = now;
    for (const [cacheKey, entry] of this.cliCache) {
      if (!(entry.expiresAt > now)) this.cliCache.delete(cacheKey);
    }
    for (const [cacheKey, entry] of this.cache) {
      if (entry.expiresAt > now) continue;
      const hasValidator = Boolean(entry.headers?.etag || entry.headers?.['last-modified']);
      const idleMs = now - (entry.lastUsedAt || entry.storedAt || 0);
      if (!hasValidator || idleMs > STALE_CACHE_RETENTION_MS) this.cacheDelete(cacheKey);
    }
  }

  enqueueAgain(job, delayMs) {
    setTimeout(() => {
      this.queue.unshift(job);
      this.pump();
    }, Math.max(0, delayMs));
  }

  jobMeta(job) {
    if (!job.meta) job.meta = classifyJob(job.request);
    return job.meta;
  }

  jobBucket(job) {
    return this.jobMeta(job).bucket;
  }

  jobIsMutation(job) {
    return this.jobMeta(job).mutation;
  }

  laneLimit(lane) {
    return LANE_LIMITS[lane] ?? 1;
  }

  pruneSecondaryWindow(now = Date.now()) {
    for (const family of Object.keys(this.secondaryWindow)) {
      const window = this.secondaryWindow[family];
      let expired = 0;
      while (expired < window.length && window[expired].atMs <= now - SECONDARY_LIMIT_WINDOW_MS) {
        this.secondaryWindowPoints[family] -= window[expired].points;
        expired += 1;
      }
      if (expired > 0) window.splice(0, expired);
    }
  }

  recordSecondaryUsage(family, points, now = Date.now()) {
    const key = family === 'graphql' ? 'graphql' : 'rest';
    this.secondaryWindow[key].push({ atMs: now, points });
    this.secondaryWindowPoints[key] += points;
  }

  // 0 when the job may start now, Infinity when only a completing job can
  // unblock it (lane full, mutation in flight), otherwise the instant at
  // which it becomes runnable.
  jobBlockedUntil(job, now) {
    const meta = this.jobMeta(job);
    const pausedUntil = this.bucketPausedUntil.get(meta.bucket) || 0;
    if (pausedUntil > now) return pausedUntil;
    if (this.laneActive[meta.lane] >= this.laneLimit(meta.lane)) return Infinity;
    if (meta.mutation) {
      if (this.activeMutations > 0) return Infinity;
      // Serialized and at least one second apart start to start: GitHub's
      // guidance for writes. Counting the gap from the previous completion
      // added a second to every write of every agent.
      const gapAt = this.lastMutationStartedAt + MUTATION_GAP_MS;
      if (now < gapAt) return gapAt;
    }
    const family = meta.family === 'graphql' ? 'graphql' : 'rest';
    if (this.secondaryWindowPoints[family] >= SECONDARY_LIMIT_BUDGETS[family]) {
      const oldest = this.secondaryWindow[family][0];
      return oldest ? oldest.atMs + SECONDARY_LIMIT_WINDOW_MS + 1 : now + 1_000;
    }
    return 0;
  }

  /**
   * The runnable job whose client has the fewest jobs in flight, first in
   * queue order among equals. Plain FIFO let one agent that queued fifty
   * reads hold every slot while the others waited behind it.
   */
  nextRunnableJob() {
    const now = Date.now();
    this.pruneSecondaryWindow(now);
    let bestIndex = -1;
    let bestLoad = Infinity;
    let deferredBySecondaryLimit = false;
    for (let index = 0; index < this.queue.length; index += 1) {
      const job = this.queue[index];
      const blockedUntil = this.jobBlockedUntil(job, now);
      if (blockedUntil !== 0) {
        if (Number.isFinite(blockedUntil) && !deferredBySecondaryLimit) {
          const family = job.meta.family === 'graphql' ? 'graphql' : 'rest';
          deferredBySecondaryLimit = this.secondaryWindowPoints[family] >= SECONDARY_LIMIT_BUDGETS[family];
        }
        continue;
      }
      const load = this.activeByClient.get(job.meta.client) || 0;
      if (load < bestLoad) {
        bestIndex = index;
        bestLoad = load;
        if (load === 0) break;
      }
    }
    if (bestIndex < 0) {
      if (deferredBySecondaryLimit) this.metrics.secondaryLimitDeferrals += 1;
      return null;
    }
    return this.queue.splice(bestIndex, 1)[0];
  }

  pump() {
    while (this.active < this.effectiveMaxInFlight()) {
      const job = this.nextRunnableJob();
      if (!job) {
        this.scheduleNextWake();
        break;
      }
      this.startJob(job);
    }
  }

  startJob(job) {
    const meta = this.jobMeta(job);
    const startedAt = Date.now();
    this.active += 1;
    this.laneActive[meta.lane] += 1;
    this.activeByClient.set(meta.client, (this.activeByClient.get(meta.client) || 0) + 1);
    if (meta.mutation) {
      this.activeMutations += 1;
      this.lastMutationStartedAt = startedAt;
    }
    this.metrics.peakActive = Math.max(this.metrics.peakActive, this.active);
    this.recordLatencySample(meta.lane, 'queueWait', startedAt - (job.enqueuedAtMs || startedAt));
    // Do not invoke several first-use fetch/CLI jobs synchronously from the
    // same pump call. Node may lazily initialize Promise/undici/child-process
    // internals on that path; with a burst of queued reads the initialization
    // can recursively monopolize the event loop and starve the Unix socket.
    // Reserving the slot now preserves the concurrency limit, while the
    // actual job starts on the next turn and lets RPC traffic be serviced.
    setImmediate(() => {
      this.run(job).catch((error) => job.reject(error)).finally(() => {
        const finishedAt = Date.now();
        this.active -= 1;
        this.laneActive[meta.lane] -= 1;
        const clientLoad = (this.activeByClient.get(meta.client) || 1) - 1;
        if (clientLoad > 0) this.activeByClient.set(meta.client, clientLoad);
        else this.activeByClient.delete(meta.client);
        if (meta.mutation) {
          this.activeMutations -= 1;
          this.lastMutationAt = finishedAt;
          this.invalidateCaches(meta.scope);
        }
        this.recordLatencySample(meta.lane, 'run', finishedAt - startedAt);
        this.recordRequestKind(meta.kind, finishedAt - startedAt, job.failed === true);
        this.pump();
      });
    });
  }

  scheduleNextWake() {
    if (this.queue.length === 0) return;
    const now = Date.now();
    let nextAt = Infinity;
    for (const job of this.queue) {
      const blockedUntil = this.jobBlockedUntil(job, now);
      if (blockedUntil === 0) return;
      nextAt = Math.min(nextAt, blockedUntil);
    }
    if (!Number.isFinite(nextAt) || nextAt <= now) return;
    // A job that becomes runnable sooner than the pending wake (a write after
    // its one-second gap while another bucket is paused for a minute) must
    // not wait for the later timer.
    if (this.wakeTimer && this.wakeAt <= nextAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = nextAt;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = 0;
      this.pump();
    }, nextAt - now);
    this.wakeTimer.unref?.();
  }

  recordLatencySample(lane, kind, milliseconds) {
    const samples = this.latencySamples[lane]?.[kind];
    if (!samples) return;
    samples.push(Math.max(0, Math.round(milliseconds)));
    if (samples.length > LATENCY_SAMPLE_LIMIT) samples.splice(0, samples.length - LATENCY_SAMPLE_LIMIT);
  }

  recordRequestKind(kind, milliseconds, failed) {
    let name = kind || 'other';
    if (!this.requestKinds.has(name) && this.requestKinds.size >= MAX_REQUEST_KINDS) name = 'other';
    const entry = this.requestKinds.get(name) || { count: 0, failed: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    if (failed) entry.failed += 1;
    entry.totalMs += Math.max(0, milliseconds);
    entry.maxMs = Math.max(entry.maxMs, milliseconds);
    this.requestKinds.set(name, entry);
  }

  schedulerStatus({ detailed = false } = {}) {
    const queuedByLane = Object.fromEntries(LANES.map((lane) => [lane, 0]));
    const queuedClients = new Set();
    for (const job of this.queue) {
      const meta = this.jobMeta(job);
      queuedByLane[meta.lane] = (queuedByLane[meta.lane] || 0) + 1;
      queuedClients.add(meta.client);
    }
    this.pruneSecondaryWindow();
    const allWaits = LANES.flatMap((lane) => this.latencySamples[lane].queueWait);
    const status = {
      lanes: Object.fromEntries(LANES.map((lane) => [lane, {
        limit: this.laneLimit(lane),
        active: this.laneActive[lane],
        queued: queuedByLane[lane],
      }])),
      activeClients: this.activeByClient.size,
      queuedClients: queuedClients.size,
      queueWaitMs: latencySummary(allWaits),
      secondaryLimit: {
        windowMs: SECONDARY_LIMIT_WINDOW_MS,
        rest: { used: this.secondaryWindowPoints.rest, budget: SECONDARY_LIMIT_BUDGETS.rest },
        graphql: { used: this.secondaryWindowPoints.graphql, budget: SECONDARY_LIMIT_BUDGETS.graphql },
      },
    };
    if (!detailed) return status;
    status.latency = Object.fromEntries(LANES.map((lane) => [lane, {
      queueWaitMs: latencySummary(this.latencySamples[lane].queueWait),
      runMs: latencySummary(this.latencySamples[lane].run),
    }]));
    status.requestKinds = [...this.requestKinds.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, 20)
      .map(([kind, entry]) => ({
        kind,
        count: entry.count,
        failed: entry.failed,
        avgMs: Math.round(entry.totalMs / Math.max(1, entry.count)),
        maxMs: Math.round(entry.maxMs),
      }));
    return status;
  }

  async run(job) {
    try {
      let response = job.request.type === 'api'
        ? await this.executeApi(job.request)
        : await this.executeCli(job.request, this.jobMeta(job));
      let usedAnonymousFallback = false;
      if (response.rateLimited) {
        let delayMs = this.recordRateLimit(job.request, response);
        if (this.shouldUseAnonymousFallback(job.request, response)) {
          this.metrics.anonymousFallbacks += 1;
          usedAnonymousFallback = true;
          response = job.request.type === 'api'
            ? await this.executeApi({ ...job.request, anonymous: true, cacheKey: undefined })
            : await this.executeCli({ ...job.request, anonymous: true });
          if (response.rateLimited) {
            delayMs = this.recordRateLimit({ ...job.request, anonymous: true }, response);
          }
        }
        if (response.rateLimited && !usedAnonymousFallback
          && job.request.type === 'api'
          && isSafeRead(job.request.method)
          && job.attempts + 1 < MAX_API_ATTEMPTS) {
          job.attempts += 1;
          job.enqueuedAtMs = Date.now();
          this.enqueueAgain(job, delayMs);
          return;
        }
      }
      job.failed = response?.ok === false;
      job.resolve(response);
    } catch (error) {
      job.failed = true;
      job.reject(error);
    }
  }

  shouldUseAnonymousFallback(request, response) {
    return !request.anonymous
      && response?.headers?.['x-ratelimit-remaining'] === '0'
      && isEmergencyPublicRead(request)
      && this.anonymousBudgetAvailable();
  }

  recordRateLimit(request, response) {
    this.metrics.rateLimited += 1;
    const delayMs = Math.max(1_000, Number(response.retryAfterMs || 60_000));
    const bucket = this.jobBucket({ request });
    this.bucketPausedUntil.set(bucket, Date.now() + delayMs);
    if (request.anonymous) {
      this.metrics.anonymousRateLimited += 1;
      this.anonymousPausedUntil = Math.max(this.anonymousPausedUntil, Date.now() + delayMs);
    }
    return delayMs;
  }

  observeBucket(bucket, headers) {
    const previous = this.buckets.get(bucket) || {};
    this.buckets.set(bucket, {
      ...previous,
      resource: headers['x-ratelimit-resource'] || previous.resource || bucket,
      limit: headers['x-ratelimit-limit'] ?? previous.limit ?? null,
      remaining: headers['x-ratelimit-remaining'] ?? previous.remaining ?? null,
      used: headers['x-ratelimit-used'] ?? previous.used ?? null,
      reset: headers['x-ratelimit-reset'] ?? previous.reset ?? null,
      observedAt: new Date().toISOString(),
    });
  }

  async executeApi(request) {
    this.metrics.requests += 1;
    const method = String(request.method || 'GET').toUpperCase();
    const baseBucket = request.bucket || classifyBucket(request.path, method);
    const bucket = request.anonymous ? `${baseBucket}-anonymous` : baseBucket;
    const key = scopedCacheKeyFor({ ...request, method });
    const ttl = Math.max(0, Math.min(MAX_CACHE_TTL_MS, Number(request.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)));
    const read = apiRequestIsRead({ ...request, method });
    // A read with ttl 0 is never answered from memory, but it still sends the
    // stored validator: a 304 is current by definition and costs no quota.
    const cached = read ? this.cache.get(key) : null;
    if (cached && ttl > 0 && cached.expiresAt > Date.now()) {
      this.metrics.cacheHits += 1;
      this.cacheTouch(key, cached);
      return cacheResponse(cached, 'hit');
    }

    if (request.anonymous && !this.reserveAnonymousRequest()) {
      this.metrics.anonymousBudgetExhausted += 1;
      const retryAfterMs = Math.max(
        1_000,
        this.anonymousWindowStartedAt + ANONYMOUS_WINDOW_MS - Date.now(),
      );
      return {
        ok: false,
        status: 429,
        headers: { 'x-frontaliere-anonymous-budget': 'exhausted' },
        body: 'frontaliere anonymous emergency budget exhausted\n',
        rateLimited: true,
        retryAfterMs,
        error: {
          code: 'frontaliere_anonymous_budget_exhausted',
          message: 'anonymous emergency budget exhausted',
          status: 429,
        },
      };
    }

    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'frontaliere-github-coordinator',
      'x-github-api-version': request.apiVersion || DEFAULT_API_VERSION,
      ...(request.headers || {}),
    };
    delete headers.authorization;
    delete headers.Authorization;
    if (!request.anonymous) headers.authorization = `Bearer ${this.token}`;
    if (cached?.headers?.etag) headers['if-none-match'] = cached.headers.etag;
    if (cached?.headers?.['last-modified']) headers['if-modified-since'] = cached.headers['last-modified'];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(request.timeoutMs || 30_000)));
    let response;
    let redirected = false;
    const epochAtStart = this.invalidationEpoch;
    this.metrics.networkRequests += 1;
    if (request.anonymous) this.metrics.anonymousRequests += 1;
    this.recordSecondaryUsage(isGraphqlPath(request.path) ? 'graphql' : 'rest', read ? 1 : 5);
    const sourceUrl = apiUrl(request.path);
    try {
      response = await fetch(sourceUrl, {
        method,
        headers,
        body: request.body === undefined || request.body === null
          ? undefined
          : typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
        redirect: 'manual',
        signal: controller.signal,
      });
      const redirectTarget = externalRedirectTarget(response, sourceUrl);
      if (redirectTarget) {
        redirected = true;
        response = await fetch(redirectTarget, {
          method: 'GET',
          headers: {
            accept: 'application/octet-stream',
            'user-agent': 'frontaliere-github-coordinator',
          },
          redirect: 'manual',
          signal: controller.signal,
        });
      }
    } finally {
      clearTimeout(timer);
    }

    const responseHeaders = observedHeaders(response.headers);
    this.observeBucket(bucket, responseHeaders);
    const renderedHeaders = request.anonymous
      ? { ...responseHeaders, 'x-frontaliere-auth-mode': 'anonymous' }
      : responseHeaders;
    const {
      body,
      truncated: bodyTruncated,
      bytes: bodyBytes,
      bytesAtLeast: bodyBytesAtLeast,
    } = await readResponseBody(response);
    if (response.status === 304 && cached) {
      this.metrics.cacheRevalidations += 1;
      cached.expiresAt = this.invalidatedSince(cached.scope, epochAtStart) ? 0 : Date.now() + ttl;
      cached.headers = { ...cached.headers, ...responseHeaders };
      if (this.cache.get(key) === cached) this.cacheTouch(key, cached);
      else this.cacheStore(key, cached);
      return cacheResponse(cached, 'revalidated');
    }

    if (responseIsRateLimited(response.status, responseHeaders, body)) {
      const retryAfterMs = retryDelayMilliseconds({
        headers: responseHeaders,
        remaining: responseHeaders['x-ratelimit-remaining'],
        resetAt: responseHeaders['x-ratelimit-reset'],
      });
      return {
        ok: false,
        status: response.status,
        headers: responseHeaders,
        body,
        rateLimited: true,
        retryAfterMs,
        error: {
          code: 'github_rate_limited',
          message: body || `HTTP ${response.status}`,
          status: response.status,
          headers: responseHeaders,
        },
      };
    }

    // Un body tagliato dal nostro cap non e' una risposta: uscirebbe 0 con un
    // JSON invalido e il chiamante diagnosticherebbe un limite di GitHub.
    if (bodyTruncated) {
      return {
        ok: false,
        status: response.status,
        headers: renderedHeaders,
        body: '',
        truncated: true,
        bodyBytes,
        bodyBytesAtLeast,
        error: {
          code: RESPONSE_TRUNCATED_CODE,
          message: describeTruncation(request.method || 'GET', request.path, bodyBytes, bodyBytesAtLeast),
          status: response.status,
          headers: renderedHeaders,
        },
      };
    }

    const result = {
      ok: response.ok,
      status: response.status,
      headers: renderedHeaders,
      body,
    };
    if (read && response.ok && !redirected) {
      const bytes = Buffer.byteLength(body || '', 'utf8');
      const hasValidator = Boolean(renderedHeaders.etag || renderedHeaders['last-modified']);
      if (ttl > 0 || (hasValidator && bytes <= MAX_REVALIDATION_BODY_BYTES)) {
        const storedAt = Date.now();
        this.cacheStore(key, {
          status: response.status,
          headers: renderedHeaders,
          body,
          bytes,
          scope: repoScopeFromPath(request.path),
          storedAt,
          lastUsedAt: storedAt,
          // A mutation of this scope that completed while the read was in
          // flight may postdate the body: keep only its validator.
          expiresAt: ttl > 0 && !this.invalidatedSince(repoScopeFromPath(request.path), epochAtStart)
            ? storedAt + ttl
            : 0,
        });
      }
    }
    return result;
  }

  invalidatedSince(scope, epoch) {
    if (this.globalInvalidationEpoch > epoch) return true;
    if (!scope) return this.invalidationEpoch > epoch;
    return (this.scopeInvalidationEpoch.get(scope) || 0) > epoch;
  }

  async executeCli(request, meta = classifyJob(request)) {
    this.metrics.cliCommands += 1;
    const requestedArgs = Array.isArray(request.args) ? request.args.map(String) : [];
    let args;
    let stdin = null;
    try {
      ({ args, stdin } = prepareSecretSetInput(requestedArgs));
    } catch (error) {
      return {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: `github-coordinator: ${error.message}\n`,
      };
    }
    const isRunWatch = args[0] === 'run' && args[1] === 'watch';
    if (isRunWatch || args.includes('--watch')) {
      return {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: `${isRunWatch ? 'github-coordinator: gh run watch' : 'github-coordinator: --watch'} è vietato; usa un solo osservatore condiviso.\n`,
      };
    }

    const parsedApi = parseGhApiArguments(args);
    if (parsedApi) return this.executeParsedApi(parsedApi, { anonymous: Boolean(request.anonymous) });

    this.recordSecondaryUsage(meta.family, meta.points);
    const timeoutMs = meta.timeoutMs ?? CLI_TIMEOUT_MS[meta.lane] ?? CLI_TIMEOUT_MS.cli;
    return new Promise((resolvePromise) => {
      let timedOut = false;
      let killTimer = null;
      const child = spawn(this.realGh, args, {
        cwd: safeCwd(request.cwd),
        env: {
          ...process.env,
          GH_TOKEN: this.token,
          GH_HOST: 'github.com',
          GH_PAGER: 'cat',
          FRONTALIERE_GH_BROKER_ACTIVE: '1',
        },
        // Ordinary client stdin is never forwarded: an open pipe makes any
        // `--input -` / `--body-file -` hang forever and block the queue.
        // prepareSecretSetInput is the explicit, file-backed exception.
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      if (stdin !== null) child.stdin.end(stdin);
      const deadline = setTimeout(() => {
        timedOut = true;
        this.metrics.cliTimeouts += 1;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), CLI_KILL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs);
      deadline.unref?.();
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (error) => {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        resolvePromise({
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: `${error.message}\n`,
        });
      });
      child.on('close', (closeCode, signal) => {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        // 124 like timeout(1): the command did not complete, whatever it printed.
        const exitCode = timedOut ? 124 : closeCode;
        const outBuffer = Buffer.concat(stdout);
        const out = outBuffer.toString('utf8');
        const err = `${Buffer.concat(stderr).toString('utf8')}${timedOut
          ? `github-coordinator: gh interrotto dal daemon dopo ${Math.round(timeoutMs / 1_000)} s senza terminare (corsia ${meta.lane}).\n`
          : ''}`;
        const combined = `${out}\n${err}`;
        const looksLimited = exitCode !== 0 && bodyLooksRateLimited(combined);
        // Output oltre il cap del protocollo (log di job da centinaia di MB):
        // spill su file 0600, il client lo riversa su stdout e lo cancella.
        const stdoutFile = outBuffer.length > MAX_BODY_BYTES ? spillCliOutput(outBuffer) : null;
        resolvePromise({
          ok: exitCode === 0,
          exitCode: exitCode ?? 1,
          signal: signal || null,
          stdout: stdoutFile ? '' : trimOutput(out),
          stdoutFile,
          stderr: trimOutput(err),
          rateLimited: looksLimited,
          retryAfterMs: looksLimited ? 60_000 : undefined,
        });
      });
    });
  }

  async executeParsedApi(parsed, { anonymous = false } = {}) {
    const pages = [];
    let path = parsed.path;
    for (let page = 0; page < (parsed.paginate ? MAX_PAGINATED_API_PAGES : 1); page += 1) {
      const response = await this.executeApi({
        type: 'api',
        identity: this.identity,
        method: parsed.method,
        path,
        headers: parsed.headers,
        body: parsed.body,
        anonymous,
        cacheTtlMs: apiRequestIsRead({ method: parsed.method, path, body: parsed.body }) ? DEFAULT_CACHE_TTL_MS : 0,
      });
      if (response.rateLimited) {
        return {
          ...response,
          exitCode: 1,
          stdout: '',
          stderr: `${response.body || response.error?.message || 'GitHub rate limit'}\n`,
        };
      }
      if (response.truncated) {
        return {
          ok: false,
          exitCode: RESPONSE_TRUNCATED_EXIT_CODE,
          truncated: true,
          stdout: '',
          stderr: `${response.error?.message || describeTruncation(parsed.method, path, response.bodyBytes, response.bodyBytesAtLeast)}\n`,
          status: response.status,
          headers: response.headers,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: `${response.body || `HTTP ${response.status}`}\n`,
          status: response.status,
          headers: response.headers,
        };
      }
      pages.push(response);
      if (!parsed.paginate) break;
      const next = nextPagePath(response.headers?.link);
      if (!next) break;
      path = next;
    }

    const graphqlError = parsed.path === '/graphql'
      ? graphqlResponseError(pages[0]?.body || '', pages[0]?.status)
      : null;
    if (graphqlError !== null) {
      // Like gh: the body still goes to stdout (without --jq), the messages
      // to stderr, and the exit is 1 — a script must not read `errors` as data.
      const raw = renderGhApiResponse(pages, { ...parsed, jq: null });
      return {
        ok: false,
        exitCode: 1,
        stdout: raw.ok ? raw.output : '',
        stderr: `gh: ${graphqlError}\n`,
      };
    }

    const rendered = renderGhApiResponse(pages, parsed);
    if (!rendered.ok) {
      return { ok: false, exitCode: 1, stdout: '', stderr: `${rendered.error}\n` };
    }
    return { ok: true, exitCode: 0, stdout: rendered.output, stderr: '' };
  }
}

function classifyCliBucket(args) {
  if (args[0] === 'graphql') return 'graphql';
  if (args[0] === 'api') {
    const invocation = cliApiInvocation(args);
    return invocation.parsed
      ? classifyBucket(invocation.parsed.path, invocation.parsed.method)
      : invocation.graphql ? 'graphql' : classifyBucket(invocation.path, invocation.method);
  }
  return 'core';
}

/**
 * True unless the GraphQL document is certainly a read. `gh api graphql` is a
 * POST, and treating every query as a mutation serialized it behind the write
 * lane with a one-second gap and flushed every cache. Comments and string
 * literals are stripped first; any `mutation`/`subscription` keyword left (or
 * an unreadable document) keeps the conservative answer.
 */
export function graphqlOperationIsMutation(query) {
  if (typeof query !== 'string' || query.trim() === '') return true;
  const text = query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/#[^\n\r]*/g, ' ');
  return /\b(?:mutation|subscription)\b/.test(text);
}

function graphqlQueryFromBody(body) {
  if (body && typeof body === 'object') return body.query;
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body)?.query ?? null; } catch { return null; }
}

function isGraphqlPath(path) {
  const pathname = String(path || '').split('?')[0];
  return pathname === '/graphql' || pathname === 'graphql';
}

/** Whether an API request only reads: safe REST methods or a GraphQL query. */
export function apiRequestIsRead(request) {
  const method = String(request?.method || 'GET').toUpperCase();
  if (isSafeRead(method)) return true;
  return method === 'POST'
    && isGraphqlPath(request?.path)
    && !graphqlOperationIsMutation(graphqlQueryFromBody(request?.body));
}

// The method and, for GraphQL, the document of a `gh api` invocation the
// native parser rejects (templates, --input, …). With fields and no explicit
// --method the real gh sends a POST: calling that a read cached and deduped
// writes.
function cliApiInvocation(args) {
  const parsed = parseGhApiArguments(args);
  if (parsed) {
    const graphql = parsed.path === '/graphql';
    return { parsed, graphql, method: parsed.method, path: parsed.path, query: graphql ? parsed.body?.query : null };
  }
  let method = null;
  let endpoint = null;
  let query = null;
  let sendsBody = false;
  const optionsWithValue = new Set([
    '--cache', '--header', '--hostname', '--jq', '--preview', '--repo', '--template', '-H', '-t', '-q', '-p',
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === '--method' || value === '-X') {
      method = String(args[index + 1] || '');
      index += 1;
    } else if (value.startsWith('--method=')) {
      method = value.slice('--method='.length);
    } else if (['-f', '-F', '--field', '--raw-field'].includes(value)) {
      const field = String(args[index + 1] || '');
      if (field.startsWith('query=')) query = field.slice('query='.length);
      sendsBody = true;
      index += 1;
    } else if (/^--(?:raw-)?field=/.test(value)) {
      const field = value.slice(value.indexOf('=') + 1);
      if (field.startsWith('query=')) query = field.slice('query='.length);
      sendsBody = true;
    } else if (value === '--input') {
      sendsBody = true;
      index += 1;
    } else if (value.startsWith('--input=')) {
      sendsBody = true;
    } else if (optionsWithValue.has(value)) {
      index += 1;
    } else if (!value.startsWith('-') && endpoint === null) {
      endpoint = value;
    }
  }
  const path = endpoint === null ? '' : endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const graphql = endpoint === 'graphql' || path === '/graphql';
  const normalizedMethod = String(method || (sendsBody || graphql ? 'POST' : 'GET')).toUpperCase();
  // A document read from a file (`query=@file.graphql`) cannot be inspected.
  const inspectableQuery = typeof query === 'string' && !query.startsWith('@') ? query : null;
  return { parsed: null, graphql, method: normalizedMethod, path, query: inspectableQuery };
}

// Verbs of `gh <noun> <verb>` that only read from GitHub, and top-level
// commands without a verb that do the same.
const CLI_READ_VERBS = new Set(['list', 'view', 'status', 'diff', 'checks', 'log', 'get']);
const CLI_READ_COMMANDS = new Set(['search', 'status', 'version', '--version', 'help', '--help']);

function cliCommandIsMutation(args) {
  if (cancellationRequestDetails({ type: 'exec', args })) return true;
  if (args[0] === 'api') {
    const invocation = cliApiInvocation(args);
    if (invocation.graphql) return invocation.method !== 'POST' || graphqlOperationIsMutation(invocation.query);
    return !isSafeRead(invocation.method);
  }
  if (args[0] === 'graphql') return args.includes('--field') || args.includes('-f') || args.includes('--raw-field');
  if (CLI_READ_COMMANDS.has(args[0])) return false;
  return !CLI_READ_VERBS.has(args[1]) && !cliCommandWritesLocalOutput(args);
}

// `gh run download` / `gh release download` only READ from GitHub, but their
// result is the files they write under the caller's cwd. Treating them as a
// mutation parked every write of the workspace behind a 240 MB artifact for
// ~19.5 minutes (nextRunnableJob skips mutations while one is active). They
// are not cacheable either: a cached `ok` would report a download that wrote
// nothing, so they bypass the CLI cache and the in-flight dedup. Clones and
// `pr checkout` are the same kind of work: local effects, remote reads.
function cliCommandWritesLocalOutput(args) {
  if (args[1] === 'download') return args[0] === 'run' || args[0] === 'release';
  if (args[1] === 'clone') return args[0] === 'repo' || args[0] === 'gist';
  return args[0] === 'pr' && args[1] === 'checkout';
}

function cliCommandIsBulk(args) {
  if (cliCommandWritesLocalOutput(args)) return true;
  if (args[0] === 'run' && args[1] === 'view') {
    return args.some((value) => value === '--log' || value === '--log-failed');
  }
  return args[0] === 'api' && args.includes('--paginate');
}

function apiPathIsBulk(path) {
  const pathname = String(path || '').split('?')[0];
  return /\/logs$/.test(pathname)
    || /\/artifacts\/\d+\/zip$/.test(pathname)
    || /\/(?:tarball|zipball)(?:\/|$)/.test(pathname);
}

/** `owner/repo` (lowercase) of a REST path, or null when not repo-scoped. */
export function repoScopeFromPath(path) {
  const match = String(path || '').match(/^\/?repos\/([^/?#{}]+)\/([^/?#{}]+)/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function repoScopeFromCliRepo(value) {
  const segments = String(value || '').split('/').filter(Boolean);
  return segments.length >= 2 ? segments.slice(-2).join('/').toLowerCase() : null;
}

const workingDirectoryRepoCache = new Map();

function githubRepoFromRemoteUrl(url) {
  const match = String(url || '').trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/**
 * The repository `gh` resolves from a working directory, but only when that
 * resolution is unambiguous: exactly one GitHub remote and no `gh-resolved`
 * default. Anything else stays unknown (null) and a mutation from there
 * invalidates every cached read, as before. Only used to scope cache
 * invalidation, never as a cache key: `gh pr view` without a number also
 * depends on the checked-out branch.
 */
export function repoFromWorkingDirectory(cwd, { nowMs = Date.now() } = {}) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const cached = workingDirectoryRepoCache.get(cwd);
  if (cached && cached.expiresAtMs > nowMs) return cached.repo;
  let repo = null;
  try {
    let directory = resolve(cwd);
    for (let depth = 0; depth < 64; depth += 1) {
      const dotGit = join(directory, '.git');
      let stats = null;
      try { stats = statSync(dotGit); } catch { /* not here */ }
      if (stats) {
        let gitDirectory = dotGit;
        if (stats.isFile()) {
          const pointer = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
          gitDirectory = pointer ? resolve(directory, pointer[1].trim()) : null;
        }
        if (gitDirectory) {
          let commonDirectory = gitDirectory;
          try {
            commonDirectory = resolve(gitDirectory, readFileSync(join(gitDirectory, 'commondir'), 'utf8').trim());
          } catch { /* not a linked worktree */ }
          const config = readFileSync(join(commonDirectory, 'config'), 'utf8');
          if (!/^\s*gh-resolved\s*=/m.test(config)) {
            const remotes = new Set();
            for (const [, url] of config.matchAll(/^\s*url\s*=\s*(.+)$/gm)) {
              const remote = githubRepoFromRemoteUrl(url);
              if (remote) remotes.add(remote);
            }
            if (remotes.size === 1) [repo] = remotes;
          }
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    repo = null;
  }
  if (workingDirectoryRepoCache.size >= 256) {
    workingDirectoryRepoCache.delete(workingDirectoryRepoCache.keys().next().value);
  }
  workingDirectoryRepoCache.set(cwd, { repo, expiresAtMs: nowMs + WORKING_DIRECTORY_REPO_TTL_MS });
  return repo;
}

function clientKeyFor(request) {
  const value = request?.client || request?.agentId || request?.cwd || 'anonymous';
  return String(value).slice(0, 256);
}

function requestKindFor(request, lane) {
  if (request.type === 'api') {
    if (isGraphqlPath(request.path)) return `api graphql ${lane === 'mutation' ? 'mutation' : 'query'}`;
    return `api ${String(request.method || 'GET').toUpperCase()}`;
  }
  const args = Array.isArray(request.args) ? request.args.map(String) : [];
  if (args[0] === 'api') {
    const invocation = cliApiInvocation(args);
    return invocation.graphql
      ? `gh api graphql ${lane === 'mutation' ? 'mutation' : 'query'}`
      : `gh api ${invocation.method}`;
  }
  const words = args.filter((value) => !value.startsWith('-')).slice(0, 2)
    .filter((value) => /^[a-z][a-z-]{0,30}$/.test(value));
  return `gh ${words.join(' ') || '?'}`;
}

/**
 * Everything the scheduler needs about a job, computed once at submission.
 * The queue used to re-parse `gh` arguments for every queued job on every
 * pump turn and on every wake-up computation.
 */
export function classifyJob(request) {
  const args = Array.isArray(request?.args) ? request.args.map(String) : [];
  let mutation;
  let lane;
  let bucket;
  let scope;
  let family;
  if (request?.type === 'api') {
    const read = apiRequestIsRead(request);
    mutation = !read;
    bucket = request.bucket || classifyBucket(request.path, request.method);
    lane = mutation ? 'mutation' : apiPathIsBulk(request.path) ? 'bulk' : 'api';
    scope = repoScopeFromPath(request.path);
    family = isGraphqlPath(request.path) ? 'graphql' : 'rest';
  } else {
    mutation = cliCommandIsMutation(args);
    bucket = classifyCliBucket(args);
    const invocation = args[0] === 'api' ? cliApiInvocation(args) : null;
    if (mutation) lane = 'mutation';
    else if (cliCommandIsBulk(args)) lane = 'bulk';
    else lane = invocation?.parsed ? 'api' : 'cli';
    const explicitRepo = repoScopeFromCliRepo(repoFromCliArguments(args));
    if (explicitRepo) {
      scope = explicitRepo;
    } else if (invocation) {
      // `gh api` reaches the working-directory repo only via placeholders.
      scope = repoScopeFromPath(invocation.path)
        || (/\{(?:owner|repo)\}/.test(invocation.path) ? repoFromWorkingDirectory(request?.cwd) : null);
    } else {
      scope = repoFromWorkingDirectory(request?.cwd);
    }
    family = bucket === 'graphql' ? 'graphql' : 'rest';
  }
  if (request?.anonymous) bucket = `${bucket}-anonymous`;
  return {
    lane,
    mutation,
    bucket,
    scope: scope || null,
    family,
    points: mutation ? 5 : 1,
    client: clientKeyFor(request),
    kind: requestKindFor(request || {}, lane),
  };
}

function readTokenAndStart(identity) {
  const socket = socketPath(identity);
  const parent = dirname(socket);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try { chmodSync(parent, 0o700); } catch { /* best effort */ }
  const ownerLock = claimCoordinatorOwner(identity, socket);
  if (ownerLock) {
    startWithOwnerLock(identity, socket, ownerLock);
    return;
  }
  if (!supervisedStandbyEnabled()) return;
  const standby = standbyForCoordinatorOwner({
    identity,
    socket,
    reclaimGraceMs: unsupervisedOwnerGraceMs(),
    onClaimed: (claimed) => {
      process.removeListener('SIGTERM', leaveStandby);
      process.removeListener('SIGINT', leaveStandby);
      try {
        startWithOwnerLock(identity, socket, claimed);
      } catch (error) {
        process.stderr.write(`github-coordinator: ${error.message}\n`);
        process.exit(1);
      }
    },
  });
  // No lock, socket or worker is held while waiting: leave at once.
  const leaveStandby = () => {
    standby.stop();
    process.exit(0);
  };
  process.on('SIGTERM', leaveStandby);
  process.on('SIGINT', leaveStandby);
}

function startWithOwnerLock(identity, socket, ownerLock) {
  let realGh;
  let token;
  try {
    // A forced shutdown can leave the filesystem entry behind after the
    // process has gone away. The owner lock is the authority for this path:
    // once we own it, no live coordinator should still be serving this socket.
    removeStaleCoordinatorSocket(socket);
    realGh = resolveRealGh();
    token = resolveToken(identity, realGh);
  } catch (error) {
    releaseCoordinatorOwner(ownerLock, { removeSocket: true });
    try { unlinkSync(`${socket}.start`); } catch { /* no start lock */ }
    throw error;
  }

  const eventStateFile = eventStatePath(identity);
  const legacyStateFile = legacyEventStatePath(identity);
  const webhookSecret = process.env.FRONTALIERE_GH_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET;
  const eventBrokerLoader = loadEventBrokerStateInWorker({
    stateFile: eventStateFile,
    legacyStateFile,
  });
  let eventBroker = null;
  const coordinator = new GitHubCoordinator({ identity, token, realGh, socket, eventBroker });
  coordinator.eventBrokerLoading = true;
  const eventBrokerReady = eventBrokerLoader.promise.then((initialState) => {
    eventBroker = new GitHubEventBroker({
      stateFile: eventStateFile,
      legacyStateFile,
      webhookSecret,
      initialState,
      canPersist: () => ownsCoordinatorLock(ownerLock),
    });
    coordinator.eventBroker = eventBroker;
    coordinator.eventBrokerLoading = false;
    return eventBroker;
  });
  // Install a rejection handler before the socket is listening so a corrupt
  // state cannot become an unhandled worker rejection during bootstrap. The
  // definitive shutdown handler is attached below once `terminate` exists.
  eventBrokerReady.catch(() => {});
  let terminate = () => {};
  let expirationTimer = null;
  let listenerHeartbeatTimer = null;
  let orphanRetirementTimer = null;
  let eventSweepTimer = null;
  let firstSweepTimer = null;
  let scheduledGcTimer = null;
  let socketEndpointTimer = null;
  let socketEndpointLost = false;
  let boundSocketInode = null;
  let firstGcTimer = null;
  const eventListeners = new Map();
  const connections = new Set();
  const sharedAcknowledgements = new Set();
  const closingConnections = new WeakSet();
  const expectedClientSocketErrors = new Set([
    'ECONNABORTED',
    'ECONNRESET',
    'EPIPE',
    'ERR_STREAM_DESTROYED',
    'ERR_STREAM_WRITE_AFTER_END',
  ]);
  let activeRequestCount = 0;
  const EVENT_LISTENER_HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1_000;
  const EVENT_LISTENER_ACK_TIMEOUT_MS = 3 * 60 * 1_000;

  const writeMessage = (connection, message) => {
    if (connection.destroyed || connection.writableEnded) return false;
    try {
      connection.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const endConnection = (connection) => {
    closingConnections.add(connection);
    if (!connection.destroyed && !connection.writableEnded) connection.end();
  };

  const destroyConnection = (connection) => {
    closingConnections.add(connection);
    if (!connection.destroyed) connection.destroy();
  };

  const clientErrorDetails = (error) => {
    const details = {
      code: error?.code || 'coordinator_error',
      message: error?.message || String(error),
    };
    for (const field of [
      'requestId',
      'existingSubscriptionId',
      'existingSubscription',
      'targetKey',
      'sharedObserverRecommended',
      'repo',
      'actualIdentity',
      'expectedIdentity',
      'nextAction',
      'exitCode',
    ]) {
      if (error?.[field] !== undefined) details[field] = error[field];
    }
    return details;
  };

  const detachEventListener = (listener) => {
    const listeners = eventListeners.get(listener.subscriptionId);
    if (!listeners) return;
    coordinator.noteListenerActivity(listener.subscriptionId);
    listeners.delete(listener);
    if (listeners.size === 0) eventListeners.delete(listener.subscriptionId);
  };

  const detachConnectionListeners = (connection, listener = null) => {
    if (listener) detachEventListener(listener);
    for (const listeners of eventListeners.values()) {
      for (const candidate of [...listeners]) {
        if (candidate.connection === connection) detachEventListener(candidate);
      }
    }
  };

  const closeConnectionAfterError = (connection, error, listener = null) => {
    logStructuredError('client_request_failed', error);
    detachConnectionListeners(connection, listener);
    try {
      if (!connection.destroyed) {
        writeMessage(connection, { ok: false, error: clientErrorDetails(error) });
        endConnection(connection);
      }
    } catch (closeError) {
      logStructuredError('client_connection_close_failed', closeError);
      destroyConnection(connection);
    }
  };
  const closeIdleConnection = (connection) => {
    if (closingConnections.has(connection) || connection.destroyed) return;
    coordinator.metrics.socketTimeouts += 1;
    detachConnectionListeners(connection);
    destroyConnection(connection);
  };
  const listenerConnectionAlive = (listener) => !listener.connection.destroyed
    && !listener.connection.writableEnded
    && !listener.connection.readableEnded
    && listener.connection.readable !== false
    && listener.connection.writable !== false
    && (listener.connection.readyState === undefined || listener.connection.readyState === 'open');
  coordinator.setEventListenerInspector((subscriptionId) => [...(
    eventListeners.get(String(subscriptionId)) || []
  )].some(listenerConnectionAlive));
  coordinator.setEventListenerCountInspector(
    () => [...eventListeners.values()].reduce(
      (total, listeners) => total + [...listeners].filter(listenerConnectionAlive).length,
      0,
    ),
  );
  coordinator.setEventListenerInfoInspector((subscriptionId) => [...(
    eventListeners.get(String(subscriptionId)) || []
  )].map((listener) => ({
    agentId: listener.agentId,
    connectedAt: listener.connectedAt,
    lastHeartbeatAt: listener.lastHeartbeatAt,
    heartbeatCount: listener.heartbeatCount,
    inFlightEventId: listener.inFlightEventId,
    lastEventAt: listener.lastEventAt,
    lastAckAt: listener.lastAckAt,
  })));

  const deliverEvent = (listener) => {
    if (!eventListeners.get(listener.subscriptionId)?.has(listener) || listener.inFlightEventId) return;
    const pending = coordinator.eventPending(listener.subscriptionId);
    if (!pending.ok) {
      writeMessage(listener.connection, pending);
      detachEventListener(listener);
      endConnection(listener.connection);
      return;
    }
    if (!pending.event) return;
    listener.inFlightEventId = pending.event.id;
    listener.lastEventAt = new Date().toISOString();
    writeMessage(listener.connection, {
      ok: true,
      type: 'event',
      subscriptionId: listener.subscriptionId,
      event: pending.event,
    });
  };

  const notifyEvent = (subscriptionId, metadata = {}) => {
    const listeners = eventListeners.get(String(subscriptionId));
    if (!listeners?.size) return;
    if (metadata.removed) {
      for (const listener of [...listeners]) {
        writeMessage(listener.connection, {
          ok: false,
          error: { code: 'event_subscription_removed', message: 'event subscription was removed' },
        });
        detachEventListener(listener);
        endConnection(listener.connection);
      }
      return;
    }
    if (metadata.expired) {
      for (const listener of [...listeners]) {
        writeMessage(listener.connection, {
          ok: false,
          error: {
            code: 'event_subscription_expired',
            message: 'event subscription wait deadline reached',
          },
        });
        detachEventListener(listener);
        endConnection(listener.connection);
      }
      return;
    }
    for (const listener of [...listeners]) deliverEvent(listener);
  };
  coordinator.setEventNotifier(notifyEvent);

  const attachEventListener = async (connection, request) => {
    const subscriptionId = String(request.subscriptionId || '');
    if (!eventBroker?.webhookSecret) {
      writeMessage(connection, {
        ok: false,
        error: { code: 'event_webhook_secret_unconfigured', message: 'webhook secret is not configured' },
      });
      endConnection(connection);
      return null;
    }
    // A listener that comes back after its orphaned subscription was archived
    // gets it back, pending events included.
    if (!eventBroker.getSubscriptionRecord(subscriptionId)) {
      await coordinator.reviveRetiredSubscription(subscriptionId);
    }
    if (connection.destroyed) return null;
    const details = coordinator.eventSubscriptionDetails(subscriptionId);
    if (!details.ok) {
      writeMessage(connection, details);
      endConnection(connection);
      return null;
    }
    const lease = coordinator.heartbeatEventListener(subscriptionId, {
      renew: request.renew !== false,
      leaseMs: request.leaseMs,
      agentId: request.agentId,
    });
    if (!lease.ok) {
      writeMessage(connection, lease);
      endConnection(connection);
      return null;
    }
    const listeners = eventListeners.get(subscriptionId);
    const effectiveSubscription = lease.subscription || details.subscription;
    if (listeners?.size && !effectiveSubscription.shared) {
      writeMessage(connection, {
        ok: false,
        error: { code: 'event_listener_already_attached', message: 'event subscription already has a listener' },
      });
      endConnection(connection);
      return null;
    }
    const listener = {
      connection,
      subscriptionId,
      once: request.once !== false,
      shared: effectiveSubscription.shared === true,
      agentId: request.agentId || 'anonymous-agent',
      inFlightEventId: null,
      connectedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      heartbeatCount: 0,
      lastEventAt: null,
      lastAckAt: null,
    };
    if (!listeners) eventListeners.set(subscriptionId, new Set());
    eventListeners.get(subscriptionId).add(listener);
    coordinator.noteListenerActivity(subscriptionId);
    writeMessage(connection, {
      ok: true,
      type: 'listening',
      subscription: effectiveSubscription,
    });
    deliverEvent(listener);
    return listener;
  };

  const handleEventListenerMessage = (listener, request) => {
    if (request.type === 'event-heartbeat') {
      const heartbeat = coordinator.heartbeatEventListener(listener.subscriptionId, {
        renew: request.renew !== false,
        leaseMs: request.leaseMs,
        agentId: listener.agentId,
      });
      if (!heartbeat.ok) {
        writeMessage(listener.connection, heartbeat);
        detachEventListener(listener);
        endConnection(listener.connection);
        return;
      }
      listener.lastHeartbeatAt = new Date().toISOString();
      listener.heartbeatCount += 1;
      coordinator.noteListenerActivity(listener.subscriptionId);
      coordinator.metrics.eventListenerHeartbeats += 1;
      writeMessage(listener.connection, {
        ok: true,
        type: 'heartbeat',
        subscription: heartbeat.subscription,
      });
      // A notifier can race with a restart or a socket transition.  The
      // heartbeat is also a durable replay point for a pending event.
      deliverEvent(listener);
      return;
    }
    if (request.type === 'event-ack') {
      if (String(request.eventId || '') !== listener.inFlightEventId) {
        writeMessage(listener.connection, {
          ok: false,
          error: { code: 'event_ack_mismatch', message: 'event acknowledgement does not match the pending event' },
        });
        detachEventListener(listener);
        endConnection(listener.connection);
        return;
      }
      const eventKey = `${listener.subscriptionId}:${request.eventId}`;
      const acknowledgement = coordinator.acknowledgeEvent(listener.subscriptionId, request.eventId);
      const details = coordinator.eventSubscriptionDetails(listener.subscriptionId);
      const currentSubscription = details.ok ? details.subscription : null;
      if (currentSubscription?.shared) listener.shared = true;
      const sharedDuplicateAcknowledgement = listener.shared
        && !acknowledgement.ok
        && acknowledgement.error?.code === 'event_not_pending'
        && sharedAcknowledgements.has(eventKey);
      if (!acknowledgement.ok && !sharedDuplicateAcknowledgement) {
        writeMessage(listener.connection, acknowledgement);
        detachEventListener(listener);
        endConnection(listener.connection);
        return;
      }
      if (listener.shared && acknowledgement.ok) {
        sharedAcknowledgements.add(eventKey);
        if (sharedAcknowledgements.size > 1_000) {
          sharedAcknowledgements.delete(sharedAcknowledgements.values().next().value);
        }
      }
      listener.inFlightEventId = null;
      listener.lastAckAt = new Date().toISOString();
      writeMessage(listener.connection, { ok: true, type: 'acked', eventId: request.eventId });
      if (listener.once) {
        detachEventListener(listener);
        endConnection(listener.connection);
        if (!listener.shared) coordinator.eventUnsubscribe(listener.subscriptionId);
      } else {
        deliverEvent(listener);
      }
      return;
    }
    if (request.type === 'event-unsubscribe') {
      coordinator.eventUnsubscribe(listener.subscriptionId);
      writeMessage(listener.connection, { ok: true, type: 'unsubscribed', subscriptionId: listener.subscriptionId });
      detachEventListener(listener);
      endConnection(listener.connection);
      return;
    }
    writeMessage(listener.connection, {
      ok: false,
      error: { code: 'unsupported_event_listener_request', message: 'unsupported event listener request' },
    });
    detachEventListener(listener);
    endConnection(listener.connection);
  };

  const expireStaleListeners = () => {
    const nowMs = Date.now();
    for (const listeners of eventListeners.values()) {
      for (const listener of [...listeners]) {
        const heartbeatAtMs = Date.parse(listener.lastHeartbeatAt || '');
        const eventAtMs = Date.parse(listener.lastEventAt || '');
        const heartbeatExpired = !Number.isFinite(heartbeatAtMs)
          || nowMs - heartbeatAtMs > EVENT_LISTENER_HEARTBEAT_TIMEOUT_MS;
        const acknowledgementExpired = listener.inFlightEventId
          && Number.isFinite(eventAtMs)
          && nowMs - eventAtMs > EVENT_LISTENER_ACK_TIMEOUT_MS;
        if (!heartbeatExpired && !acknowledgementExpired) continue;
        coordinator.metrics.eventListenerTimeouts += 1;
        writeMessage(listener.connection, {
          ok: false,
          error: {
            code: 'event_listener_closed',
            message: heartbeatExpired
              ? 'event listener heartbeat expired'
              : 'event listener acknowledgement expired',
          },
        });
        detachEventListener(listener);
        endConnection(listener.connection);
      }
    }
  };

  const server = createServer((connection) => {
    connections.add(connection);
    coordinator.metrics.socketConnections += 1;
    connection.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      // Listener sockets are intentionally long-lived. A regular RPC socket
      // must, however, either send its JSON line or disappear; otherwise a
      // client killed during startup leaves an FD around forever.
      if (!handled && !listener) closeIdleConnection(connection);
    });
    let buffer = '';
    const decodeChunk = createUtf8ChunkDecoder();
    let handled = false;
    let listener = null;
    connection.on('error', (error) => {
      if (!closingConnections.has(connection) && !expectedClientSocketErrors.has(error?.code)) {
        coordinator.metrics.socketErrors += 1;
      }
      // A supervisor disappearing must detach only its listener.  Without an
      // error handler ECONNRESET can terminate the whole coordinator process.
      detachConnectionListeners(connection, listener);
    });

    const handleRequest = (request) => {
      activeRequestCount += 1;
      let requestFinished = false;
      const finishRequest = () => {
        if (requestFinished) return;
        requestFinished = true;
        activeRequestCount = Math.max(0, activeRequestCount - 1);
      };

      try {
        if (listener) {
          handleEventListenerMessage(listener, request);
          finishRequest();
          return;
        }
        if (handled) {
          finishRequest();
          return;
        }
        handled = true;
        connection.setTimeout(0);
        if (request.type === 'event-listen') {
          eventBrokerReady.then(() => attachEventListener(connection, request)).then((attached) => {
            listener = attached;
            finishRequest();
          }, (error) => {
            closeConnectionAfterError(connection, error, listener);
            finishRequest();
          });
          return;
        }
        let result;
        if (request.type === 'ping') {
          result = Promise.resolve({ ok: true, status: coordinator.ping() });
        } else if (request.type === 'status') {
          // Compact status is a liveness snapshot and must answer while the
          // worker is still loading a large durable state. Full status is an
          // explicit diagnostic request and may wait for the broker.
          if (request.compact && request.waitForEventBroker !== true) {
            result = Promise.resolve({ ok: true, status: coordinator.status({ compact: true }) });
          } else if (request.compact) {
            // The event readiness barrier every `events listen` and reconnect
            // runs: it needs the broker attached, not the backlog. Serializing
            // the full status here (hundreds of subscriptions and pending
            // events per call) turned a reconnect storm into 3 s timeouts.
            result = eventBrokerReady.then(() => ({ ok: true, status: coordinator.status({ compact: true }) }));
          } else {
            result = eventBrokerReady.then(() => new Promise((resolvePromise) => {
              setImmediate(() => resolvePromise({
                ok: true,
                status: coordinator.status({ compact: false }),
              }));
            }));
          }
        } else if (request.type === 'shutdown') {
          result = Promise.resolve({ ok: true });
        } else if (request.type === 'cancellation-details') {
          result = Promise.resolve(coordinator.getPendingCancellation(request.requestId));
        } else if (request.type === 'confirm-cancellation') {
          result = coordinator.confirmCancellation(request.requestId, request.confirmation);
        } else if (request.type === 'events-subscribe') {
          result = eventBrokerReady.then(() => coordinator.eventSubscription(request.spec));
        } else if (request.type === 'events-status') {
          result = eventBrokerReady.then(() => coordinator.eventSubscriptions(request.options || {}));
        } else if (request.type === 'events-summary') {
          result = eventBrokerReady.then(() => coordinator.eventSubscriptionSummary(request.options || {}));
        } else if (request.type === 'events-audit') {
          result = eventBrokerReady.then(() => coordinator.eventAudit(request.options || {}));
        } else if (request.type === 'events-gc') {
          result = eventBrokerReady.then(() => coordinator.eventGarbageCollect(request.options || {}));
        } else if (request.type === 'events-subscription') {
          result = eventBrokerReady.then(() => coordinator.eventSubscriptionDetails(request.subscriptionId));
        } else if (request.type === 'events-subscription-target') {
          result = eventBrokerReady.then(() => coordinator.eventSubscriptionTarget(request.options || {}));
        } else if (request.type === 'events-unsubscribe') {
          result = eventBrokerReady.then(() => coordinator.eventUnsubscribe(request.subscriptionId, {
            agentId: request.agentId || null,
          }));
        } else if (request.type === 'events-renew') {
          result = eventBrokerReady.then(() => coordinator.renewEventSubscription(request.subscriptionId, request.options || {}));
        } else if (request.type === 'events-webhook') {
          result = eventBrokerReady.then(() => coordinator.ingestWebhook(request));
        } else if (request.type === 'events-revive') {
          result = eventBrokerReady.then(async () => {
            await coordinator.reviveRetiredSubscription(request.subscriptionId);
            return coordinator.eventSubscriptionDetails(request.subscriptionId);
          });
        } else if (request.type === 'events-reconcile') {
          result = eventBrokerReady.then(() => coordinator.reconcileEvents(request.subscriptionId));
        } else if (request.type === 'api' || request.type === 'exec') {
          result = coordinator.submit(request);
        } else {
          result = Promise.resolve({ ok: false, error: { code: 'unsupported_request_type' } });
        }
        Promise.resolve(result).then((response) => {
          try {
            writeMessage(connection, response);
            endConnection(connection);
            if (request.type === 'shutdown') setTimeout(terminate, 10);
          } catch (error) {
            closeConnectionAfterError(connection, error, listener);
          } finally {
            finishRequest();
          }
        }, (error) => {
          try {
            writeMessage(connection, { ok: false, error: clientErrorDetails(error) });
            endConnection(connection);
          } catch (closeError) {
            logStructuredError('client_connection_close_failed', closeError);
            destroyConnection(connection);
          } finally {
            finishRequest();
          }
        });
      } catch (error) {
        finishRequest();
        closeConnectionAfterError(connection, error, listener);
      }
    };

    connection.on('data', (chunk) => {
      try {
        buffer += decodeChunk(chunk);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let request;
          try {
            request = JSON.parse(line);
          } catch (error) {
            writeMessage(connection, { ok: false, error: { code: 'invalid_request', message: error.message } });
            endConnection(connection);
            return;
          }
          handleRequest(request);
        }
      } catch (error) {
        closeConnectionAfterError(connection, error, listener);
      }
    });
    connection.on('close', () => {
      coordinator.metrics.socketDisconnects += 1;
      connections.delete(connection);
      closingConnections.delete(connection);
      detachConnectionListeners(connection, listener);
    });
    connection.on('end', () => {
      // A listener supervisor can close its half of the socket without
      // producing an error. Detach it immediately so the next status cannot
      // report a dead listener during the close-event turn.
      detachConnectionListeners(connection, listener);
      listener = null;
    });
  });

  let terminating = false;
  let stopSourceWatcher = () => {};
  terminate = (exitCode = 0) => {
    if (terminating) {
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }
    terminating = true;
    if (expirationTimer) clearInterval(expirationTimer);
    if (listenerHeartbeatTimer) clearInterval(listenerHeartbeatTimer);
    if (orphanRetirementTimer) clearInterval(orphanRetirementTimer);
    if (eventSweepTimer) clearInterval(eventSweepTimer);
    if (firstSweepTimer) clearTimeout(firstSweepTimer);
    if (scheduledGcTimer) clearInterval(scheduledGcTimer);
    if (firstGcTimer) clearTimeout(firstGcTimer);
    if (socketEndpointTimer) clearInterval(socketEndpointTimer);
    if (coordinator.scheduledGcBootstrapTimer) clearImmediate(coordinator.scheduledGcBootstrapTimer);
    for (const { timer } of coordinator.mergeabilityRecheckTimers.values()) clearTimeout(timer);
    coordinator.mergeabilityRecheckTimers.clear();
    eventBrokerLoader.worker.terminate().catch(() => {});
    for (const listeners of eventListeners.values()) {
      for (const listener of listeners) {
        writeMessage(listener.connection, {
          ok: false,
          error: { code: 'event_listener_closed', message: 'coordinator is restarting' },
        });
        endConnection(listener.connection);
      }
    }
    eventListeners.clear();
    stopSourceWatcher();
    try {
      eventBroker?.flush?.();
    } catch (error) {
      logStructuredError('event_state_flush_failed', error, { identity });
    }
    const finish = () => {
      cleanUp();
      process.exit(exitCode);
    };
    // libuv unlinks a Unix server's path when the handle closes. If the path
    // is no longer the inode this process bound, closing would delete the
    // socket of whichever coordinator replaced it: that one would keep
    // running, healthy by PID, with no endpoint (ENOENT for every client).
    if (boundSocketInode !== null && socketEndpointVerdict(socket, boundSocketInode) !== 'ok') {
      socketEndpointLost = true;
    }
    try {
      // Do not wait for a half-closed listener or an idle RPC connection. A
      // source reload must hand the owner lock to launchd as one operation;
      // waiting for server.close() lets a busy/rejected event loop keep the
      // old process alive without a usable control plane.
      for (const connection of connections) destroyConnection(connection);
      server.closeAllConnections?.();
      if (!socketEndpointLost) server.close();
    } catch (error) {
      logStructuredError('server_close_failed', error);
    }
    finish();
  };

  eventBrokerReady.catch((error) => {
    logStructuredError('event_state_load_failed', error, { identity });
    setImmediate(() => terminate(1));
  });

  const cleanUp = () => {
    if (ownsCoordinatorLock(ownerLock)) {
      // A lost endpoint may already belong to another process: never unlink it.
      releaseCoordinatorOwner(ownerLock, { removeSocket: !socketEndpointLost });
      try { unlinkSync(`${socket}.start`); } catch { /* no start lock */ }
    } else {
      releaseCoordinatorOwner(ownerLock);
    }
  };
  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') coordinator.metrics.socketErrors += 1;
    releaseCoordinatorOwner(ownerLock);
    if (error.code !== 'EADDRINUSE') process.stderr.write(`github-coordinator: ${error.message}\n`);
    process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
  });
  server.on('listening', () => {
    try { chmodSync(socket, 0o600); } catch { /* best effort */ }
    try { unlinkSync(`${socket}.start`); } catch { /* no start lock */ }
    // A live process whose socket file was unlinked or replaced answers no
    // client (ENOENT/ECONNREFUSED) while every liveness check on the PID stays
    // green. Hand the identity back to launchd instead of serving a ghost.
    try { boundSocketInode = statSync(socket).ino; } catch { /* checked below */ }
    socketEndpointTimer = setInterval(() => {
      const verdict = socketEndpointVerdict(socket, boundSocketInode);
      if (verdict === 'ok') return;
      socketEndpointLost = true;
      logStructuredError('socket_endpoint_lost', new Error(`coordinator socket ${verdict}`), {
        identity,
        pid: process.pid,
      });
      terminate(1);
    }, SOCKET_ENDPOINT_CHECK_MS);
    socketEndpointTimer.unref?.();
    // The first orphan inspection is strictly post-listen. Status and ping
    // stay independent of this diagnostic, even while the worker-backed
    // broker is attaching a large persisted snapshot.
    eventBrokerReady.then(() => {
      if (!terminating) coordinator.ensureScheduledEventGarbageCollection();
    }).catch(() => {});
  });
  server.on('close', cleanUp);
  process.on('SIGTERM', () => terminate(0));
  process.on('SIGINT', () => terminate(0));

  expirationTimer = setInterval(() => {
    try {
      coordinator.expireEventSubscriptions();
    } catch (error) {
      process.stderr.write(`github-coordinator: event expiration failed: ${error.message}\n`);
    }
  }, 1_000);
  expirationTimer.unref?.();

  listenerHeartbeatTimer = setInterval(expireStaleListeners, 60_000);
  listenerHeartbeatTimer.unref?.();

  orphanRetirementTimer = setInterval(() => {
    try {
      // The orphan report behind the health alert is otherwise an hour old:
      // refresh it as soon as the archive changed what it would count.
      if (coordinator.retireOrphanedSubscriptions().length > 0) runScheduledGc();
    } catch (error) {
      logStructuredError('event_orphan_retirement_failed', error, { identity });
    }
  }, ORPHAN_RETIRE_INTERVAL_MS);
  orphanRetirementTimer.unref?.();

  let sweepRunning = false;
  const runEventSweep = () => {
    if (!eventBroker || sweepRunning) return;
    // Never let the best-effort recovery sweep compete with the durable
    // event-driven path.  A pending backlog means listeners need the control
    // plane first; an active foreground RPC means a client is already using
    // it.  The explicit events reconcile command remains available for the
    // one-shot webhook-missing case and does not mutate unrelated state.
    if (coordinator.pendingBacklogNeedsControlPlane()) return;
    if (activeRequestCount > 0 || coordinator.active > 0) return;
    sweepRunning = true;
    coordinator.reconcileStaleSubscriptions()
      .catch((error) => logStructuredError('event_sweep_failed', error))
      .finally(() => { sweepRunning = false; });
  };

  const runScheduledGc = () => {
    if (coordinator.scheduledGcBootstrapInProgress) return;
    coordinator.scheduledGcBootstrapInProgress = true;
    try {
      coordinator.scheduledEventGarbageCollectionAsync()
        .catch((error) => logStructuredError('event_scheduled_gc_failed', error))
        .finally(() => {
          coordinator.scheduledGcBootstrapInProgress = false;
        });
    } catch (error) {
      coordinator.scheduledGcBootstrapInProgress = false;
      logStructuredError('event_scheduled_gc_failed', error);
    }
  };
  let eventTasksStarted = false;
  const startEventBackgroundTasks = () => {
    if (eventTasksStarted || terminating || !eventBroker) return;
    eventTasksStarted = true;
    firstSweepTimer = setTimeout(() => {
      firstSweepTimer = null;
      runEventSweep();
    }, 30_000);
    firstSweepTimer.unref?.();
    eventSweepTimer = setInterval(runEventSweep, EVENT_SWEEP_INTERVAL_MS);
    eventSweepTimer.unref?.();
    firstGcTimer = setTimeout(() => {
      firstGcTimer = null;
      runScheduledGc();
    }, 5 * 60_000);
    firstGcTimer.unref?.();
    scheduledGcTimer = setInterval(runScheduledGc, SCHEDULED_GC_INTERVAL_MS);
    scheduledGcTimer.unref?.();
  };
  eventBrokerReady.then(startEventBackgroundTasks).catch(() => {});

  stopSourceWatcher = installSourceReloadWatcher(() => {
    coordinator.metrics.sourceReloads += 1;
    terminate();
  }, {
    // A source reload must not close the Unix socket while the background
    // reconciliation or the worker state load is still active. Count both as
    // active work so launchd gets a clean handoff only after the event-driven
    // recovery attempt has settled and the broker can be attached safely.
    getActiveRequests: () => activeRequestCount
      + (sweepRunning ? 1 : 0)
      + (coordinator.eventBrokerLoading ? 1 : 0),
  });

  installProcessSafetyHandlers(terminate);

  server.listen(socket);
}

function parseIdentity(argv) {
  const index = argv.findIndex((value) => value === '--identity');
  return normalizeIdentity(index >= 0 ? argv[index + 1] : process.env.FRONTALIERE_GH_IDENTITY || 'default');
}

const command = process.argv[2];
if (command === 'serve') {
  try {
    readTokenAndStart(parseIdentity(process.argv.slice(3)));
  } catch (error) {
    process.stderr.write(`github-coordinator: ${error.message}\n`);
    process.exitCode = 1;
  }
}
