#!/usr/bin/env node

/**
 * Client for the per-user GitHub coordinator daemon.
 *
 * The protocol is intentionally tiny: one JSON request and one JSON response
 * per Unix-socket connection.  Tokens never cross the socket; the daemon
 * resolves the selected identity locally and keeps the credential in memory.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import {
  mkdirSync,
  openSync,
  closeSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(THIS_DIR, 'github-coordinator-launcher');
const DEFAULT_STATE_DIR = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'frontaliere')
  : process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, 'frontaliere')
    : join(homedir(), '.local', 'state', 'frontaliere');
const CANCELLATION_PROTOCOL_VERSION = 2;
const EVENT_PROTOCOL_VERSION = 5;
export const EVENT_LISTENER_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_EVENT_RECONCILE_AFTER_MS = 5 * 60 * 1_000;
const CONNECT_TIMEOUT_MS = 3_000;
const EXEC_TIMEOUT_MS = 15 * 60 * 1_000;
const NETWORK_REQUEST_TYPES = new Set([
  'api',
  'exec',
  'events-subscribe',
  'events-reconcile',
  'confirm-cancellation',
]);
const START_TIMEOUT_MS = 15_000;
const START_LOCK_STALE_MS = 30_000;
const TRANSIENT_REQUEST_RETRY_DELAY_MS = 100;
const RETRYABLE_LOCAL_REQUEST_TYPES = new Set([
  'ping',
  'status',
  'cancellation-details',
  'events-status',
  'events-summary',
  'events-audit',
  'events-subscription',
  'events-subscription-target',
]);
const protocolChecks = new Map();

export function requestTimeoutMilliseconds(request) {
  return NETWORK_REQUEST_TYPES.has(String(request?.type || ''))
    ? EXEC_TIMEOUT_MS
    : CONNECT_TIMEOUT_MS;
}

export function normalizeIdentity(value = process.env.FRONTALIERE_GH_IDENTITY || 'default') {
  const identity = String(value || 'default').trim().toLowerCase();
  if (!/^[A-Za-z0-9._-]+$/.test(identity)) {
    throw new Error(`invalid_github_identity: ${identity}`);
  }
  return identity;
}

export function stateDirectory() {
  return process.env.FRONTALIERE_GH_STATE_DIR || DEFAULT_STATE_DIR;
}

export function legacyStateDirectory() {
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'frontaliere')
    : null;
}

export function socketPath(identity = normalizeIdentity()) {
  return join(stateDirectory(), `github-coordinator-${normalizeIdentity(identity)}.sock`);
}

export function coordinatorOwnerLockPath(identity = normalizeIdentity()) {
  return `${socketPath(identity)}.owner`;
}

function startLockPath(identity) {
  return `${socketPath(identity)}.start`;
}

function persistentServiceLabel(identity) {
  return `ch.frontaliere.github-coordinator-${normalizeIdentity(identity)}`;
}

function persistentServiceLoaded(identity) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return false;
  const result = spawnSync('/bin/launchctl', [
    'print',
    `gui/${process.getuid()}/${persistentServiceLabel(identity)}`,
  ], { stdio: 'ignore' });
  return result.status === 0;
}

async function persistentServiceLoadedEventually(identity) {
  if (process.platform !== 'darwin') return false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (persistentServiceLoaded(identity)) return true;
    if (attempt < 3) await sleep(250);
  }
  return false;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function statusFromResponse(response) {
  return response?.status || response || null;
}

function rememberProtocolStatus(identity, response) {
  const status = statusFromResponse(response);
  const startedAt = status?.metrics?.startedAt;
  const protocolVersion = Number(status?.protocolVersion || 0);
  if (!startedAt || !Number.isFinite(protocolVersion)) return null;

  const previous = protocolChecks.get(identity);
  if (!previous || previous.startedAt !== startedAt || previous.protocolVersion !== protocolVersion) {
    const current = {
      startedAt,
      protocolVersion,
      webhookSecretConfigured: status?.events?.webhookSecretConfigured === true,
      cancellationConfirmed: false,
      eventProtocolConfirmed: false,
    };
    protocolChecks.set(identity, current);
    return current;
  }
  if (status?.events?.webhookSecretConfigured !== undefined) {
    previous.webhookSecretConfigured = status.events.webhookSecretConfigured === true;
  }
  return previous;
}

// Socket chunks split at arbitrary byte offsets. Decoding each chunk on its own
// turns a multi-byte character cut in two into U+FFFD, which silently alters
// webhook bodies (HMAC mismatch) and gh output. Keep one decoder per stream.
export function createUtf8ChunkDecoder() {
  const decoder = new StringDecoder('utf8');
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.write(chunk));
}

function connectOnce(request, { identity, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const targetSocket = socketPath(identity);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let buffer = '';
    const decodeChunk = createUtf8ChunkDecoder();
    const socket = createConnection(targetSocket);
    const timer = setTimeout(() => {
      socket.destroy();
      const error = new Error(`github_coordinator_timeout: ${targetSocket}`);
      error.code = 'GITHUB_COORDINATOR_TIMEOUT';
      rejectOnce(error);
    }, timeoutMs);

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += decodeChunk(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line);
        socket.end();
        resolveOnce(response);
      } catch (error) {
        socket.destroy();
        rejectOnce(new Error(`invalid_github_coordinator_response: ${error.message}`));
      }
    });
    socket.on('error', rejectOnce);
    socket.on('close', () => {
      if (settled) return;
      const error = new Error(`github_coordinator_unavailable: ${targetSocket}`);
      error.code = 'github_coordinator_unavailable';
      rejectOnce(error);
    });
  });
}

function transientCoordinatorError(error) {
  return new Set([
    'GITHUB_COORDINATOR_TIMEOUT',
    'github_coordinator_unavailable',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
  ]).has(error?.code);
}

function retryableLocalRequest(request) {
  if (RETRYABLE_LOCAL_REQUEST_TYPES.has(String(request?.type || ''))) return true;
  if (request?.type !== 'api') return false;
  return ['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase());
}

async function connectWithTransientRetry(request, { identity, timeoutMs, retry = false } = {}) {
  const attempts = retry ? 2 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await connectOnce(request, { identity, timeoutMs });
    } catch (error) {
      lastError = error;
      if (!retry || attempt + 1 >= attempts || !transientCoordinatorError(error)) throw error;
      await sleep(TRANSIENT_REQUEST_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

function claimStartLock(identity) {
  const lock = startLockPath(identity);
  mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
  try {
    const stat = statSync(lock);
    if (Date.now() - stat.mtimeMs > START_LOCK_STALE_MS) unlinkSync(lock);
  } catch {
    // No lock yet.
  }
  try {
    const fd = openSync(lock, 'wx', 0o600);
    try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function releaseStartLock(identity) {
  try { unlinkSync(startLockPath(identity)); } catch { /* no start lock */ }
}

