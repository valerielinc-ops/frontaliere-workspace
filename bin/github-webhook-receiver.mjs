#!/usr/bin/env node

/**
 * Small HTTP ingress for GitHub webhooks.
 *
 * Keep this listener behind a TLS reverse proxy or an authenticated tunnel.
 * The coordinator still verifies X-Hub-Signature-256 before accepting data.
 *
 * GitHub delivers each webhook to one URL, and the public tunnel ends on one
 * Mac. `--relay <url>` (repeatable, or FRONTALIERE_WEBHOOK_RELAYS, comma
 * separated) forwards every delivery this receiver accepted to the receivers
 * of the other Macs, unchanged and with its signature, so their coordinators
 * see the same events. A relayed delivery is marked and never relayed again.
 */

import { createServer } from 'node:http';
import { readFileSync, realpathSync, watch } from 'node:fs';
import cluster from 'node:cluster';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestGitHubWebhook } from './github-coordinator-client.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_PATH = '/github/webhook';
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
export const RELAY_HEADER = 'x-frontaliere-webhook-relay';
export const RELAY_TIMEOUT_MS = 10_000;
export const RELAY_RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000]);
const EXTRA_HOST_RETRY_MS = 30_000;
const SOURCE_RELOAD_DEBOUNCE_MS = 3_000;
const SOURCE_RELOAD_QUIESCENCE_MS = 250;
const WATCHED_SOURCE_NAMES = new Set([
  'github-coordinator-client.mjs',
  'github-event-broker.mjs',
  'github-webhook-receiver.mjs',
  'github-coordinator-launcher',
]);
const TRANSIENT_COORDINATOR_ERRORS = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'GITHUB_COORDINATOR_TIMEOUT',
  'github_coordinator_timeout',
  'github_coordinator_unavailable',
  'github_coordinator_start_timeout',
  'ENOSPC',
]);

export function webhookErrorStatus(error) {
  if (error?.code === 'event_webhook_signature_invalid') return 401;
  if (error?.code === 'event_webhook_secret_unconfigured') return 503;
  if (error?.code === 'webhook_body_too_large') return 413;
  if (TRANSIENT_COORDINATOR_ERRORS.has(String(error?.code || ''))
    || /github[_ ]coordinator|coordinator.*(?:timeout|unavailable|socket)/i.test(String(error?.message || ''))) {
    return 503;
  }
  return 400;
}

const LOGGED_CLIENT_ERROR_STATUS = 400;

/**
 * Prefix a free-text receiver log line with an ISO timestamp, so the lines in
 * the launchd stderr log can be matched with the hourly 5xx series of the
 * Cloudflare tunnel.
 */
export function stamp(message, now = Date.now) {
  return `${new Date(now()).toISOString()} ${message}`;
}

function writeStderrLine(line) {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Logging must not turn a contained failure into a process failure.
  }
}

function defaultLog(entry) {
  writeStderrLine(JSON.stringify(entry));
}

/**
 * Only the responses an operator has to attribute are logged: every 5xx (the
 * coordinator is unreachable, timed out or misconfigured) and the 400 of a
 * delivery the coordinator rejected. 202, 401, 404 and 413 are the volume and
 * the public noise of the ingress.
 */
/**
 * The error label kept in the log. A code is a fixed identifier; a message
 * may one day quote the payload (it is still returned in the HTTP body), so an
 * error without a code is logged only by its class name.
 */
function logErrorLabel(error) {
  if (error?.code) return String(error.code);
  const name = error instanceof Error ? error.name : typeof error;
  return `uncoded:${name || 'unknown'}`;
}

