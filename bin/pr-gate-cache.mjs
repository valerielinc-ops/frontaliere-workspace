#!/usr/bin/env node
/**
 * Debounce del gate sibling prima di `gh pr create`.
 *
 * Il risultato e' valido solo per una finestra breve e per la combinazione
 * esatta di comando, cwd, HEAD/base, body-file e codice dei gate. Un lock
 * atomico fa attendere i chiamanti concorrenti invece di lanciare piu' sweep
 * identici; gli errori del cache layer restano fail-open come il dispatcher.
 */
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellExecutableText } from './shell-command-scanner.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_TTL_MS = 60 * 1000;
const LOCK_WAIT_MS = 30 * 1000;

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function gitRefs(cwd) {
  try {
    const values = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD', 'origin/main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
    return { head: values[0] ?? '', base: values[1] ?? '' };
  } catch {
    return { head: '', base: '' };
  }
}

function parsePayload(raw) {
  try {
    const payload = JSON.parse(String(raw || '').trim() || '{}');
    return {
      payload,
      command: String(payload?.tool_input?.command ?? payload?.command ?? ''),
      cwd: String(payload?.cwd ?? payload?.tool_input?.cwd ?? process.cwd()),
    };
  } catch {
    return { payload: {}, command: '', cwd: process.cwd() };
  }
}

function isPrCreate(command) {
  return /(?:^|[;&|()\n]\s*)(?:command\s+)?gh\s+pr\s+create\b/.test(shellExecutableText(command));
}

function statSignature(file) {
  try {
    const stat = statSync(file);
    let contentHash = '';
    if (stat.isFile() && stat.size <= 2 * 1024 * 1024) contentHash = hash(readFileSync(file));
    return `${file}:${stat.mtimeMs}:${stat.size}:${contentHash}`;
  } catch {
    return `${file}:missing`;
  }
}

function bodyFileFromCommand(command, cwd) {
  const match = String(command).match(/(?:^|\s)--body-file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!match) return undefined;
  return path.resolve(cwd, match[1] ?? match[2] ?? match[3]);
}

export function cacheContext({ command, cwd, workspace = ROOT, dispatcher, gateFiles = [] }) {
  const resolvedCwd = path.resolve(cwd || workspace);
  const refs = gitRefs(resolvedCwd);
  const bodyFile = bodyFileFromCommand(command, resolvedCwd);
  const files = [
    dispatcher,
    path.join(workspace, 'frontaliere-si-o-no', 'scripts', 'ci', 'sibling-check-gate.mjs'),
    path.join(workspace, 'frontaliere-si-o-no', 'scripts', 'ci', 'check-sibling-patterns.mjs'),
    ...gateFiles,
  ].filter(Boolean);
  return {
    commandHash: hash(command),
    cwd: resolvedCwd,
    head: refs.head,
    base: refs.base,
    body: bodyFile ? statSignature(bodyFile) : 'inline-body',
    code: files.map(statSignature).sort(),
  };
}

export function cacheKey(context) {
  return hash(JSON.stringify(context));
}

function cacheDirectory(workspace) {
  const configured = process.env.FRONTALIERE_AGENT_RUNTIME_DIR?.trim();
  return path.join(configured ? path.resolve(configured) : path.join(os.tmpdir(), `frontaliere-agent-runtime-${hash(workspace).slice(0, 16)}`), 'pr-gate-cache');
}

function readCache(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || value.expiresAt < Date.now()) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeCache(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    // rename is atomic on the same filesystem and avoids readers seeing a
    // partially-written gate verdict.
    requireRename(temp, file);
  } catch {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
}

function requireRename(from, to) {
  // Kept as a tiny indirection so the module remains easy to exercise in
  // tests without monkey-patching fs globally.
  return renameSync(from, to);
}

function acquireLock(file) {
  try {
    const fd = openSync(file, 'wx', 0o600);
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
    try {
      if (Date.now() - statSync(file).mtimeMs > LOCK_WAIT_MS) unlinkSync(file);
    } catch { /* another caller owns or removed it */ }
    return false;
  }
}

function waitForCache(file, lockFile) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const cached = readCache(file);
    if (cached) return { cached };
    if (acquireLock(lockFile)) return { lockAcquired: true };
    Atomics.wait(cell, 0, 0, 50);
  }
  return { timedOut: true };
}

function emitCached(value) {
  if (value?.stdout) process.stdout.write(value.stdout);
  if (value?.stderr) process.stderr.write(value.stderr);
  return Number.isInteger(value?.status) ? value.status : 0;
}

function main() {
  const raw = readFileSync(0, 'utf8');
  const parsed = parsePayload(raw);
  if (!isPrCreate(parsed.command)) return 0;

  const workspace = path.resolve(process.env.WORKSPACE || ROOT);
  const dispatcher = path.join(workspace, '.codex', 'repo-pr-gate-dispatch.mjs');
  if (!existsSync(dispatcher)) return 0;
  const context = cacheContext({ command: parsed.command, cwd: parsed.cwd, workspace, dispatcher });
  const key = cacheKey(context);
  const directory = cacheDirectory(workspace);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${key}.json`);
  const lockFile = `${file}.lock`;
  const immediate = readCache(file);
  if (immediate) return emitCached(immediate);
  const waited = waitForCache(file, lockFile);
  if (waited.cached) return emitCached(waited.cached);

  // If the caller acquired the lock, it owns the cache write. After a timeout
  // run fail-open and do not overwrite another caller's lock/result.
  const ownsLock = Boolean(waited.lockAcquired);
  if (!ownsLock) {
    const afterWait = readCache(file);
    if (afterWait) return emitCached(afterWait);
  }

  const result = spawnSync(process.execPath, [dispatcher], {
    cwd: parsed.cwd,
    input: raw,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const status = result.error ? 0 : (result.status ?? 0);
  const value = {
    version: 1,
    key,
    createdAt: Date.now(),
    expiresAt: Date.now() + (Number(process.env.FRONTALIERE_PR_GATE_CACHE_MS) || DEFAULT_TTL_MS),
    status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
  if (!result.error && ownsLock && [0, 1, 2].includes(status)) writeCache(file, value);
  if (ownsLock) {
    try { unlinkSync(lockFile); } catch { /* already gone */ }
  }
  if (value.stdout) process.stdout.write(value.stdout);
  if (value.stderr) process.stderr.write(value.stderr);
  return status;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE;
if (isMain) {
  try {
    process.exitCode = main();
  } catch {
    // A cache failure must not stop PR creation; the underlying dispatcher is
    // itself fail-safe and the remote checks remain authoritative.
    process.exitCode = 0;
  }
}