async function startDaemon(identity) {
  if (!claimStartLock(identity)) return false;
  try {
    try {
      await connectOnce({ type: 'ping' }, { identity, timeoutMs: CONNECT_TIMEOUT_MS });
      releaseStartLock(identity);
      return false;
    } catch {
      // No healthy daemon owns the socket; remove only this stale endpoint.
    }
    if (await persistentServiceLoadedEventually(identity)) {
      // launchd owns this identity.  Waiting for KeepAlive avoids a second
      // daemon binding the same socket while the service is restarting.
      releaseStartLock(identity);
      return false;
    }
    const child = spawn(LAUNCHER, ['serve', '--identity', identity], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        FRONTALIERE_GH_IDENTITY: identity,
      },
    });
    child.unref();
    return true;
  } catch (error) {
    releaseStartLock(identity);
    throw error;
  }
}

export async function ensureCoordinator(identity = normalizeIdentity()) {
  const normalized = normalizeIdentity(identity);
  try {
    const response = await connectOnce({ type: 'ping', compact: true }, { identity: normalized });
    rememberProtocolStatus(normalized, response);
    return response;
  } catch {
    // A concurrent client may be starting the same daemon.  The server owns
    // the bind race; clients simply retry the same socket below.
  }

  await startDaemon(normalized);
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await connectOnce({ type: 'ping', compact: true }, { identity: normalized });
      rememberProtocolStatus(normalized, response);
      return response;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw lastError || new Error(`github_coordinator_start_timeout: ${normalized}`);
}

