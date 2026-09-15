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
  constants as fsConstants,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeIdentity,
  socketPath,
} from './github-coordinator-client.mjs';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const COORDINATOR_PROTOCOL_VERSION = 2;
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
const CLI_CACHE_TTL_MS = 2_000;
const ANONYMOUS_BUDGET = 45;
const ANONYMOUS_WINDOW_MS = 60 * 60 * 1_000;
const CANCELLATION_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_CACHE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
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

function trimOutput(value, maxBytes = MAX_BODY_BYTES) {
  const text = String(value || '');
  return Buffer.byteLength(text, 'utf8') <= maxBytes
    ? text
    : `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`;
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
    : [process.env.FRONTALIERE_GH_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
  return candidates.find((value) => typeof value === 'string' && value.length > 0) || null;
}

function resolveToken(identity, realGh) {
  const fromEnvironment = tokenFromEnvironment(identity);
  if (fromEnvironment) return fromEnvironment;
  try {
    const token = execFileSync(realGh, ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    if (token) return token;
  } catch {
    // Report a redacted, actionable error below.
  }
  throw new Error(`github_token_unavailable_for_identity: ${identity}`);
}

function apiUrl(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    throw new Error('invalid_github_api_path');
  }
  return `https://api.github.com${pathname}`;
}

function cacheKeyFor(request) {
  return `${request.identity || 'default'}|${request.anonymous ? 'anonymous' : 'authenticated'}|${String(request.method || 'GET').toUpperCase()}|${request.path}|${request.body || ''}`;
}

function scopedCacheKeyFor(request) {
  if (!request.cacheKey) return cacheKeyFor(request);
  return `${request.identity || 'default'}|${request.anonymous ? 'anonymous' : 'authenticated'}|custom:${request.cacheKey}`;
}

function cliCacheKeyFor(request) {
  return `${request.identity || 'default'}|${request.anonymous ? 'anonymous' : 'authenticated'}|${request.cwd || ''}|${JSON.stringify(request.args || [])}`;
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

export class GitHubCoordinator {
  constructor({ identity, token, realGh, socket }) {
    this.identity = identity;
    this.token = token;
    this.realGh = realGh;
    this.socket = socket;
    this.queue = [];
    this.active = 0;
    this.activeMutations = 0;
    this.lastMutationAt = 0;
    this.pendingGets = new Map();
    this.pendingCli = new Map();
    this.cache = new Map();
    this.cliCache = new Map();
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
    };
  }

  status() {
    this.resetAnonymousBudget();
    this.prunePendingCancellations();
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
    for (const [bucket, observed] of this.buckets.entries()) {
      if (bucket.endsWith('-anonymous')) continue;
      const remaining = Number(observed.remaining);
      if (!Number.isFinite(remaining)) continue;
      if (remaining <= 0) return 1;

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
    return observed?.remaining === '0' && this.anonymousBudgetAvailable();
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
    const isReadCli = queuedRequest.type === 'exec' && !cliCommandIsMutation(queuedRequest.args || []);
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
        if (response?.ok) {
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
    try {
      response = await fetch(apiUrl(request.path), {
        method,
        headers,
        body: request.body === undefined || request.body === null
          ? undefined
          : typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const responseHeaders = observedHeaders(response.headers);
    this.observeBucket(bucket, responseHeaders);
    const renderedHeaders = request.anonymous
      ? { ...responseHeaders, 'x-frontaliere-auth-mode': 'anonymous' }
      : responseHeaders;
    const body = trimOutput(await response.text());
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
    if (args.includes('--watch')) {
      return {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: 'github-coordinator: --watch è vietato; usa un solo osservatore condiviso.\n',
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
        stdio: ['pipe', 'pipe', 'pipe'],
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
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        const combined = `${out}\n${err}`;
        const looksLimited = exitCode !== 0 && bodyLooksRateLimited(combined);
        resolvePromise({
          ok: exitCode === 0,
          exitCode: exitCode ?? 1,
          signal: signal || null,
          stdout: trimOutput(out),
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
  const mutating = new Set(['create', 'comment', 'close', 'reopen', 'merge', 'edit', 'delete', 'rerun', 'cancel', 'enable', 'disable', 'dispatch']);
  return mutating.has(args[1]);
}

function readTokenAndStart(identity) {
  const realGh = resolveRealGh();
  const token = resolveToken(identity, realGh);
  const socket = socketPath(identity);
  const parent = dirname(socket);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try { chmodSync(parent, 0o700); } catch { /* best effort */ }

  const coordinator = new GitHubCoordinator({ identity, token, realGh, socket });
  let terminate = () => {};
  const server = createServer((connection) => {
    let buffer = '';
    let handled = false;
    connection.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while (!handled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        handled = true;
        let request;
        try {
          request = JSON.parse(line);
        } catch (error) {
          connection.end(`${JSON.stringify({ ok: false, error: { code: 'invalid_request', message: error.message } })}\n`);
          return;
        }
        let result;
        if (request.type === 'ping') {
          result = Promise.resolve({ ok: true, status: coordinator.status() });
        } else if (request.type === 'status') {
          result = Promise.resolve({ ok: true, status: coordinator.status() });
        } else if (request.type === 'shutdown') {
          result = Promise.resolve({ ok: true });
        } else if (request.type === 'cancellation-details') {
          result = Promise.resolve(coordinator.getPendingCancellation(request.requestId));
        } else if (request.type === 'confirm-cancellation') {
          result = coordinator.confirmCancellation(request.requestId, request.confirmation);
        } else if (request.type === 'api' || request.type === 'exec') {
          result = coordinator.submit(request);
        } else {
          result = Promise.resolve({ ok: false, error: { code: 'unsupported_request_type' } });
        }
        result.then((response) => {
          connection.end(`${JSON.stringify(response)}\n`);
          if (request.type === 'shutdown') setTimeout(terminate, 10);
        }).catch((error) => {
          connection.end(`${JSON.stringify({ ok: false, error: { code: error.code || 'coordinator_error', message: error.message } })}\n`);
        });
      }
    });
  });

  let terminating = false;
  terminate = () => {
    if (terminating) return;
    terminating = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000);
  };

  const cleanUp = () => {
    try { unlinkSync(socket); } catch { /* already gone */ }
    try { unlinkSync(`${socket}.start`); } catch { /* no start lock */ }
  };
  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') process.stderr.write(`github-coordinator: ${error.message}\n`);
    process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
  });
  server.on('listening', () => {
    try { chmodSync(socket, 0o600); } catch { /* best effort */ }
    try { unlinkSync(`${socket}.start`); } catch { /* no start lock */ }
  });
  server.on('close', cleanUp);
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);

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