function shouldLogWebhookResponse(status) {
  return status >= 500 || status === LOGGED_CLIENT_ERROR_STATUS;
}

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
      ts: new Date().toISOString(),
      component: 'github-webhook-receiver',
      event,
      error: describeError(error),
      ...details,
    })}\n`);
  } catch {
    // Logging must not turn a contained failure into a process failure.
  }
}

function createDebouncedReloadScheduler({ onReload, getActiveRequests = () => 0 } = {}) {
  let debounceTimer = null;
  let quiescenceTimer = null;
  let pending = false;
  let stopped = false;

  const attemptReload = () => {
    debounceTimer = null;
    if (stopped || !pending) return;
    if (getActiveRequests() > 0) {
      quiescenceTimer = setTimeout(attemptReload, SOURCE_RELOAD_QUIESCENCE_MS);
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
      debounceTimer = setTimeout(attemptReload, SOURCE_RELOAD_DEBOUNCE_MS);
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
  };
}

export function createWorkerRotationController({ forkWorker, disconnectWorker = (worker) => worker.disconnect() } = {}) {
  if (typeof forkWorker !== 'function') throw new TypeError('fork_worker_required');

  let activeWorker = null;
  let pendingWorker = null;
  let stopped = false;

  const spawn = () => {
    if (stopped) return null;
    pendingWorker = forkWorker();
    return pendingWorker;
  };

  return {
    start() {
      if (activeWorker || pendingWorker) return null;
      return spawn();
    },
    reload() {
      if (stopped || pendingWorker) return false;
      spawn();
      return true;
    },
    markListening(worker) {
      if (stopped || worker !== pendingWorker) return false;
      const previousWorker = activeWorker;
      activeWorker = worker;
      pendingWorker = null;
      if (previousWorker && previousWorker !== worker) disconnectWorker(previousWorker);
      return true;
    },
    markExit(worker) {
      if (worker === pendingWorker) pendingWorker = null;
      if (worker === activeWorker) activeWorker = null;
      if (!stopped && !activeWorker && !pendingWorker) return spawn();
      return null;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const workers = [activeWorker, pendingWorker].filter(Boolean);
      activeWorker = null;
      pendingWorker = null;
      for (const worker of workers) disconnectWorker(worker);
    },
    snapshot() {
      return { activeWorker, pendingWorker, stopped };
    },
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

function installSourceReloadWatcher(onReload, { getActiveRequests = () => 0, continuous = false } = {}) {
  let triggered = false;
  let watcher;
  let scheduler;
  const sourceSnapshots = new Map();
  for (const name of WATCHED_SOURCE_NAMES) {
    try {
      sourceSnapshots.set(name, readFileSync(resolve(THIS_DIR, name)));
    } catch {
      sourceSnapshots.set(name, null);
    }
  }
  const sourceContentChanged = (name) => {
    let current;
    try {
      current = readFileSync(resolve(THIS_DIR, name));
    } catch {
      current = null;
    }
    const previous = sourceSnapshots.get(name);
    if (current === null || previous === null) return current !== previous;
    return !current.equals(previous);
  };
  const triggerReload = () => {
    if (triggered) return;
    if (![...WATCHED_SOURCE_NAMES].some(sourceContentChanged)) return;
    if (!continuous) {
      triggered = true;
      scheduler.stop();
      try { watcher?.close(); } catch { /* watcher already closed */ }
    }
    writeStderrLine(stamp('github-webhook-receiver: source quiescent; restarting under supervisor'));
    onReload();
  };
  scheduler = createDebouncedReloadScheduler({ onReload: triggerReload, getActiveRequests });
  try {
    watcher = watch(THIS_DIR, { persistent: false }, (_eventType, filename) => {
      const name = String(filename || '');
      if (triggered || !WATCHED_SOURCE_NAMES.has(name) || !sourceContentChanged(name)) return;
      if (scheduler.request()) {
        writeStderrLine(stamp(
          `github-webhook-receiver: source changed; restart scheduled (debounce=${SOURCE_RELOAD_DEBOUNCE_MS}ms, quiescence=${SOURCE_RELOAD_QUIESCENCE_MS}ms)`,
        ));
      }
    });
  } catch (error) {
    writeStderrLine(stamp(`github-webhook-receiver: source watcher unavailable: ${error.message}`));
  }
  return () => {
    scheduler.stop();
    try { watcher?.close(); } catch { /* watcher already closed */ }
  };
}

function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('webhook_body_too_large'), { code: 'webhook_body_too_large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The relay targets, validated: http(s) URLs only, duplicates dropped. A
 * malformed value stops the receiver at start rather than losing deliveries
 * in silence.
 */
export function parseRelayTargets(values = []) {
  const targets = [];
  for (const value of values.flatMap((entry) => String(entry || '').split(','))) {
    const candidate = value.trim();
    if (!candidate) continue;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw Object.assign(new Error(`webhook_relay_url_invalid: ${candidate}`), { code: 'webhook_relay_url_invalid' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw Object.assign(new Error(`webhook_relay_url_invalid: ${candidate}`), { code: 'webhook_relay_url_invalid' });
    }
    if (!targets.includes(url.href)) targets.push(url.href);
  }
  return targets;
}

/**
 * Which local outcomes are forwarded: an accepted delivery (202) and one the
 * local coordinator could not take (5xx), since the signature was not checked
 * and another Mac may still need it. A rejected signature, a wrong path or an
 * oversized body is the public noise of the ingress and stays here.
 */
export function shouldRelayStatus(status) {
  return status === 202 || status >= 500;
}

const defaultSleep = (ms) => new Promise((resolvePromise) => {
  const timer = setTimeout(resolvePromise, ms);
  timer.unref?.();
});

/**
 * Forward deliveries to the receivers of the other Macs. Best effort: a
 * network error or a 5xx is retried with RELAY_RETRY_DELAYS_MS, a 4xx is not
 * (the peer refused it and will refuse it again). The coordinator there
 * deduplicates by X-GitHub-Delivery, so a retry after a lost answer is safe.
 * A failure is logged with the target origin only; what a delivery still
 * misses there is recovered by the coordinator's reconciliation.
 */
export function createWebhookRelay({
  targets = [],
  fetchImpl = globalThis.fetch,
  log = defaultLog,
  sleep = defaultSleep,
  timeoutMs = RELAY_TIMEOUT_MS,
  retryDelaysMs = RELAY_RETRY_DELAYS_MS,
  now = Date.now,
} = {}) {
  const forwardOne = async (target, delivery, identity) => {
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'frontaliere-github-webhook-relay',
      [RELAY_HEADER]: '1',
    };
    if (delivery.eventName) headers['x-github-event'] = delivery.eventName;
    if (delivery.deliveryId) headers['x-github-delivery'] = delivery.deliveryId;
    if (delivery.signature) headers['x-hub-signature-256'] = delivery.signature;
    let lastError = 'unknown';
    let attempts = 0;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
      attempts += 1;
      try {
        const response = await fetchImpl(target, {
          method: 'POST',
          headers,
          body: delivery.rawBody,
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.arrayBuffer().catch(() => {});
        if (response.status < 300) return true;
        lastError = `http_${response.status}`;
        if (response.status < 500) break;
      } catch (error) {
        lastError = error?.cause?.code || error?.code || error?.name || 'fetch_failed';
      }
    }
    try {
      log({
        ts: new Date(now()).toISOString(),
        component: 'github-webhook-receiver',
        event: 'webhook_relay_failed',
        identity: identity ?? null,
        target: new URL(target).origin,
        error: String(lastError),
        attempts,
      });
    } catch {
      // A failing logger must not affect the other targets.
    }
    return false;
  };

  return {
    targets,
    forward(delivery, { identity } = {}) {
      return Promise.all(targets.map((target) => forwardOne(target, delivery, identity)));
    },
  };
}

export function createGitHubWebhookReceiver({
  identity,
  path = DEFAULT_PATH,
  onRequestStart = () => {},
  onRequestEnd = () => {},
  ingest = ingestGitHubWebhook,
  log = defaultLog,
  now = Date.now,
  relay = null,
} = {}) {
  return createServer(async (request, response) => {
    onRequestStart();
    const startedAt = now();
    // Which step failed: a client/tunnel abort while the body is read and a
    // reset of the coordinator socket both surface as ECONNRESET -> 503.
    let phase = 'read_body';
    let delivery = null;
    let status = null;
    try {
      if (request.method !== 'POST' || request.url?.split('?')[0] !== path) {
        jsonResponse(response, 404, { ok: false, error: 'not_found' });
        return;
      }
      const rawBody = await readBody(request);
      phase = 'ingest';
      delivery = {
        eventName: header(request, 'x-github-event'),
        deliveryId: header(request, 'x-github-delivery'),
        signature: header(request, 'x-hub-signature-256'),
        rawBody,
      };
      const result = await ingest(delivery, { identity });
      status = 202;
      jsonResponse(response, 202, result);
    } catch (error) {
      status = webhookErrorStatus(error);
      const errorLabel = error?.code || error?.message;
      const details = {
        ok: false,
        error: errorLabel,
      };
      for (const field of ['repo', 'actualIdentity', 'expectedIdentity', 'exitCode', 'nextAction']) {
        if (error?.[field] !== undefined) details[field] = error[field];
      }
      jsonResponse(response, status, details);
      if (shouldLogWebhookResponse(status)) {
        // Never the payload, the headers, the signature or the delivery id:
        // the line must be safe to keep in a plain launchd log.
        const finishedAt = now();
        try {
          log({
            ts: new Date(finishedAt).toISOString(),
            component: 'github-webhook-receiver',
            event: 'webhook_response',
            identity: identity ?? null,
            status,
            phase,
            error: logErrorLabel(error),
            durationMs: Math.max(0, finishedAt - startedAt),
          });
        } catch {
          // A failing logger must not affect the response already sent.
        }
      }
    } finally {
      onRequestEnd();
      if (relay && delivery && shouldRelayStatus(status) && !header(request, RELAY_HEADER)) {
        // After the answer to GitHub, which waits at most 10 s. Counted as an
        // active request so a source reload waits for it.
        onRequestStart();
        relay.forward(delivery, { identity }).catch(() => {}).finally(onRequestEnd);
      }
    }
  });
}

function optionValues(args, name) {
  const values = [];
  args.forEach((value, index) => {
    if (value === name && args[index + 1]) values.push(args[index + 1]);
    else if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
  });
  return values;
}

function optionValue(args, name, fallback) {
  const index = args.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return fallback;
  return args[index].startsWith(`${name}=`) ? args[index].slice(name.length + 1) : args[index + 1] || fallback;
}

export function receiverOptions(args = process.argv.slice(2), env = process.env) {
  const identity = optionValue(args, '--identity', env.FRONTALIERE_GH_IDENTITY);
  const host = optionValue(args, '--host', env.FRONTALIERE_WEBHOOK_HOST || DEFAULT_HOST);
  const port = Number(optionValue(args, '--port', env.FRONTALIERE_WEBHOOK_PORT || DEFAULT_PORT));
  const path = optionValue(args, '--path', env.FRONTALIERE_WEBHOOK_PATH || DEFAULT_PATH);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('webhook_port_invalid');
  // Extra addresses (the Tailscale IP of this Mac) for the deliveries another
  // receiver relays here; the first host stays the one of the tunnel.
  const extraHosts = optionValues(args, '--extra-host')
    .concat(String(env.FRONTALIERE_WEBHOOK_EXTRA_HOSTS || '').split(','))
    .map((value) => value.trim())
    .filter((value, index, all) => value && value !== host && all.indexOf(value) === index);
  const relays = parseRelayTargets(optionValues(args, '--relay').concat(env.FRONTALIERE_WEBHOOK_RELAYS || ''));
  return { identity, host, port, path, extraHosts, relays };
}

function startReceiverWorker({ identity, host, port, path, extraHosts = [], relays = [] }) {
  let activeRequestCount = 0;
  let terminating = false;
  const relay = relays.length ? createWebhookRelay({ targets: relays }) : null;
  const createServerForHost = () => createGitHubWebhookReceiver({
    identity,
    path,
    relay,
    onRequestStart: () => { activeRequestCount += 1; },
    onRequestEnd: () => { activeRequestCount = Math.max(0, activeRequestCount - 1); },
  });
  const server = createServerForHost();
  const extraServers = [];
  const terminate = (exitCode = 0) => {
    if (terminating) {
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }
    terminating = true;
    for (const extra of extraServers) extra.close();
    server.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 1_000);
  };
  server.on('error', (error) => {
    writeStderrLine(stamp(`github-webhook-receiver: ${error.message}`));
    terminate(1);
  });
  installProcessSafetyHandlers(terminate);
  process.once('disconnect', () => terminate(0));
  server.listen(port, host, () => {
    const relayNote = relays.length ? ` (relay to ${relays.map((target) => new URL(target).origin).join(', ')})` : '';
    process.stdout.write(`${stamp(`github-webhook-receiver listening on http://${host}:${port}${path}${relayNote}`)}\n`);
  });
  // An extra address may not exist yet at login (Tailscale still connecting):
  // its failure is retried and never stops the main listener.
  const listenExtra = (extraHost) => {
    if (terminating) return;
    const extra = createServerForHost();
    extra.once('error', (error) => {
      writeStderrLine(stamp(`github-webhook-receiver: ${extraHost}:${port} unavailable (${error.code || error.message}); retry in ${EXTRA_HOST_RETRY_MS / 1000}s`));
      extra.close();
      const timer = setTimeout(() => listenExtra(extraHost), EXTRA_HOST_RETRY_MS);
      timer.unref?.();
    });
    extra.listen(port, extraHost, () => {
      extraServers.push(extra);
      process.stdout.write(`${stamp(`github-webhook-receiver listening on http://${extraHost}:${port}${path}`)}\n`);
    });
  };
  for (const extraHost of extraHosts) listenExtra(extraHost);
}

function startReceiverSupervisor(options) {
  cluster.setupPrimary({ exec: fileURLToPath(import.meta.url) });
  let stopSourceWatcher = () => {};
  let terminating = false;
  const rotation = createWorkerRotationController({
    forkWorker: () => {
      const worker = cluster.fork();
      worker.on('error', (error) => logStructuredError('worker_error', error, { workerId: worker.id }));
      return worker;
    },
    disconnectWorker: (worker) => worker.disconnect(),
  });
  const terminate = (exitCode = 0) => {
    if (terminating) {
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }
    terminating = true;
    stopSourceWatcher();
    rotation.stop();
    process.exit(exitCode);
  };
  installProcessSafetyHandlers(terminate);
  cluster.on('listening', (worker) => {
    if (rotation.markListening(worker)) {
      writeStderrLine(stamp(`github-webhook-receiver: worker ${worker.id} ready; previous worker drained`));
    }
  });
  cluster.on('exit', (worker, code, signal) => {
    const replacement = rotation.markExit(worker);
    if (replacement) {
      writeStderrLine(stamp(`github-webhook-receiver: worker ${worker.id} exited (${code ?? 'null'}/${signal ?? 'none'}); replacement forked`));
    }
  });
  stopSourceWatcher = installSourceReloadWatcher(() => {
    if (rotation.reload()) writeStderrLine(stamp('github-webhook-receiver: replacement worker forked'));
  }, { continuous: true });
  rotation.start();
  process.stdout.write(`${stamp(`github-webhook-receiver supervisor active for http://${options.host}:${options.port}${options.path}`)}\n`);
}

function main() {
  const options = receiverOptions();
  if (cluster.isPrimary) startReceiverSupervisor(options);
  else startReceiverWorker(options);
}

// launchd runs the receiver through the `current` release symlink: compare
// real paths, or the entry point never starts and exits 0 in a respawn loop.
function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (invokedAsMain()) {
  try {
    main();
  } catch (error) {
    writeStderrLine(stamp(`github-webhook-receiver: ${error.message}`));
    process.exitCode = 1;
  }
}
