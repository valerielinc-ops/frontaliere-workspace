#!/usr/bin/env node

/**
 * Remote Config credential cache for the coordinator launcher.
 *
 * Every launchd start used to reload Remote Config, which needs the network,
 * the service account and the corpus checkout's loader: when any of them was
 * missing the coordinator did not start at all (2026-09-17, nanako). The
 * values the launcher loads are cached in the login keychain and reused on
 * the next start. Salvaged from root PR #97, which cached them with
 * `launchctl setenv`: that exports the owner PAT to every application launched
 * afterwards, while a keychain item stays encrypted and is read only by the
 * `security` tool that created it.
 *
 * An entry older than RC_CACHE_MAX_AGE_MS is refreshed from Remote Config, so
 * a rotated token reaches the coordinator within a day; a stale entry is used
 * only when Remote Config cannot be loaded. Explicit environment values always
 * win and are never written to the cache. Every failure is fail-open: the
 * launcher falls back to Remote Config exactly as before.
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RC_CACHE_SERVICE = 'ch.frontaliere.github-coordinator.rc-cache';
export const RC_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SECURITY_TIMEOUT_MS = 5_000;
const ITEM_LABEL = 'frontaliere github coordinator: Remote Config cache';

// What each identity needs, the name the coordinator reads it from, and the
// environment names that already supply it (an explicit value or Remote
// Config's own name for it).
const WEBHOOK_SECRET = {
  account: 'webhook-secret',
  exportAs: 'FRONTALIERE_GH_WEBHOOK_SECRET',
  sources: ['FRONTALIERE_GH_WEBHOOK_SECRET'],
};
export const RC_CACHE_VALUES = Object.freeze({
  default: Object.freeze([
    { account: 'token-default', exportAs: 'FRONTALIERE_GH_TOKEN', sources: ['FRONTALIERE_GH_TOKEN', 'GITHUB_PAT'] },
    WEBHOOK_SECRET,
  ]),
  nanako: Object.freeze([
    { account: 'token-nanako', exportAs: 'FRONTALIERE_GH_TOKEN_NANAKO', sources: ['FRONTALIERE_GH_TOKEN_NANAKO', 'GITHUB_PAT_NANAKO'] },
    WEBHOOK_SECRET,
  ]),
});

function normalizedIdentity(identity = 'default') {
  const value = String(identity || 'default').trim().toLowerCase();
  if (!Object.hasOwn(RC_CACHE_VALUES, value)) throw new Error(`invalid_github_identity: ${value}`);
  return value;
}

function environmentValue(environment, names) {
  for (const name of names) {
    if (typeof environment[name] === 'string' && environment[name] !== '') return environment[name];
  }
  return '';
}

function securityPath(options) {
  return options.security || options.environment?.FRONTALIERE_SECURITY_BIN || '/usr/bin/security';
}

function serviceName(options) {
  return options.service || options.environment?.FRONTALIERE_GH_RC_CACHE_SERVICE || RC_CACHE_SERVICE;
}

/**
 * Off outside macOS, when disabled (FRONTALIERE_GH_RC_CACHE=0) and under an
 * isolated state directory: test daemons must never read the owner's keychain.
 */
