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
import { createServer } from 'node:net';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
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
  shaMatches,
  workflowSelectorMatchesRun,
} from './github-event-broker.mjs';
import { assertEventIdentity, hasEventRoute } from './github-event-routing.mjs';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const COORDINATOR_PROTOCOL_VERSION = 5;
const DEFAULT_API_VERSION = process.env.FRONTALIERE_GITHUB_API_VERSION || '2022-11-28';
const configuredMaxInFlight = Number(process.env.FRONTALIERE_GH_MAX_IN_FLIGHT || 8);
const MAX_IN_FLIGHT = Number.isFinite(configuredMaxInFlight)
  ? Math.max(1, Math.floor(configuredMaxInFlight))
  : 8;
const HEADROOM_CONCURRENCY_STEPS = [
  { ratio: 0.30, max: 6 },
  { ratio: 0.15, max: 4 },
  { ratio: 0.05, max: 2 },
];
const MAX_API_ATTEMPTS = 3;
const MUTATION_GAP_MS = 1_000;
const CLI_CACHE_TTL_MS = 15_000;
const ANONYMOUS_BUDGET = 45;
const ANONYMOUS_WINDOW_MS = 60 * 60 * 1_000;
const CANCELLATION_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_CACHE_TTL_MS = 60_000;
const configuredMaxBodyBytes = Number(process.env.FRONTALIERE_GH_MAX_BODY_BYTES || 0);
const MAX_BODY_BYTES = Number.isFinite(configuredMaxBodyBytes) && configuredMaxBodyBytes >= 1024
  ? Math.floor(configuredMaxBodyBytes)
  : 8 * 1024 * 1024;
// The persistent services have exactly these two identities.  Other names are
// used by isolated coordinator unit fixtures and do not represent a production
// receiver/token route; they remain deliberately unbound here.
const EVENT_ROUTING_IDENTITIES = new Set(['default', 'nanako']);

export const EVENT_SWEEP_INTERVAL_MS = 2 * 60 * 1_000;
export const EVENT_SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1_000;
export const EVENT_SWEEP_MAX_PER_RUN = 10;
export const DEFAULT_SCHEDULED_GC_AGE_MS = 60 * 60 * 1_000;
export const SCHEDULED_GC_INTERVAL_MS = 60 * 60 * 1_000;

function reconcilableSubscription(subscription) {
  if (subscription.resource === 'pull_request') return Boolean(subscription.number);
  if (subscription.resource === 'workflow_run') return Boolean(subscription.runId);
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

export const WATCHED_SOURCE_NAMES = new Set([
  'github-coordinator-client.mjs',
  'github-coordinator.mjs',
  'github-event-broker.mjs',
  'github-event-routing.mjs',
  'github-coordinator-launcher',
]);

function describeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: typeof error, message: String(error) };
}

function logStructuredError(event, error, details = {}) {
  try {
    process.stderr.write(`${JSON.stringify({
      component: 'github-coordinator',
      event,
      error: describeError(error),
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
    throw error;
  }
}

function claimCoordinatorOwner(identity, socket) {
  const lockPath = coordinatorOwnerLockPath(identity);
  const existing = readOwnerRecord(lockPath);
  if (existing && processIsAlive(existing.pid)) return null;
  if (existing) unlinkSync(lockPath);
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify({
      pid: process.pid,
      identity,
      socket,
      startedAt: new Date().toISOString(),
    })}\n`);
    return { fd, lockPath, socket };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const competing = readOwnerRecord(lockPath);
    if (competing && processIsAlive(competing.pid)) return null;
    if (competing) unlinkSync(lockPath);
    return claimCoordinatorOwner(identity, socket);
  }
}