export async function waitForCoordinatorStop(identity = normalizeIdentity(), timeoutMs = START_TIMEOUT_MS) {
  const normalized = normalizeIdentity(identity);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await connectOnce({ type: 'ping' }, { identity: normalized, timeoutMs: CONNECT_TIMEOUT_MS });
      await sleep(100);
    } catch {
      return true;
    }
  }
  return false;
}

export async function probeCoordinator(identity = normalizeIdentity(), timeoutMs = CONNECT_TIMEOUT_MS) {
  const normalized = normalizeIdentity(identity);
  const response = await connectWithTransientRetry(
    { type: 'status', identity: normalized, compact: true },
    { identity: normalized, timeoutMs, retry: true },
  );
  rememberProtocolStatus(normalized, response);
  return response;
}

function cancellationPath(pathname) {
  return /^\/?repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/cancel(?:\?.*)?$/.test(String(pathname || ''))
    || /^\/?actions\/runs\/\d+\/cancel(?:\?.*)?$/.test(String(pathname || ''));
}

function requestNeedsCancellationConfirmation(request) {
  if (request?.type === 'api') {
    return String(request.method || 'GET').toUpperCase() === 'POST'
      && cancellationPath(String(request.path || '').replace(/^\//, ''));
  }
  if (request?.type !== 'exec' || !Array.isArray(request.args)) return false;
  const args = request.args.map(String);
  if (args.some((value, index) => value === 'run' && args[index + 1] === 'cancel')) return true;
  const apiIndex = args.indexOf('api');
  if (apiIndex < 0) return false;
  const apiArgs = args.slice(apiIndex);
  const methodIndex = apiArgs.findIndex((value) => value === '--method' || value === '-X');
  const methodOption = methodIndex >= 0 ? apiArgs[methodIndex + 1] : apiArgs.find((value) => value.startsWith('--method='))?.slice(9);
  if (String(methodOption || 'GET').toUpperCase() !== 'POST') return false;
  const repoIndex = args.findIndex((value) => value === '--repo');
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : args.find((value) => value.startsWith('--repo='))?.slice(7);
  return apiArgs.some((value) => cancellationPath(value))
    || Boolean(repo && apiArgs.some((value) => /^\/?actions\/runs\/\d+\/cancel(?:\?.*)?$/.test(value)));
}

async function ensureCancellationConfirmationProtocol(identity, status = null) {
  let memo = rememberProtocolStatus(identity, status);
  if (memo?.cancellationConfirmed) return;
  const response = status
    ? { status }
    : await connectWithTransientRetry(
      { type: 'status', identity, compact: true },
      { identity, timeoutMs: CONNECT_TIMEOUT_MS, retry: true },
    );
  const currentStatus = statusFromResponse(response);
  memo = rememberProtocolStatus(identity, currentStatus);
  const version = Number(currentStatus?.protocolVersion || 0);
  if (version >= CANCELLATION_PROTOCOL_VERSION) {
    if (memo) memo.cancellationConfirmed = true;
    return;
  }
  const error = new Error(
    'cancellazione GitHub bloccata: il coordinatore condiviso deve essere riavviato prima di inoltrare richieste di cancellazione',
  );
  error.code = 'cancellation_confirmation_protocol_unavailable';
  error.exitCode = 2;
  throw error;
}

async function ensureEventProtocol(identity, { requireWebhookSecret = false, status = null } = {}) {
  let memo = rememberProtocolStatus(identity, status);
  if (memo?.eventProtocolConfirmed
    && (!requireWebhookSecret || memo.webhookSecretConfigured)) return;
  // `ensureCoordinator` intentionally starts with a cheap ping.  During the
  // worker-backed broker bootstrap that ping reports `loading: true`; do not
  // treat its temporary `webhookSecretConfigured: false` as the final event
  // protocol result.  The status RPC waits for the broker and is the real
  // preflight in that narrow window.
  const readyStatus = status?.events?.loading === true ? null : status;
  const response = readyStatus
    ? { status: readyStatus }
    : await connectWithTransientRetry(
      { type: 'status', identity, compact: true },
      { identity, timeoutMs: CONNECT_TIMEOUT_MS, retry: true },
    );
  const currentStatus = statusFromResponse(response);
  memo = rememberProtocolStatus(identity, currentStatus);
  const version = Number(currentStatus?.protocolVersion || 0);
  if (version < EVENT_PROTOCOL_VERSION) {
    const error = new Error(
      'event subscriptions bloccate: il coordinatore condiviso deve essere riavviato per attivare il protocollo webhook',
    );
    error.code = 'event_protocol_unavailable';
    error.exitCode = 2;
    throw error;
  }
  if (requireWebhookSecret && currentStatus?.events?.webhookSecretConfigured !== true) {
    const error = new Error(
      'event subscriptions bloccate: secret webhook non configurato nel coordinatore; carica Remote Config e riavvia il servizio',
    );
    error.code = 'event_webhook_secret_unconfigured';
    error.exitCode = 2;
    throw error;
  }
  if (memo) memo.eventProtocolConfirmed = true;
}

export async function sendRequest(request, { identity = normalizeIdentity() } = {}) {
  const normalized = normalizeIdentity(identity);
  const coordinatorResponse = await ensureCoordinator(normalized);
  const coordinatorStatus = statusFromResponse(coordinatorResponse);
  if (requestNeedsCancellationConfirmation(request)) {
    await ensureCancellationConfirmationProtocol(normalized, coordinatorStatus);
  }
  if (String(request?.type || '').startsWith('events-')) {
    await ensureEventProtocol(normalized, {
      requireWebhookSecret: request.type === 'events-subscribe' || request.type === 'events-webhook',
      status: coordinatorStatus,
    });
  }
  const timeoutMs = requestTimeoutMilliseconds(request);
  const response = await connectWithTransientRetry(
    { ...request, identity: normalized },
    {
      identity: normalized,
      timeoutMs,
      retry: retryableLocalRequest(request),
    },
  );
  if (response?.ok === false && response?.error) {
    const error = new Error(response.error.message || response.error.code || 'github_coordinator_error');
    Object.assign(error, response.error);
    throw error;
  }
  return response;
}

export async function getPendingCancellation(requestId, { identity } = {}) {
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new TypeError('cancellation_request_id_required');
  }
  return sendRequest({ type: 'cancellation-details', requestId }, { identity });
}

export async function confirmCancellation(requestId, confirmation, { identity } = {}) {
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new TypeError('cancellation_request_id_required');
  }
  return sendRequest({
    type: 'confirm-cancellation',
    requestId,
    confirmation,
  }, { identity });
}