export function rcCacheAvailable(options = {}) {
  const environment = options.environment || process.env;
  if (typeof options.available === 'boolean') return options.available;
  if ((options.platform || process.platform) !== 'darwin') return false;
  if (environment.FRONTALIERE_GH_RC_CACHE === '0') return false;
  if (environment.FRONTALIERE_GH_STATE_DIR && !environment.FRONTALIERE_SECURITY_BIN) return false;
  try {
    accessSync(securityPath({ ...options, environment }), fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runSecurity(args, options) {
  const execute = options.exec || execFileSync;
  return execute(securityPath(options), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: options.timeoutMs || SECURITY_TIMEOUT_MS,
  });
}

function readEntry(account, options) {
  try {
    const raw = String(runSecurity(['find-generic-password', '-s', serviceName(options), '-a', account, '-w'], options)).trim();
    const entry = JSON.parse(raw);
    if (typeof entry?.value !== 'string' || entry.value === '' || !Number.isFinite(Number(entry.storedAt))) return null;
    return { value: entry.value, storedAt: Number(entry.storedAt) };
  } catch {
    // Missing item, locked keychain, malformed value: all mean "no cache".
    return null;
  }
}

/**
 * Cached values for the names the environment does not already supply.
 * `complete` is false when one of them is missing; `fresh` is false when one
 * is older than `maxAgeMs` (Infinity accepts any age).
 */
export function readCachedCredentials(identity = 'default', options = {}) {
  const environment = options.environment || process.env;
  const normalized = normalizedIdentity(identity);
  const context = { ...options, environment };
  const result = { values: {}, complete: true, fresh: true };
  if (!rcCacheAvailable(context)) return { values: {}, complete: false, fresh: false };
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? RC_CACHE_MAX_AGE_MS;
  for (const spec of RC_CACHE_VALUES[normalized]) {
    if (environmentValue(environment, spec.sources)) continue;
    const entry = readEntry(spec.account, context);
    if (!entry) {
      result.complete = false;
      continue;
    }
    if (nowMs - entry.storedAt > maxAgeMs) result.fresh = false;
    result.values[spec.exportAs] = entry.value;
  }
  return result;
}

/**
 * Store the values named in `only` (export names) from the environment. The
 * launcher passes exactly the names Remote Config just filled in, so an
 * explicit override never lands in the keychain.
 */
export function persistCredentials(identity = 'default', { only = [], ...options } = {}) {
  const environment = options.environment || process.env;
  const normalized = normalizedIdentity(identity);
  const context = { ...options, environment };
  if (!rcCacheAvailable(context)) return 0;
  const wanted = new Set(only);
  const nowMs = options.nowMs ?? Date.now();
  let written = 0;
  for (const spec of RC_CACHE_VALUES[normalized]) {
    if (!wanted.has(spec.exportAs)) continue;
    const value = environmentValue(environment, spec.sources);
    if (!value) continue;
    try {
      runSecurity([
        'add-generic-password', '-U',
        '-s', serviceName(context),
        '-a', spec.account,
        '-l', ITEM_LABEL,
        '-w', JSON.stringify({ value, storedAt: nowMs }),
      ], context);
      written += 1;
    } catch {
      // Caching is an optimization: this start already has its credentials.
    }
  }
  return written;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseArguments(argv) {
  const parsed = { command: argv[0] || '', identity: 'default', any: false, only: [] };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--identity') parsed.identity = argv[++index];
    else if (argv[index] === '--any') parsed.any = true;
    else if (argv[index] === '--only') parsed.only = String(argv[++index] || '').split(/[,\s]+/).filter(Boolean);
  }
  parsed.identity = normalizedIdentity(parsed.identity);
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const { command, identity, any, only } = parseArguments(argv);
  if (command === 'hydrate') {
    // Prints shell exports only for a complete set: fresh by default, of any
    // age with --any (the fallback when Remote Config could not be loaded).
    const cached = readCachedCredentials(identity, { maxAgeMs: any ? Infinity : RC_CACHE_MAX_AGE_MS });
    if (!cached.complete || (!any && !cached.fresh)) return;
    for (const [name, value] of Object.entries(cached.values)) {
      process.stdout.write(`export ${name}=${shellQuote(value)}\n`);
    }
    return;
  }
  if (command === 'persist') {
    persistCredentials(identity, { only });
    return;
  }
  throw new Error('usage: github-coordinator-rc-cache.mjs <hydrate [--any]|persist --only NAMES> --identity <default|nanako>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`github-coordinator-rc-cache: ${error.message}\n`);
    process.exitCode = 2;
  }
}
