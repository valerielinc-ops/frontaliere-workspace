#!/usr/bin/env node

/**
 * Client for the per-user GitHub coordinator daemon.
 *
 * The protocol is intentionally tiny: one JSON request and one JSON response
 * per Unix-socket connection.  Tokens never cross the socket; the daemon
 * resolves the selected identity locally and keeps the credential in memory.
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
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
const SERVER = join(THIS_DIR, 'github-coordinator.mjs');
const DEFAULT_STATE_DIR = join(homedir(), 'Library', 'Caches', 'frontaliere');
const CONNECT_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 15_000;
const START_LOCK_STALE_MS = 30_000;

export function normalizeIdentity(value = process.env.FRONTALIERE_GH_IDENTITY || 'default') {
  const identity = String(value || 'default').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(identity)) {
    throw new Error(`invalid_github_identity: ${identity}`);
  }
  return identity;
}

export function stateDirectory() {
  return process.env.FRONTALIERE_GH_STATE_DIR || DEFAULT_STATE_DIR;
}

export function socketPath(identity = normalizeIdentity()) {
  return join(stateDirectory(), `github-coordinator-${normalizeIdentity(identity)}.sock`);
}

function startLockPath(identity) {
  return `${socketPath(identity)}.start`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function connectOnce(request, { identity, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const targetSocket = socketPath(identity);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let buffer = '';
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
      buffer += chunk.toString('utf8');
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
      if (!settled) rejectOnce(new Error(`github_coordinator_unavailable: ${targetSocket}`));
    });
  });
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
    try { unlinkSync(socketPath(identity)); } catch { /* no stale socket */ }
    const child = spawn(process.execPath, [SERVER, 'serve', '--identity', identity], {
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
    await connectOnce({ type: 'ping' }, { identity: normalized });
    return;
  } catch {
    // A concurrent client may be starting the same daemon.  The server owns
    // the bind race; clients simply retry the same socket below.
  }

  await startDaemon(normalized);
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await connectOnce({ type: 'ping' }, { identity: normalized });
      return;
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

export async function sendRequest(request, { identity = normalizeIdentity() } = {}) {
  const normalized = normalizeIdentity(identity);
  await ensureCoordinator(normalized);
  const response = await connectOnce({ ...request, identity: normalized }, { identity: normalized });
  if (response?.ok === false && response?.error) {
    const error = new Error(response.error.message || response.error.code || 'github_coordinator_error');
    Object.assign(error, response.error);
    throw error;
  }
  return response;
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