export async function subscribeToEvents(spec, { identity } = {}) {
  return sendRequest({ type: 'events-subscribe', spec }, { identity });
}

function splitEventOptions(options, context) {
  if (context && Object.keys(context).length > 0) return { options: options || {}, identity: context.identity };
  if (options && Object.prototype.hasOwnProperty.call(options, 'identity')) {
    const { identity, ...eventOptions } = options;
    return { options: eventOptions, identity };
  }
  return { options: options || {}, identity: undefined };
}

export async function eventSubscriptions(options = {}, context = {}) {
  const split = splitEventOptions(options, context);
  return sendRequest({ type: 'events-status', options: split.options }, { identity: split.identity });
}

export async function eventSummary(options = {}, context = {}) {
  const split = splitEventOptions(options, context);
  return sendRequest({ type: 'events-summary', options: split.options }, { identity: split.identity });
}

export async function eventAudit(options = {}, context = {}) {
  const split = splitEventOptions(options, context);
  return sendRequest({ type: 'events-audit', options: split.options }, { identity: split.identity });
}

export async function garbageCollectEvents(options = {}, { identity } = {}) {
  return sendRequest({ type: 'events-gc', options }, { identity });
}

export async function eventSubscription(subscriptionId, { identity } = {}) {
  return sendRequest({ type: 'events-subscription', subscriptionId }, { identity });
}

