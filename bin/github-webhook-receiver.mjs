#!/usr/bin/env node

/**
 * Small HTTP ingress for GitHub webhooks.
 *
 * Keep this listener behind a TLS reverse proxy or an authenticated tunnel.
 * The coordinator still verifies X-Hub-Signature-256 before accepting data.
 */

import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestGitHubWebhook } from './github-coordinator-client.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_PATH = '/github/webhook';
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
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

function installSourceReloadWatcher(onReload, { getActiveRequests = () => 0 } = {}) {
  let triggered = false;
  let watcher;
  let scheduler;
  const triggerReload = () => {
    if (triggered) return;
    triggered = true;
    scheduler.stop();
    try { watcher?.close(); } catch { /* watcher already closed */ }
    process.stderr.write('github-webhook-receiver: source quiescent; restarting under supervisor\n');
    onReload();
  };
  scheduler = createDebouncedReloadScheduler({ onReload: triggerReload, getActiveRequests });
  try {
    watcher = watch(THIS_DIR, { persistent: false }, (_eventType, filename) => {
      const name = String(filename || '');
      if (triggered || !WATCHED_SOURCE_NAMES.has(name)) return;
      if (scheduler.request()) {
        process.stderr.write(
          `github-webhook-receiver: source changed; restart scheduled (debounce=${SOURCE_RELOAD_DEBOUNCE_MS}ms, quiescence=${SOURCE_RELOAD_QUIESCENCE_MS}ms)\n`,
        );
      }
    });
  } catch (error) {
    process.stderr.write(`github-webhook-receiver: source watcher unavailable: ${error.message}\n`);
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

export function createGitHubWebhookReceiver({
  identity,
  path = DEFAULT_PATH,
  onRequestStart = () => {},
  onRequestEnd = () => {},
} = {}) {
  return createServer(async (request, response) => {
    onRequestStart();
    try {
      if (request.method !== 'POST' || request.url?.split('?')[0] !== path) {
        jsonResponse(response, 404, { ok: false, error: 'not_found' });
        return;
      }
      const rawBody = await readBody(request);
      const result = await ingestGitHubWebhook({
        eventName: header(request, 'x-github-event'),
        deliveryId: header(request, 'x-github-delivery'),
        signature: header(request, 'x-hub-signature-256'),
        rawBody,
      }, { identity });
      jsonResponse(response, 202, result);
    } catch (error) {
      const status = webhookErrorStatus(error);
      jsonResponse(response, status, { ok: false, error: error.code || error.message });
    } finally {
      onRequestEnd();
    }
  });
}

function optionValue(args, name, fallback) {
  const index = args.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return fallback;
  return args[index].startsWith(`${name}=`) ? args[index].slice(name.length + 1) : args[index + 1] || fallback;
}

function main() {
  const args = process.argv.slice(2);
  const identity = optionValue(args, '--identity', process.env.FRONTALIERE_GH_IDENTITY);
  const host = optionValue(args, '--host', process.env.FRONTALIERE_WEBHOOK_HOST || DEFAULT_HOST);
  const port = Number(optionValue(args, '--port', process.env.FRONTALIERE_WEBHOOK_PORT || DEFAULT_PORT));
  const path = optionValue(args, '--path', process.env.FRONTALIERE_WEBHOOK_PATH || DEFAULT_PATH);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('webhook_port_invalid');
  let activeRequestCount = 0;
  let stopSourceWatcher = () => {};
  let terminating = false;
  const server = createGitHubWebhookReceiver({
    identity,
    path,
    onRequestStart: () => { activeRequestCount += 1; },
    onRequestEnd: () => { activeRequestCount = Math.max(0, activeRequestCount - 1); },
  });
  const terminate = (exitCode = 0) => {
    if (terminating) {
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }
    terminating = true;
    stopSourceWatcher();
    server.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 1_000);
  };
  server.on('error', (error) => {
    process.stderr.write(`github-webhook-receiver: ${error.message}\n`);
    terminate(1);
  });
  installProcessSafetyHandlers(terminate);
  server.listen(port, host, () => {
    stopSourceWatcher = installSourceReloadWatcher(terminate, {
      getActiveRequests: () => activeRequestCount,
    });
    process.stdout.write(`github-webhook-receiver listening on http://${host}:${port}${path}\n`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`github-webhook-receiver: ${error.message}\n`);
    process.exitCode = 1;
  }
}
