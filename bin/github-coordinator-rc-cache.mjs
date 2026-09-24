#!/usr/bin/env node

/**
 * Small launchd-backed credential cache for the local coordinator.
 *
 * The cache lives in launchd's per-user environment, never in the repository
 * or a log file.  The launcher only calls `persist` after Remote Config has
 * supplied a missing value; explicit environment overrides are therefore not
 * copied into launchd by accident.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RC_CACHE_KEYS = Object.freeze({
  webhookSecret: 'FRONTALIERE_GH_WEBHOOK_SECRET',
  defaultToken: 'FRONTALIERE_GH_TOKEN_DEFAULT',
  nanakoToken: 'FRONTALIERE_GH_TOKEN_NANAKO',
});

const LAUNCHCTL_TIMEOUT_MS = 2_000;

function normalizedIdentity(identity = 'default') {
  const value = String(identity || 'default').trim().toLowerCase();
  if (value !== 'default' && value !== 'nanako') {
    throw new Error(`invalid_github_identity: ${value}`);
  }
  return value;
}

export function cacheKeyForIdentity(identity = 'default') {
  return normalizedIdentity(identity) === 'nanako'
    ? RC_CACHE_KEYS.nanakoToken
    : RC_CACHE_KEYS.defaultToken;
}

function launchdServiceLabel(identity) {
  return `ch.frontaliere.github-coordinator-${normalizedIdentity(identity)}`;
}

function launchctlPath(options) {
  return options.launchctl || process.env.FRONTALIERE_LAUNCHCTL || '/bin/launchctl';
}

function runLaunchctl(args, options) {
  const execute = options.exec || execFileSync;
  return execute(launchctlPath(options), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: options.timeoutMs || LAUNCHCTL_TIMEOUT_MS,
  });
}

export function launchdCacheAvailable(options = {}) {
  if (typeof options.available === 'boolean') return options.available;
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (options.stateDirectory ?? process.env.FRONTALIERE_GH_STATE_DIR) return false;
  const userId = options.userId || (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!userId) return false;
  try {
    runLaunchctl(['print', `gui/${userId}/${launchdServiceLabel(options.identity || 'default')}`], options);
    return true;
  } catch {
    return false;
  }
}

function readLaunchdValue(key, options) {
  try {
    return String(runLaunchctl(['getenv', key], options) || '').trim();
  } catch {
    return '';
  }
}

export function readLaunchdCredentials(identity = 'default', options = {}) {
  const normalized = normalizedIdentity(identity);
  if (!launchdCacheAvailable({ ...options, identity: normalized })) return {};
  const result = {};
  const token = readLaunchdValue(cacheKeyForIdentity(normalized), options);
  const webhookSecret = readLaunchdValue(RC_CACHE_KEYS.webhookSecret, options);
  if (token) {
    result[normalized === 'nanako' ? 'FRONTALIERE_GH_TOKEN_NANAKO' : 'FRONTALIERE_GH_TOKEN'] = token;
  }
  if (webhookSecret) result.FRONTALIERE_GH_WEBHOOK_SECRET = webhookSecret;
  return result;
}

function valueForToken(identity, environment) {
  return normalizedIdentity(identity) === 'nanako'
    ? environment.FRONTALIERE_GH_TOKEN_NANAKO || environment.GITHUB_PAT_NANAKO || ''
    : environment.FRONTALIERE_GH_TOKEN || environment.GITHUB_PAT || '';
}

export function persistRemoteConfigCredentials(identity = 'default', environment = process.env, options = {}) {
  const normalized = normalizedIdentity(identity);
  if (!launchdCacheAvailable({ ...options, identity: normalized })) return false;
  const values = [];
  const tokenFlag = normalized === 'nanako'
    ? environment.FRONTALIERE_GH_RC_CACHE_NANAKO_TOKEN === '1'
    : environment.FRONTALIERE_GH_RC_CACHE_DEFAULT_TOKEN === '1';
  if (tokenFlag) {
    const token = valueForToken(normalized, environment);
    if (token) values.push([cacheKeyForIdentity(normalized), token]);
  }
  if (environment.FRONTALIERE_GH_RC_CACHE_WEBHOOK === '1'
    && environment.FRONTALIERE_GH_WEBHOOK_SECRET) {
    values.push([RC_CACHE_KEYS.webhookSecret, environment.FRONTALIERE_GH_WEBHOOK_SECRET]);
  }
  let persisted = false;
  for (const [key, value] of values) {
    try {
      runLaunchctl(['setenv', key, value], options);
      persisted = true;
    } catch {
      // launchd caching is an optimization; the current process still has the
      // loaded credentials and the next start can retry the cache write.
    }
  }
  return persisted;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseArguments(argv) {
  const command = argv[0] || '';
  let identity = 'default';
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--identity') identity = argv[++index];
  }
  return { command, identity: normalizedIdentity(identity) };
}

function main(argv = process.argv.slice(2)) {
  const { command, identity } = parseArguments(argv);
  if (command === 'hydrate') {
    const credentials = readLaunchdCredentials(identity);
    for (const [key, value] of Object.entries(credentials)) {
      process.stdout.write(`export ${key}=${shellQuote(value)}\n`);
    }
    return;
  }
  if (command === 'persist') {
    persistRemoteConfigCredentials(identity);
    return;
  }
  throw new Error('usage: github-coordinator-rc-cache.mjs <hydrate|persist> --identity <default|nanako>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`github-coordinator-rc-cache: ${error.message}\n`);
    process.exitCode = 2;
  }
}