export async function eventSubscriptionTarget(options = {}, { identity } = {}) {
  return sendRequest({ type: 'events-subscription-target', options }, { identity });
}

export async function unsubscribeFromEvents(subscriptionId, { identity } = {}) {
  return sendRequest({ type: 'events-unsubscribe', subscriptionId }, { identity });
}

export async function reconcileEvents(subscriptionId, { identity } = {}) {
  return sendRequest({ type: 'events-reconcile', subscriptionId }, { identity });
}

export async function renewEventSubscription(subscriptionId, options = {}, { identity } = {}) {
  return sendRequest({ type: 'events-renew', subscriptionId, options }, { identity });
}

export async function ingestGitHubWebhook({ eventName, deliveryId, signature, rawBody, payload, receivedAt }, { identity } = {}) {
  return sendRequest({
    type: 'events-webhook',
    eventName,
    deliveryId,
    signature,
    rawBody,
    payload,
    receivedAt,
  }, { identity });
}

export async function listenForEvent(subscriptionId, {
  identity = normalizeIdentity(),
  agentId = process.env.FRONTALIERE_AGENT_ID || null,
  once = true,
  timeoutMs = 0,
  autoRenew = true,
  leaseMs = 6 * 60 * 60 * 1_000,
  heartbeatIntervalMs = EVENT_LISTENER_HEARTBEAT_INTERVAL_MS,
  reconcileAfterMs = DEFAULT_EVENT_RECONCILE_AFTER_MS,
} = {}) {
  const normalized = normalizeIdentity(identity);
  if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
    throw new TypeError('event_subscription_id_required');
  }
  const details = await eventSubscription(subscriptionId, { identity: normalized });
  await ensureEventProtocol(normalized, { requireWebhookSecret: true });
  let pendingEventsPresent = Number(details.subscription?.pendingEvents || 0) > 0;
  let leaseDeadlineMs = Date.parse(details.subscription?.expiresAt || '');
  const requestedDeadlineMs = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  const renewalInterval = Number.isFinite(Number(heartbeatIntervalMs)) && Number(heartbeatIntervalMs) > 0
    ? Number(heartbeatIntervalMs)
    : EVENT_LISTENER_HEARTBEAT_INTERVAL_MS;
  let leaseRenewalEnabled = autoRenew
    && (pendingEventsPresent
      || !Number.isFinite(leaseDeadlineMs)
      || leaseDeadlineMs - Date.now() >= renewalInterval * 2);
  if (autoRenew && pendingEventsPresent
    && Number.isFinite(leaseDeadlineMs) && leaseDeadlineMs <= Date.now()) {
    const renewed = await renewEventSubscription(subscriptionId, { ttlMs: leaseMs, agentId }, {
      identity: normalized,
    });
    leaseDeadlineMs = Date.parse(renewed.subscription?.expiresAt || '');
    pendingEventsPresent = Number(renewed.subscription?.pendingEvents || 0) > 0;
    leaseRenewalEnabled = true;
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let socket = null;
    let reconnectTimer = null;
    let deadlineTimer = null;
    let heartbeatTimer = null;
    let reconcileTimer = null;
    let retryAttempt = 0;
    let listenerReady = false;
    let settled = false;
    let event = null;
    let deadlineIsSubscription = Number.isFinite(leaseDeadlineMs) && leaseDeadlineMs <= requestedDeadlineMs;

    const deadlineError = () => {
      const error = new Error(deadlineIsSubscription
        ? `event_subscription_expired: ${subscriptionId}`
        : `event_listener_timeout: ${subscriptionId}`);
      error.code = deadlineIsSubscription ? 'event_subscription_expired' : 'event_listener_timeout';
      error.subscriptionId = subscriptionId;
      error.waitState = 'timed_out';
      error.nextAction = 'reconcile_once_or_escalate';
      if (Number.isFinite(leaseDeadlineMs)) error.deadlineAt = new Date(leaseDeadlineMs).toISOString();
      return error;
    };

    const scheduleDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const deadlineMs = Number.isFinite(leaseDeadlineMs)
        ? Math.min(leaseDeadlineMs, requestedDeadlineMs)
        : requestedDeadlineMs;
      deadlineIsSubscription = Number.isFinite(leaseDeadlineMs) && leaseDeadlineMs <= requestedDeadlineMs;
      if (!Number.isFinite(deadlineMs)) return;
      deadlineTimer = setTimeout(() => rejectOnce(deadlineError()), Math.max(0, deadlineMs - Date.now()));
    };

    const refreshLease = (subscription) => {
      pendingEventsPresent = Number(subscription?.pendingEvents || 0) > 0;
      if (autoRenew && pendingEventsPresent) leaseRenewalEnabled = true;
      const refreshed = Date.parse(subscription?.expiresAt || '');
      if (Number.isFinite(refreshed)) {
        leaseDeadlineMs = refreshed;
        scheduleDeadline();
      }
    };

    const refreshPendingLease = async (subscription) => {
      const expiresAtMs = Date.parse(subscription?.expiresAt || '');
      const hasPending = Number(subscription?.pendingEvents || 0) > 0;
      pendingEventsPresent = hasPending;
      if (autoRenew && hasPending) leaseRenewalEnabled = true;
      if (!autoRenew || !hasPending || !Number.isFinite(expiresAtMs) || expiresAtMs > Date.now()) {
        return subscription;
      }
      const renewed = await renewEventSubscription(subscriptionId, { ttlMs: leaseMs, agentId }, {
        identity: normalized,
      });
      pendingEventsPresent = Number(renewed.subscription?.pendingEvents || 0) > 0;
      leaseRenewalEnabled = true;
      return renewed.subscription || subscription;
    };

    const cleanup = ({ destroySocket = false } = {}) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
      if (destroySocket && socket && !socket.destroyed) socket.destroy();
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup({ destroySocket: true });
      rejectPromise(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };

    const scheduleReconnect = () => {
      if (settled || reconnectTimer) return;
      if (autoRenew && pendingEventsPresent && deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      const deadlineMs = autoRenew && pendingEventsPresent
        ? requestedDeadlineMs
        : Number.isFinite(leaseDeadlineMs)
        ? Math.min(leaseDeadlineMs, requestedDeadlineMs)
        : requestedDeadlineMs;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        rejectOnce(deadlineError());
        return;
      }
      const delayMs = Math.min(5_000, 100 * (2 ** Math.min(retryAttempt, 6)), remainingMs);
      retryAttempt += 1;
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
          await ensureCoordinator(normalized);
          await ensureEventProtocol(normalized, { requireWebhookSecret: true });
          const refreshed = await eventSubscription(subscriptionId, { identity: normalized });
          const subscription = await refreshPendingLease(refreshed.subscription);
          refreshLease(subscription);
          openSocket();
        } catch (error) {
          if (error?.code === 'event_subscription_not_found') {
            rejectOnce(error);
            return;
          }
          scheduleReconnect();
        }
      }, delayMs);
    };

    const startHeartbeat = (candidate) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const intervalMs = Number.isFinite(Number(heartbeatIntervalMs)) && Number(heartbeatIntervalMs) > 0
        ? Number(heartbeatIntervalMs)
        : EVENT_LISTENER_HEARTBEAT_INTERVAL_MS;
      heartbeatTimer = setInterval(() => {
        if (settled || candidate.destroyed) return;
        candidate.write(JSON.stringify({
          type: 'event-heartbeat',
          identity: normalized,
          subscriptionId,
          renew: leaseRenewalEnabled,
          leaseMs,
          ...(agentId ? { agentId } : {}),
        }) + '\n');
      }, intervalMs);
      heartbeatTimer.unref?.();
    };

    const transientListenerError = (code) => new Set([
      'event_listener_closed',
      'GITHUB_COORDINATOR_TIMEOUT',
      'github_coordinator_unavailable',
      'ECONNRESET',
    ]).has(code);

    const openSocket = () => {
      if (settled) return;
      const candidate = createConnection(socketPath(normalized));
      const decodeCandidateChunk = createUtf8ChunkDecoder();
      socket = candidate;
      let buffer = '';
      let disconnected = false;
      const onDisconnect = () => {
        if (settled || disconnected) return;
        disconnected = true;
        listenerReady = false;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (socket === candidate) socket = null;
        scheduleReconnect();
      };
      candidate.on('connect', () => {
        startHeartbeat(candidate);
        candidate.write(`${JSON.stringify({
          type: 'event-listen',
          identity: normalized,
          subscriptionId,
          once,
          renew: leaseRenewalEnabled,
          leaseMs,
          ...(agentId ? { agentId } : {}),
        })}\n`);
      });
      candidate.on('data', (chunk) => {
        buffer += decodeCandidateChunk(chunk);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let response;
          try {
            response = JSON.parse(line);
          } catch (error) {
            rejectOnce(new Error(`invalid_event_listener_response: ${error.message}`));
            return;
          }
          if (response?.ok === false && response.error) {
            const error = new Error(response.error.message || response.error.code || 'event_listener_error');
            Object.assign(error, response.error);
            if (transientListenerError(error.code)) {
              onDisconnect();
              candidate.destroy();
              return;
            }
            rejectOnce(error);
            return;
          }
          if (response?.type === 'listening' || response?.type === 'heartbeat') {
            if (response.type === 'listening' && !listenerReady) {
              listenerReady = true;
              retryAttempt = 0;
            }
            refreshLease(response.subscription);
          } else if (response?.type === 'event') {
            pendingEventsPresent = true;
            if (autoRenew) leaseRenewalEnabled = true;
            event = response.event;
            candidate.write(`${JSON.stringify({
              type: 'event-ack',
              subscriptionId,
              eventId: event?.id,
            })}\n`);
          } else if (response?.type === 'acked' && event) {
            resolveOnce(event);
            candidate.end();
          }
        }
      });
      candidate.on('error', onDisconnect);
      candidate.on('close', onDisconnect);
    };

    scheduleDeadline();
    if (Number.isFinite(Number(reconcileAfterMs)) && Number(reconcileAfterMs) > 0) {
      reconcileTimer = setTimeout(() => {
        reconcileEvents(subscriptionId, { identity: normalized }).catch(() => {});
      }, Number(reconcileAfterMs));
      reconcileTimer.unref?.();
    }
    openSocket();
  });
}

export function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return { ...headers };
}

export async function requestGitHub(pathname, options = {}) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw new TypeError('github_api_path_must_be_absolute');
  }
  const response = await sendRequest({
    type: 'api',
    method: options.method || 'GET',
    path: pathname,
    headers: headersToObject(options.headers),
    body: options.body,
    cacheTtlMs: options.cacheTtlMs,
    cacheKey: options.cacheKey,
    bucket: options.bucket,
  }, { identity: options.identity });
  return response;
}

export function responseHeaders(response) {
  return {
    get(name) {
      return response?.headers?.[String(name).toLowerCase()] ?? null;
    },
    has(name) {
      return Object.prototype.hasOwnProperty.call(response?.headers || {}, String(name).toLowerCase());
    },
    entries() {
      return Object.entries(response?.headers || {});
    },
  };
}

export function responseLike(response) {
  const body = response?.body ?? '';
  return {
    status: response?.status ?? 0,
    ok: Boolean(response?.ok),
    headers: responseHeaders(response),
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}