function ownsCoordinatorLock(ownerLock) {
  if (!ownerLock) return false;
  try {
    return readOwnerRecord(ownerLock.lockPath)?.pid === process.pid;
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

function installSourceReloadWatcher(onReload, { getActiveRequests = () => 0 } = {}) {
  let triggered = false;
  let watcher;
  let scheduler;
  const triggerReload = () => {
    if (triggered) return;
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
      if (triggered || !WATCHED_SOURCE_NAMES.has(name)) return;
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

function workflowFilenameMap(data) {
  const result = new Map();
  for (const workflow of Array.isArray(data?.workflows) ? data.workflows : []) {
    const name = typeof workflow?.name === 'string' ? workflow.name.trim() : '';
    if (!name) continue;
    for (const candidate of [workflow.path, workflow.file_name, workflow.filename]) {
      const filename = workflowFilename(candidate);
      if (filename) result.set(filename, name);
    }
  }
  return result;
}

function cacheKeyFor(request) {
  return `${request.identity || 'default'}|${request.anonymous ? 'anonymous' : 'authenticated'}|${String(request.method || 'GET').toUpperCase()}|${request.path}|${request.body || ''}`;
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
    if (value === '--repo' && args[index + 1]) return String(args[index + 1]);
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

function fieldValue(raw, typed) {
  if (!typed) return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw);
  try { return JSON.parse(raw); } catch { return raw; }
}

function splitField(raw, typed) {
  const separator = raw.indexOf('=');
  if (separator <= 0) return null;
  return { name: raw.slice(0, separator), value: fieldValue(raw.slice(separator + 1), typed) };
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
  const isGraphql = endpoint === 'graphql';
  const normalizedMethod = String(method || (isGraphql ? 'POST' : fields.length ? 'GET' : 'GET')).toUpperCase();
  let path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const data = Object.fromEntries(fields.map(({ name, value }) => [name, value]));
  let body;
  if (isGraphql) {
    if (normalizedMethod !== 'POST' || typeof data.query !== 'string') return null;
    body = data;
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

function renderGhApiResponse(pages, parsed) {
  const bodies = pages.map((page) => page.body || '');
  let output;
  if (parsed.jq) {
    if (parsed.slurp) {
      let values;
      try { values = bodies.map((body) => JSON.parse(body)); } catch { return { ok: false, error: 'cannot slurp non-JSON response' }; }
      const rendered = renderJq(`${JSON.stringify(values)}\n`, parsed.jq);
      if (!rendered.ok) return rendered;
      output = rendered.output;
    } else {
      const rendered = bodies.map((body) => renderJq(body, parsed.jq));
      const failed = rendered.find((item) => !item.ok);
      if (failed) return failed;
      output = rendered.map((item) => item.output).join('');
    }
  } else if (parsed.slurp) {
    try { output = `${JSON.stringify(bodies.map((body) => JSON.parse(body)))}\n`; }
    catch { return { ok: false, error: 'cannot slurp non-JSON response' }; }
  } else {
    output = bodies.map((body) => (body.endsWith('\n') ? body : `${body}\n`)).join('');
  }

  if (parsed.include && !parsed.silent) {
    const first = pages[0];
    const headerLines = [`HTTP/2 ${first.status}`];
    for (const [name, value] of Object.entries(first.headers || {})) headerLines.push(`${name}: ${value}`);
    output = `${headerLines.join('\n')}\n\n${output}`;
  }
  return { ok: true, output: parsed.silent ? '' : output };
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
    this.eventNotifier = null;
    this.eventListenerInspector = null;
    this.eventListenerCountInspector = null;
    this.eventListenerInfoInspector = null;
    this.queue = [];
    this.active = 0;
    this.activeMutations = 0;
    this.lastMutationAt = 0;
    this.pendingGets = new Map();
    this.pendingCli = new Map();
    this.cache = new Map();
    this.cliCache = new Map();
    this.workflowFilenameCache = new Map();
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
      eventListenerHeartbeats: 0,
      eventListenerTimeouts: 0,
      sourceReloads: 0,
      eventSweepReconciliations: 0,
      eventSweepDeliveries: 0,
      eventSweepErrors: 0,
      eventScheduledGcRuns: 0,
    };
    this.sweepReconciledAt = new Map();
    this.lastScheduledGc = null;
    this.scheduledGcBootstrapAttempted = false;
    this.scheduledGcBootstrapInProgress = false;
  }

  status({ compact = false } = {}) {
    this.resetAnonymousBudget();
    this.prunePendingCancellations();
    this.ensureScheduledEventGarbageCollection();
    const eventSummary = this.eventBroker ? (() => {
      const summary = this.eventBroker.summary({
        listenerAttached: this.eventListenerInspector,
        listenerInfo: this.eventListenerInfoInspector,
        includePendingDetails: !compact,
      });
      const signatureFailures = Number(this.eventBroker.metrics.webhookSignatureFailures || 0);
      if (compact && signatureFailures === 0 && summary.metrics) {
        const {
          webhookSignatureFailures: _webhookSignatureFailures,
          lastWebhookSignatureFailureAt: _lastWebhookSignatureFailureAt,
          ...metrics
        } = summary.metrics;
        summary.metrics = metrics;
      }
      return {
        enabled: Boolean(this.eventBroker.webhookSecret),
        webhookSecretConfigured: Boolean(this.eventBroker.webhookSecret),
        activeListeners: this.eventListenerCountInspector?.() ?? null,
        listenerHeartbeatMetrics: {
          heartbeats: this.metrics.eventListenerHeartbeats,
          timeouts: this.metrics.eventListenerTimeouts,
        },
        ...summary,
        scheduledGc: scheduledGcView(this.lastScheduledGc, compact),
        ...(compact && signatureFailures === 0
          ? {}
          : {
            webhookSignatureFailures: signatureFailures,
            lastWebhookSignatureFailureAt: this.eventBroker.metrics.lastWebhookSignatureFailureAt,
          }),
      };
    })() : { enabled: false };
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
        cacheEntries: this.cache.size,
        cliCacheEntries: this.cliCache.size,
        events: eventSummary,
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
      cacheEntries: this.cache.size,
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
        : { enabled: false },
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
    try {
      // This is a local, dry-run inspection only. Pending events remain
      // protected and no GitHub/network operation is performed.
      this.scheduledEventGarbageCollection();
    } catch (error) {
      // A first status probe must stay useful even if the local persisted
      // state is temporarily unreadable; the normal scheduled timer retries.
      logStructuredError('event_initial_gc_failed', error);
    } finally {
      this.scheduledGcBootstrapInProgress = false;
    }
  }

  setEventListenerCountInspector(inspector) {
    this.eventListenerCountInspector = typeof inspector === 'function' ? inspector : null;
  }

  setEventListenerInfoInspector(inspector) {
    this.eventListenerInfoInspector = typeof inspector === 'function' ? inspector : null;
  }

  async resolveWorkflowFilename(repo, workflow) {
    const filename = workflowFilename(workflow);
    if (!filename || typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return workflow;
    let cached = this.workflowFilenameCache.get(repo);
    if (!cached) {
      cached = this.submit({
        type: 'api',
        identity: this.identity,
        method: 'GET',
        path: `/repos/${repo}/actions/workflows?per_page=100`,
        cacheTtlMs: 0,
      }).then((response) => {
        if (!response.ok) return new Map();
        try { return workflowFilenameMap(JSON.parse(response.body || 'null')); } catch { return new Map(); }
      }).catch(() => new Map());
      this.workflowFilenameCache.set(repo, cached);
    }
    const names = await cached;
    return names.get(filename) || workflow;
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
    const createdSubscription = this.eventBroker.subscribe(normalizedSpec);
    let reconciliation = null;
    if (!createdSubscription.sharedJoin && createdSubscription.remainingMs > 1_000) {
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

  eventUnsubscribe(subscriptionId) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    const result = this.eventBroker.unsubscribe(subscriptionId);
    this.eventNotifier?.(String(subscriptionId), { removed: true });
    return result;
  }

  eventSubscriptionDetails(subscriptionId) {
    if (!this.eventBroker) throw new Error('event_broker_unavailable');
    const subscription = this.eventBroker.getSubscriptionRecord(subscriptionId);
    if (!subscription) {
      return {
        ok: false,
        error: { code: 'event_subscription_not_found', message: 'event subscription not found' },
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
    const result = this.eventBroker.ingestWebhook(request, {
      beforePersist: (payload) => {
        const spec = { repo: payload?.repository?.full_name };
        if (eventRoutingRequired(this.identity, spec)) {
          assertEventIdentity({ spec, actualIdentity: this.identity, operation: 'webhook' });
        }
      },
    });
    for (const subscriptionId of result.matchedSubscriptionIds || []) {
      this.eventNotifier?.(subscriptionId);
    }
    return result;
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

  expireEventSubscriptions() {
    if (!this.eventBroker) return [];
    const expiredIds = this.eventBroker.expireSubscriptions();
    for (const subscriptionId of expiredIds) {
      this.eventNotifier?.(subscriptionId, { expired: true });
    }
    if (this.eventListenerInspector) {
      const garbageCollection = this.eventBroker.garbageCollect({
        listenerAttached: this.eventListenerInspector,
        apply: true,
      });
      for (const subscriptionId of garbageCollection.removedIds || []) {
        this.eventNotifier?.(subscriptionId, { removed: true });
      }
    }
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
    const due = [...this.eventBroker.state.subscriptions]
      .filter((subscription) => subscription
        && subscription.pending.length === 0
        && reconcilableSubscription(subscription)
        && (!eventRoutingRequired(this.identity, subscription) || routeAllowsIdentity(subscription, this.identity))
        && nowMs - (this.sweepReconciledAt.get(subscription.id) ?? 0) >= minIntervalMs)
      .sort((left, right) => (this.sweepReconciledAt.get(left.id) ?? 0) - (this.sweepReconciledAt.get(right.id) ?? 0))
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
    this.metrics.eventScheduledGcRuns += 1;
    this.lastScheduledGc = {
      at: new Date(nowMs).toISOString(),
      olderThanMs,
      orphanCandidateCount: report.candidateCount,
      orphanCandidateIds: report.candidates.map(({ id }) => id),
      orphanedWithPending,
      orphanedWithPendingSubscriptionCount: orphanedWithPending.length,
      orphanedWithPendingEventCount: orphanedWithPending.reduce(
        (total, subscription) => total + Number(subscription.pendingCount || 1),
        0,
      ),
      orphanedWithPendingOldestAt: orphanedWithPending
        .map(({ pendingSince }) => pendingSince)
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null,
      nextAction: 'reattach_or_explicit_ack',
    };
    if (report.candidateCount > 0 || orphanedWithPending.length > 0) {
      logStructuredError('event_gc_orphans_detected', new Error('orphaned event subscriptions'), {
        identity: this.identity,
        orphanCandidateCount: report.candidateCount,
        orphanedWithPendingSubscriptionCount: orphanedWithPending.length,
        orphanedWithPendingEventCount: orphanedWithPending.reduce(
          (total, subscription) => total + Number(subscription.pendingCount || 1),
          0,
        ),
        orphanedWithPendingOldestAt: this.lastScheduledGc.orphanedWithPendingOldestAt,
        nextAction: 'reattach_or_explicit_ack',
      });
    }
    return this.lastScheduledGc;
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
    if (subscription.resource === 'pull_request' && subscription.number) {
      path = `/repos/${subscription.repo}/pulls/${subscription.number}`;
    } else if (subscription.resource === 'workflow_run' && subscription.runId) {
      path = `/repos/${subscription.repo}/actions/runs/${subscription.runId}`;
    } else if (subscription.resource === 'workflow_run'
      && (subscription.workflow || subscription.branch || subscription.sha || subscription.followLatest)) {
      const query = new URLSearchParams({ per_page: '20' });
      if (subscription.branch) query.set('branch', subscription.branch);
      path = `/repos/${subscription.repo}/actions/runs?${query.toString()}`;
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

    const response = await this.submit({
      type: 'api',
      identity: this.identity,
      method: 'GET',
      path,
      cacheTtlMs: 0,
    });
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
      data = runs.find((run) => (
        workflowSelectorMatchesRun(run, subscription.workflow)
        && (!subscription.sha || shaMatches(run.head_sha, subscription.sha))
        && (!subscription.branch || run.head_branch === subscription.branch)
      )) || null;
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
        per_page: '100',
      });
      const runsResponse = await this.submit({
        type: 'api',
        identity: this.identity,
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
    const isGet = queuedRequest.type === 'api' && isSafeRead(queuedRequest.method);
    const key = isGet ? scopedCacheKeyFor(queuedRequest) : null;
    const isReadCli = queuedRequest.type === 'exec'
      && !cliCommandIsMutation(queuedRequest.args || [])
      && !cliCommandWritesLocalOutput(queuedRequest.args || []);
    const cliKey = isReadCli ? cliCacheKeyFor(queuedRequest) : null;
    const cachedCli = cliKey ? this.cliCache.get(cliKey) : null;
    if (cachedCli && cachedCli.expiresAt > Date.now()) {
      this.metrics.cliCacheHits += 1;
      return Promise.resolve({ ...cachedCli.response, fromCache: true });
    }
    if (cachedCli) this.cliCache.delete(cliKey);
    const existing = key
      ? this.pendingGets.get(key)
      : cliKey ? this.pendingCli.get(cliKey) : null;
    if (existing) return existing;

    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.queue.push({ request: queuedRequest, resolve: resolvePromise, reject: rejectPromise, attempts: 0, key, cliKey });
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
      promise.then((response) => {
        if (response?.ok && !response.stdoutFile) {
          this.cliCache.set(cliKey, {
            response,
            expiresAt: Date.now() + CLI_CACHE_TTL_MS,
          });
        }
      }).catch(() => {});
    }
    if (queuedRequest.type === 'api' && !isGet || queuedRequest.type === 'exec' && !isReadCli) {
      this.cache.clear();
      this.cliCache.clear();
    }
    return promise;
  }

  enqueueAgain(job, delayMs) {
    setTimeout(() => {
      this.queue.unshift(job);
      this.pump();
    }, Math.max(0, delayMs));
  }

  jobBucket(job) {
    const bucket = job.request.type === 'api'
      ? (job.request.bucket || classifyBucket(job.request.path, job.request.method))
      : classifyCliBucket(job.request.args || []);
    return job.request.anonymous ? `${bucket}-anonymous` : bucket;
  }

  jobIsMutation(job) {
    if (job.request.type === 'api') return !isSafeRead(job.request.method);
    return cliCommandIsMutation(job.request.args || []);
  }

  nextRunnableJob() {
    const now = Date.now();
    for (let index = 0; index < this.queue.length; index += 1) {
      const job = this.queue[index];
      const bucket = this.jobBucket(job);
      if ((this.bucketPausedUntil.get(bucket) || 0) > now) continue;
      const mutation = this.jobIsMutation(job);
      if (mutation && this.activeMutations > 0) continue;
      if (mutation && now < this.lastMutationAt + MUTATION_GAP_MS) continue;
      this.queue.splice(index, 1);
      return job;
    }
    return null;
  }

  pump() {
    while (this.active < this.effectiveMaxInFlight()) {
      const job = this.nextRunnableJob();
      if (!job) {
        this.scheduleNextWake();
        break;
      }
      this.active += 1;
      if (this.jobIsMutation(job)) this.activeMutations += 1;
      this.run(job).catch((error) => job.reject(error)).finally(() => {
        this.active -= 1;
        if (this.jobIsMutation(job)) {
          this.activeMutations -= 1;
          this.lastMutationAt = Date.now();
          this.cache.clear();
          this.cliCache.clear();
        }
        this.pump();
      });
    }
  }

  scheduleNextWake() {
    if (this.wakeTimer || this.queue.length === 0) return;
    const now = Date.now();
    let nextAt = Infinity;
    for (const job of this.queue) {
      const bucketAt = this.bucketPausedUntil.get(this.jobBucket(job)) || 0;
      let availableAt = Math.max(now, bucketAt);
      if (this.jobIsMutation(job)) {
        if (this.activeMutations > 0) continue;
        availableAt = Math.max(availableAt, this.lastMutationAt + MUTATION_GAP_MS);
      }
      nextAt = Math.min(nextAt, availableAt);
    }
    if (!Number.isFinite(nextAt) || nextAt <= now) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.pump();
    }, nextAt - now);
  }

  async run(job) {
    try {
      let response = job.request.type === 'api'
        ? await this.executeApi(job.request)
        : await this.executeCli(job.request);
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
          this.enqueueAgain(job, delayMs);
          return;
        }
      }
      job.resolve(response);
    } catch (error) {
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
    const cacheable = isSafeRead(method) && ttl > 0;
    const cached = cacheable ? this.cache.get(key) : null;
    if (cached && cached.expiresAt > Date.now()) {
      this.metrics.cacheHits += 1;
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
    this.metrics.networkRequests += 1;
    if (request.anonymous) this.metrics.anonymousRequests += 1;
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
      cached.expiresAt = Date.now() + ttl;
      cached.headers = { ...cached.headers, ...responseHeaders };
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
    if (cacheable && response.ok) {
      this.cache.set(key, {
        status: response.status,
        headers: renderedHeaders,
        body,
        expiresAt: Date.now() + ttl,
      });
    }
    return result;
  }

  async executeCli(request) {
    this.metrics.cliCommands += 1;
    const args = Array.isArray(request.args) ? request.args.map(String) : [];
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

    return new Promise((resolvePromise) => {
      const child = spawn(this.realGh, args, {
        cwd: safeCwd(request.cwd),
        env: {
          ...process.env,
          GH_TOKEN: this.token,
          GH_HOST: 'github.com',
          GH_PAGER: 'cat',
          FRONTALIERE_GH_BROKER_ACTIVE: '1',
        },
        // stdin is never fed by the client protocol: an open pipe makes any
        // `--input -` / `--body-file -` hang forever and block the queue.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (error) => resolvePromise({
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: `${error.message}\n`,
      }));
      child.on('close', (exitCode, signal) => {
        const outBuffer = Buffer.concat(stdout);
        const out = outBuffer.toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
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
    for (let page = 0; page < (parsed.paginate ? 1_000 : 1); page += 1) {
      const response = await this.executeApi({
        type: 'api',
        identity: this.identity,
        method: parsed.method,
        path,
        headers: parsed.headers,
        body: parsed.body,
        anonymous,
        cacheTtlMs: isSafeRead(parsed.method) ? DEFAULT_CACHE_TTL_MS : 0,
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
    const parsed = parseGhApiArguments(args);
    return parsed ? classifyBucket(parsed.path, parsed.method) : 'core';
  }
  return 'core';
}

function cliCommandIsMutation(args) {
  if (cancellationRequestDetails({ type: 'exec', args })) return true;
  if (args[0] === 'api') {
    const parsed = parseGhApiArguments(args);
    return parsed ? !isSafeRead(parsed.method) : args.some((value) => value === '--method' || value === '-X' || value.startsWith('--method='));
  }
  if (args[0] === 'graphql') return args.includes('--field') || args.includes('-f') || args.includes('--raw-field');
  const readOnly = new Set(['list', 'view', 'status', 'diff', 'checks', 'log']);
  return !readOnly.has(args[1]) && !cliCommandWritesLocalOutput(args);
}

// `gh run download` / `gh release download` only READ from GitHub, but their
// result is the files they write under the caller's cwd. Treating them as a
// mutation parked every write of the workspace behind a 240 MB artifact for
// ~19.5 minutes (nextRunnableJob skips mutations while one is active). They
// are not cacheable either: a cached `ok` would report a download that wrote
// nothing, so they bypass the CLI cache and the in-flight dedup.
function cliCommandWritesLocalOutput(args) {
  return args[1] === 'download' && (args[0] === 'run' || args[0] === 'release');
}

function readTokenAndStart(identity) {
  const socket = socketPath(identity);
  const parent = dirname(socket);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try { chmodSync(parent, 0o700); } catch { /* best effort */ }
  const ownerLock = claimCoordinatorOwner(identity, socket);
  if (!ownerLock) return;

  const realGh = resolveRealGh();
  const token = resolveToken(identity, realGh);

  const eventBroker = new GitHubEventBroker({
    stateFile: eventStatePath(identity),
    legacyStateFile: legacyEventStatePath(identity),
    webhookSecret: process.env.FRONTALIERE_GH_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET,
  });
  const coordinator = new GitHubCoordinator({ identity, token, realGh, socket, eventBroker });
  let terminate = () => {};
  let expirationTimer = null;
  let listenerHeartbeatTimer = null;
  let eventSweepTimer = null;
  let scheduledGcTimer = null;
  const eventListeners = new Map();
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
  coordinator.setEventListenerInspector((subscriptionId) => (eventListeners.get(String(subscriptionId))?.size || 0) > 0);
  coordinator.setEventListenerCountInspector(
    () => [...eventListeners.values()].reduce((total, listeners) => total + listeners.size, 0),
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

  const attachEventListener = (connection, request) => {
    const subscriptionId = String(request.subscriptionId || '');
    if (!eventBroker.webhookSecret) {
      writeMessage(connection, {
        ok: false,
        error: { code: 'event_webhook_secret_unconfigured', message: 'webhook secret is not configured' },
      });
      endConnection(connection);
      return null;
    }
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
    coordinator.metrics.socketConnections += 1;
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
        if (request.type === 'event-listen') {
          listener = attachEventListener(connection, request);
          finishRequest();
          return;
        }
        let result;
        if (request.type === 'ping') {
          result = Promise.resolve({ ok: true, status: coordinator.ping() });
        } else if (request.type === 'status') {
          result = Promise.resolve({ ok: true, status: coordinator.status({ compact: Boolean(request.compact) }) });
        } else if (request.type === 'shutdown') {
          result = Promise.resolve({ ok: true });
        } else if (request.type === 'cancellation-details') {
          result = Promise.resolve(coordinator.getPendingCancellation(request.requestId));
        } else if (request.type === 'confirm-cancellation') {
          result = coordinator.confirmCancellation(request.requestId, request.confirmation);
        } else if (request.type === 'events-subscribe') {
          result = Promise.resolve(coordinator.eventSubscription(request.spec));
        } else if (request.type === 'events-status') {
          result = Promise.resolve(coordinator.eventSubscriptions(request.options || {}));
        } else if (request.type === 'events-summary') {
          result = Promise.resolve(coordinator.eventSubscriptionSummary(request.options || {}));
        } else if (request.type === 'events-audit') {
          result = Promise.resolve(coordinator.eventAudit(request.options || {}));
        } else if (request.type === 'events-gc') {
          result = Promise.resolve(coordinator.eventGarbageCollect(request.options || {}));
        } else if (request.type === 'events-subscription') {
          result = Promise.resolve(coordinator.eventSubscriptionDetails(request.subscriptionId));
        } else if (request.type === 'events-subscription-target') {
          result = Promise.resolve(coordinator.eventSubscriptionTarget(request.options || {}));
        } else if (request.type === 'events-unsubscribe') {
          result = Promise.resolve(coordinator.eventUnsubscribe(request.subscriptionId));
        } else if (request.type === 'events-renew') {
          result = Promise.resolve(coordinator.renewEventSubscription(request.subscriptionId, request.options || {}));
        } else if (request.type === 'events-webhook') {
          result = Promise.resolve(coordinator.ingestWebhook(request));
        } else if (request.type === 'events-reconcile') {
          result = coordinator.reconcileEvents(request.subscriptionId);
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
      closingConnections.delete(connection);
      detachConnectionListeners(connection, listener);
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
    if (eventSweepTimer) clearInterval(eventSweepTimer);
    if (scheduledGcTimer) clearInterval(scheduledGcTimer);
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
    server.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 1_000);
  };

  const cleanUp = () => {
    if (ownsCoordinatorLock(ownerLock)) {
      releaseCoordinatorOwner(ownerLock, { removeSocket: true });
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

  let sweepRunning = false;
  const runEventSweep = () => {
    if (sweepRunning) return;
    sweepRunning = true;
    coordinator.reconcileStaleSubscriptions()
      .catch((error) => logStructuredError('event_sweep_failed', error))
      .finally(() => { sweepRunning = false; });
  };
  const firstSweepTimer = setTimeout(runEventSweep, 30_000);
  firstSweepTimer.unref?.();
  eventSweepTimer = setInterval(runEventSweep, EVENT_SWEEP_INTERVAL_MS);
  eventSweepTimer.unref?.();

  const runScheduledGc = () => {
    try {
      coordinator.scheduledEventGarbageCollection();
    } catch (error) {
      logStructuredError('event_scheduled_gc_failed', error);
    }
  };
  const firstGcTimer = setTimeout(runScheduledGc, 5 * 60_000);
  firstGcTimer.unref?.();
  scheduledGcTimer = setInterval(runScheduledGc, SCHEDULED_GC_INTERVAL_MS);
  scheduledGcTimer.unref?.();

  stopSourceWatcher = installSourceReloadWatcher(() => {
    coordinator.metrics.sourceReloads += 1;
    terminate();
  }, { getActiveRequests: () => activeRequestCount });

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
