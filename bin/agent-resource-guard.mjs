#!/usr/bin/env node
/**
 * Guardrail condivisi per i comandi Bash degli agenti.
 *
 * Il processo del hook non e' il processo del comando Bash: per questo file
 * registriamo il comando e deleghiamo la misura PID/RSS/CPU a
 * agent-command-observer.mjs. Il guard non uccide mai processi non creati da
 * lui; il cleanup puo' terminare soltanto i propri observer detached.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellExecutableText } from './shell-command-scanner.mjs';

export const GUARD_VERSION = 1;
export const DEFAULT_LEASE_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_PRESSURE_FREE_PERCENT = 8;
export const DEFAULT_SWAP_USED_RATIO = 0.85;

const THIS_FILE = fileURLToPath(import.meta.url);
const BIN_DIR = path.dirname(THIS_FILE);
const WORKSPACE_FROM_BIN = path.resolve(BIN_DIR, '..');
const LEASE_NAME = 'heavy-lease.json';
const COMMANDS_NAME = 'commands.jsonl';
const PENDING_DIR = 'pending';
const OBSERVER_REGISTRY_NAME = 'observers.jsonl';
const MAX_COMMAND_TEXT = 4000;

function now() {
  return Date.now();
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function realDirectory(candidate) {
  if (!candidate || !isDirectory(candidate)) return undefined;
  try {
    return path.resolve(candidate);
  } catch {
    return undefined;
  }
}

/** Find the workspace root without assuming that the hook cwd is the root. */
export function findWorkspace(start = process.cwd()) {
  const configured = realDirectory(process.env.WORKSPACE);
  if (configured && existsSync(path.join(configured, '.codex', 'hooks.json'))) {
    return configured;
  }

  let current = realDirectory(start) ?? WORKSPACE_FROM_BIN;
  while (current) {
    if (existsSync(path.join(current, '.codex', 'hooks.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return WORKSPACE_FROM_BIN;
}

export function runtimeDirectory(workspace = findWorkspace()) {
  const configured = process.env.FRONTALIERE_AGENT_RUNTIME_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.tmpdir(), `frontaliere-agent-runtime-${sha256(workspace).slice(0, 16)}`);
}

function ensureRuntime(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(runtimeDir, PENDING_DIR), { recursive: true, mode: 0o700 });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function appendJson(runtimeDir, value) {
  try {
    ensureRuntime(runtimeDir);
    const file = path.join(runtimeDir, COMMANDS_NAME);
    appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    // Keep an accidental forgotten session from making the temporary runtime
    // directory grow forever. The report remains useful under this limit.
    try {
      if (statSync(file).size > 16 * 1024 * 1024) {
        const rotated = `${file}.1`;
        try { unlinkSync(rotated); } catch { /* already absent */ }
        renameSync(file, rotated);
      }
    } catch { /* telemetry is best effort */ }
  } catch {
    // A telemetry failure must never make Bash fail.
  }
}

function appendRegistry(runtimeDir, value) {
  try {
    ensureRuntime(runtimeDir);
    appendFileSync(path.join(runtimeDir, OBSERVER_REGISTRY_NAME), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // best effort
  }
}

function readRegistry(runtimeDir) {
  try {
    return readFileSync(path.join(runtimeDir, OBSERVER_REGISTRY_NAME), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry && Number.isInteger(entry.pid));
  } catch {
    return [];
  }
}

function writeRegistry(runtimeDir, entries) {
  try {
    writeJsonLines(path.join(runtimeDir, OBSERVER_REGISTRY_NAME), entries);
  } catch {
    // best effort
  }
}

function writeJsonLines(file, entries) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), {
    mode: 0o600,
  });
  renameSync(temp, file);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function parsePayload(raw) {
  try {
    const payload = JSON.parse(String(raw || '').trim() || '{}');
    const input = payload?.tool_input ?? {};
    const command = String(input.command ?? payload.command ?? '');
    const cwd = String(payload.cwd ?? input.cwd ?? process.cwd());
    const sessionId = String(
      payload.session_id ?? payload.sessionId ?? input.session_id ?? input.sessionId ?? 'unknown-session',
    );
    const toolCallId = String(
      payload.tool_call_id ?? payload.toolCallId ?? input.tool_call_id ?? input.toolCallId ?? '',
    );
    return { payload, command, cwd, sessionId, toolCallId };
  } catch {
    return { payload: {}, command: '', cwd: process.cwd(), sessionId: 'unknown-session', toolCallId: '' };
  }
}

/** Remove the most common secret-shaped values before writing command telemetry. */
export function redactCommand(command) {
  return String(command ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/(ghp_|github_pat_|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{20,})[A-Za-z0-9._~+/=-]*/g, '<redacted>')
    .replace(/(--?(?:token|password|secret|api[-_]?key|credential)(?:=|\s+))[^\s;&|]+/gi, '$1<redacted>')
    .slice(0, MAX_COMMAND_TEXT);
}

function commandText(command) {
  return shellExecutableText(String(command ?? '')).replace(/\s+/g, ' ').trim();
}

function hasBoundedCompilerArgs(command) {
  return /(?:^|\s)(?:--incremental|--build(?:\s|$)|--project(?:=|\s))/.test(command);
}

function isDirectCompilerInvocation(command) {
  return (
    /(?:^|[;&|()]\s*)(?:env\s+[^;&|]+\s+)?tsc(?:\s|$)/.test(command) ||
    /\bnpx\s+(?:-y\s+)?tsc\b/.test(command) ||
    /\bnpm\s+exec(?:\s+[^;&|]+)?\s+tsc\b/.test(command) ||
    /\b(?:typescript\/bin\/tsc|node_modules\/\.bin\/tsc)\b/.test(command)
  );
}

function distinctiveGitToken(command) {
  const raw = String(command ?? '');
  const pickaxe = raw.match(/-[SG](?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (pickaxe) {
    const token = (pickaxe[1] ?? pickaxe[2] ?? pickaxe[3] ?? '').match(/[A-Za-z0-9][A-Za-z0-9_.:\/-]{3,}/)?.[0];
    if (token) return token;
  }
  const grepPattern = raw.match(/(?:^|\s)(?:-e|--regexp|--fixed-strings)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (grepPattern) {
    const token = (grepPattern[1] ?? grepPattern[2] ?? grepPattern[3] ?? '').match(/[A-Za-z0-9][A-Za-z0-9_.:\/-]{3,}/)?.[0];
    if (token) return token;
  }
  const ignored = new Set(['git', 'log', 'grep', 'rev-list', 'all', 'oneline', 'fixed-strings', 'extended-regexp', 'objects', 'parents', 'boundary']);
  return raw.match(/[A-Za-z0-9][A-Za-z0-9_.:\/-]{4,}/g)?.find((token) => !ignored.has(token.toLowerCase()));
}

/**
 * Classify only commands that can materially compete for the machine. Plain
 * `git log` and `npm run typecheck` are still serialized, but only direct
 * unbounded compiler and history scans are rejected with a remediation.
 */
export function classifyCommand(command) {
  const text = commandText(command);
  if (!text) return { kind: 'none', heavy: false, text };

  const historyLog = /\bgit\s+(?:-[^\s]+\s+)*log\b/.test(text);
  const historyRevList = /\bgit\s+(?:-[^\s]+\s+)*rev-list\b/.test(text);
  const historyGrep = /\bgit\s+(?:-[^\s]+\s+)*grep\b/.test(text);
  const pickaxe = /(?:^|\s)(?:-S\S*|-G\S*|--pickaxe(?:-all|-regex)?)(?:\s|$)/.test(text);
  const allRefs = /(?:^|\s)--all(?:\s|$)/.test(text);
  if ((historyLog && allRefs && pickaxe) || (historyRevList && allRefs) || historyGrep) {
    const historyNeedle = distinctiveGitToken(command);
    const broadGrep = historyGrep && (!/\s--\s+\S/.test(text) || /\s--\s+(?:\.|:\()/.test(text));
    return {
      kind: 'git-history',
      heavy: true,
      unbounded: broadGrep || (allRefs && !/(?:--since|--after|--max-count|-n\s)/.test(text)),
      text,
      reason: 'ricerca Git su molti ref o sull’intero indice',
      matchNeedle: historyNeedle,
    };
  }

  const compiler = /\b(?:tsc|typescript\/bin\/tsc|node_modules\/\.bin\/tsc)\b/.test(text) ||
    /\bnpm\s+run\s+(?:typecheck|typecheck:gate|typecheck:list|typecheck:baseline)\b/.test(text);
  if (compiler) {
    const direct = isDirectCompilerInvocation(text);
    return {
      kind: 'typecheck',
      heavy: true,
      unbounded: direct && !hasBoundedCompilerArgs(text),
      text,
      reason: 'typecheck TypeScript dell’intero progetto',
      matchNeedle: 'tsc',
    };
  }

  if (/\b(?:check-sibling-patterns|sibling-check-gate)\.mjs\b/.test(text)) {
    return {
      kind: 'sibling-gate',
      heavy: true,
      unbounded: false,
      text,
      reason: 'sweep dei file gemelli',
      matchNeedle: text.includes('check-sibling-patterns') ? 'check-sibling-patterns' : 'sibling-check-gate',
    };
  }

  if (/\b(?:vite\s+build|npm\s+run\s+build|npm\s+run\s+test|vitest\s+run|playwright\s+test)\b/.test(text)) {
    const matchNeedle = text.includes('vite') ? 'vite' : text.includes('vitest') ? 'vitest' : text.includes('playwright') ? 'playwright' : 'node';
    return {
      kind: 'build-or-test',
      heavy: true,
      unbounded: false,
      text,
      reason: 'build o suite di test',
      matchNeedle,
    };
  }

  return { kind: 'none', heavy: false, text };
}

function parseSize(value) {
  const match = String(value ?? '').match(/([\d.]+)\s*([KMGT]?B?)/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase().replace(/B$/, '');
  const multiplier = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit];
  return Number.isFinite(amount) && multiplier ? amount * multiplier : undefined;
}

function runQuiet(command, args, timeout = 1500) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

export function readHostSnapshot() {
  const memoryOutput = process.platform === 'darwin' ? runQuiet('memory_pressure', ['-Q']) : '';
  const freeMatch = memoryOutput.match(/free percentage\s*:\s*([\d.]+)%/i);
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();

  const swapOutput = process.platform === 'darwin' ? runQuiet('sysctl', ['-n', 'vm.swapusage']) : '';
  const swapTotalMatch = swapOutput.match(/total\s*=\s*([\d.]+\s*[KMGT]?B?)/i);
  const swapUsedMatch = swapOutput.match(/used\s*=\s*([\d.]+\s*[KMGT]?B?)/i);
  const swapTotalBytes = parseSize(swapTotalMatch?.[1]);
  const swapUsedBytes = parseSize(swapUsedMatch?.[1]);

  let processCount;
  const ps = runQuiet('ps', ['-A', '-o', 'pid=']);
  if (ps) processCount = ps.split('\n').filter((line) => line.trim()).length;

  return {
    capturedAt: new Date().toISOString(),
    loadavg1: os.loadavg()[0],
    freePercent: freeMatch ? Number(freeMatch[1]) : (totalBytes ? (freeBytes / totalBytes) * 100 : undefined),
    freeBytes,
    totalBytes,
    swapUsedBytes,
    swapTotalBytes,
    processCount,
  };
}

export function pressureDecision(snapshot, options = {}) {
  const freeThreshold = numberFromEnv('FRONTALIERE_RESOURCE_FREE_PERCENT', options.freePercent ?? DEFAULT_PRESSURE_FREE_PERCENT);
  const swapRatioThreshold = numberFromEnv('FRONTALIERE_RESOURCE_SWAP_RATIO', options.swapRatio ?? DEFAULT_SWAP_USED_RATIO);
  if (Number.isFinite(snapshot?.freePercent) && snapshot.freePercent <= freeThreshold) {
    return {
      blocked: true,
      reason: `memoria libera ${snapshot.freePercent.toFixed(1)}% (soglia ${freeThreshold}%)`,
    };
  }
  if (
    Number.isFinite(snapshot?.swapUsedBytes) &&
    Number.isFinite(snapshot?.swapTotalBytes) &&
    snapshot.swapTotalBytes > 0 &&
    snapshot.swapUsedBytes / snapshot.swapTotalBytes >= swapRatioThreshold
  ) {
    const ratio = (snapshot.swapUsedBytes / snapshot.swapTotalBytes) * 100;
    return { blocked: true, reason: `swap utilizzato ${ratio.toFixed(1)}% (soglia ${(swapRatioThreshold * 100).toFixed(0)}%)` };
  }
  return { blocked: false };
}

export function invocationId(info) {
  return sha256(JSON.stringify({
    sessionId: info.sessionId,
    toolCallId: info.toolCallId,
    command: info.command,
    cwd: info.cwd,
  })).slice(0, 32);
}

function leasePath(runtimeDir) {
  return path.join(runtimeDir, LEASE_NAME);
}

function readLease(runtimeDir) {
  const lease = readJson(leasePath(runtimeDir));
  if (!lease || typeof lease !== 'object') return undefined;
  return lease;
}

function removeLease(runtimeDir) {
  try { unlinkSync(leasePath(runtimeDir)); } catch { /* already gone */ }
}

export function acquireHeavyLease(runtimeDir, lease) {
  ensureRuntime(runtimeDir);
  const file = leasePath(runtimeDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = readLease(runtimeDir);
    if (current && Number(current.expiresAt) > now()) return { acquired: false, current };
    if (current) removeLease(runtimeDir);
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(lease)}\n`);
      } finally {
        closeSync(fd);
      }
      return { acquired: true, lease };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { acquired: false, error };
    }
  }
  return { acquired: false, current: readLease(runtimeDir) };
}

function pendingPath(runtimeDir, id) {
  return path.join(runtimeDir, PENDING_DIR, `${id}.json`);
}

function writePending(runtimeDir, id, value) {
  ensureRuntime(runtimeDir);
  writeJsonAtomic(pendingPath(runtimeDir, id), value);
}

function readPending(runtimeDir, id) {
  return readJson(pendingPath(runtimeDir, id));
}

function removePending(runtimeDir, id) {
  try { unlinkSync(pendingPath(runtimeDir, id)); } catch { /* already gone */ }
}

function extractExitCode(payload) {
  const candidates = [
    payload?.tool_response?.exit_code,
    payload?.tool_response?.exitCode,
    payload?.tool_response?.status,
    payload?.exit_code,
    payload?.exitCode,
  ];
  for (const value of candidates) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function isBypassEnabled() {
  return process.env.FRONTALIERE_RESOURCE_GUARD_BYPASS === '1';
}

function observerPath() {
  return path.join(BIN_DIR, 'agent-command-observer.mjs');
}

function observerBaselinePids(classification) {
  const output = runQuiet('ps', ['-axo', 'pid=,command=']);
  const needle = classification.matchNeedle ?? '';
  const pids = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    if (command.includes('agent-command-observer.mjs')) continue;
    const matched = classification.kind === 'git-history'
      ? Boolean(needle) && command.includes(needle) && /\/git\s+(?:log|rev-list|grep)\b/.test(command)
      : classification.kind === 'typecheck'
        ? /(?:^|[\s/])tsc(?:\.js)?(?:\s|$)/.test(command) || command.includes('/typescript/bin/tsc')
        : classification.kind === 'sibling-gate'
          ? command.includes(needle || 'check-sibling-patterns')
          : command.includes(needle);
    if (matched) pids.push(match[1]);
  }
  return pids;
}

function startObserver(runtimeDir, record, classification) {
  if (!existsSync(observerPath())) return undefined;
  // Un comando come `git rev-list --all` non ha un token stabile che lo
  // distingua da una scansione di un'altra sessione: nessun PID e' meglio di
  // un PID/RSS attribuito al processo sbagliato.
  if (classification.kind === 'git-history' && !classification.matchNeedle) return undefined;
  try {
    const baselinePids = observerBaselinePids(classification);
    const child = spawn(process.execPath, [
      observerPath(),
      '--runtime', runtimeDir,
      '--id', record.id,
      '--command', record.command,
      '--category', classification.kind,
      '--needle', classification.matchNeedle ?? '',
      '--baseline-pids', baselinePids.join(','),
      '--session', record.sessionId,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    appendRegistry(runtimeDir, {
      version: GUARD_VERSION,
      pid: child.pid,
      invocationId: record.id,
      sessionId: record.sessionId,
      startedAt: now(),
    });
    return child.pid;
  } catch {
    return undefined;
  }
}

function stalePendingCleanup(runtimeDir) {
  const dir = path.join(runtimeDir, PENDING_DIR);
  let files = [];
  try { files = readdirSync(dir); } catch { return; }
  const cutoff = now() - 24 * 60 * 60 * 1000;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch { /* best effort */ }
  }
}

function observerIsOurs(pid) {
  const output = runQuiet('ps', ['-p', String(pid), '-o', 'command=']);
  return /agent-command-observer\.mjs/.test(output);
}

function stopObserver(runtimeDir, id) {
  const kept = [];
  for (const entry of readRegistry(runtimeDir)) {
    if (entry.invocationId === id && observerIsOurs(entry.pid)) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch { /* already exited */ }
      continue;
    }
    if (observerIsOurs(entry.pid)) kept.push(entry);
  }
  writeRegistry(runtimeDir, kept);
}

export function cleanupRuntime(runtimeDir, sessionId) {
  ensureRuntime(runtimeDir);
  const lease = readLease(runtimeDir);
  if (lease && (Number(lease.expiresAt) <= now() || (sessionId && lease.sessionId === sessionId))) removeLease(runtimeDir);

  let pendingFiles = [];
  try { pendingFiles = readdirSync(path.join(runtimeDir, PENDING_DIR)); } catch { /* absent */ }
  for (const file of pendingFiles) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(runtimeDir, PENDING_DIR, file);
    const pending = readJson(full);
    if (!pending) continue;
    if ((sessionId && pending.sessionId === sessionId) || Number(pending.startedAt) < now() - 24 * 60 * 60 * 1000) {
      try { unlinkSync(full); } catch { /* best effort */ }
    }
  }

  const kept = [];
  let stoppedObservers = 0;
  for (const entry of readRegistry(runtimeDir)) {
    const ownedBySession = Boolean(sessionId && entry.sessionId === sessionId);
    const alive = observerIsOurs(entry.pid);
    if (ownedBySession && alive) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch { /* already exited */ }
      stoppedObservers += 1;
    }
    if (!ownedBySession && alive) kept.push(entry);
  }
  writeRegistry(runtimeDir, kept);
  stalePendingCleanup(runtimeDir);
  return { releasedLease: Boolean(lease), stoppedObservers };
}

function leaseMessage(lease) {
  const category = lease?.category ?? 'job pesante';
  const ageSeconds = lease?.startedAt ? Math.max(0, Math.round((now() - lease.startedAt) / 1000)) : undefined;
  return `${category} gia' in esecuzione${ageSeconds === undefined ? '' : ` da ${ageSeconds}s`} (sessione ${lease?.sessionId ?? 'sconosciuta'})`;
}

function remediation(classification) {
  if (classification.kind === 'git-history') {
    return 'Limita il ref/range o usa --since/--max-count; per una ricerca ripetuta prepara un indice/cache mirato.';
  }
  if (classification.kind === 'typecheck') {
    return 'Usa `node "$WORKSPACE/bin/codex-typecheck.mjs" --changed` (tsconfig incremental) invece di `npm exec tsc -- --noEmit`.';
  }
  return 'Attendi la fine del job pesante corrente e riprova; i job leggeri possono continuare.';
}

export function guardPre(info, workspace = findWorkspace(info.cwd)) {
  const runtimeDir = runtimeDirectory(workspace);
  ensureRuntime(runtimeDir);
  stalePendingCleanup(runtimeDir);

  const classification = classifyCommand(info.command);
  const id = invocationId(info);
  const command = redactCommand(info.command);
  const baseRecord = {
    version: GUARD_VERSION,
    id,
    sessionId: info.sessionId,
    toolCallId: info.toolCallId || undefined,
    cwd: info.cwd,
    command,
    category: classification.kind,
    startedAt: now(),
    hookPid: process.pid,
  };

  if (!classification.heavy) {
    appendJson(runtimeDir, { type: 'command_start', ...baseRecord });
    writePending(runtimeDir, id, baseRecord);
    return { allowed: true, id, classification, runtimeDir };
  }

  const existing = readLease(runtimeDir);
  if (existing && Number(existing.expiresAt) > now()) {
    const reason = leaseMessage(existing);
    appendJson(runtimeDir, { type: 'command_blocked', ...baseRecord, reason });
    if (process.env.FRONTALIERE_RESOURCE_GUARD_VERBOSE === '1') process.stderr.write(`resource-guard: ${reason}\n`);
    return { allowed: false, id, classification, runtimeDir, reason };
  }
  if (existing) removeLease(runtimeDir);

  const snapshot = readHostSnapshot();
  const pressure = pressureDecision(snapshot);
  if (!isBypassEnabled() && (classification.unbounded || pressure.blocked)) {
    const reason = classification.unbounded
      ? `${classification.reason}: comando non delimitato`
      : pressure.reason;
    const fullReason = `${reason}. ${remediation(classification)}`;
    appendJson(runtimeDir, { type: 'command_blocked', ...baseRecord, snapshot, reason: fullReason });
    process.stderr.write(`\n🚫 resource-guard: comando pesante bloccato — ${fullReason}\n`);
    return { allowed: false, id, classification, runtimeDir, reason: fullReason };
  }

  const lease = {
    version: GUARD_VERSION,
    id,
    sessionId: info.sessionId,
    category: classification.kind,
    command,
    commandHash: sha256(info.command),
    startedAt: now(),
    expiresAt: now() + numberFromEnv('FRONTALIERE_RESOURCE_LEASE_MS', DEFAULT_LEASE_TTL_MS),
    hookPid: process.pid,
  };
  const acquired = acquireHeavyLease(runtimeDir, lease);
  if (!acquired.acquired) {
    const reason = leaseMessage(acquired.current);
    appendJson(runtimeDir, { type: 'command_blocked', ...baseRecord, snapshot, reason });
    process.stderr.write(`\n🚫 resource-guard: ${reason}. ${remediation(classification)}\n`);
    return { allowed: false, id, classification, runtimeDir, reason };
  }

  const record = { ...baseRecord, snapshot, leaseExpiresAt: lease.expiresAt };
  appendJson(runtimeDir, { type: 'command_start', ...record });
  writePending(runtimeDir, id, record);
  const observerPid = startObserver(runtimeDir, record, classification);
  if (observerPid) appendJson(runtimeDir, { type: 'observer_start', id, observerPid, category: classification.kind, at: now() });
  else appendJson(runtimeDir, { type: 'observer_unavailable', id, category: classification.kind, at: now() });
  return { allowed: true, id, classification, runtimeDir, observerPid };
}

export function guardPost(info, workspace = findWorkspace(info.cwd)) {
  const runtimeDir = runtimeDirectory(workspace);
  const id = invocationId(info);
  const pending = readPending(runtimeDir, id);
  const classification = classifyCommand(info.command);
  const endedAt = now();
  const snapshot = pending && classification.heavy ? readHostSnapshot() : undefined;
  if (pending) {
    appendJson(runtimeDir, {
      type: 'command_end',
      ...pending,
      endedAt,
      wallMs: Math.max(0, endedAt - Number(pending.startedAt || endedAt)),
      exitCode: extractExitCode(info.payload),
      snapshot,
    });
    removePending(runtimeDir, id);
  }
  if (pending) {
    const lease = readLease(runtimeDir);
    if (lease && (lease.id === id || (lease.sessionId === info.sessionId && lease.commandHash === sha256(info.command)))) {
      removeLease(runtimeDir);
    }
    stopObserver(runtimeDir, id);
  }
  return { runtimeDir, id, hadPending: Boolean(pending) };
}

function report(runtimeDir, json = false) {
  let entries = [];
  try {
    entries = readFileSync(path.join(runtimeDir, COMMANDS_NAME), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    entries = [];
  }
  const starts = new Map();
  const summaries = [];
  for (const entry of entries) {
    if (entry.type === 'command_start') starts.set(entry.id, entry);
    if (entry.type === 'observer_summary') summaries.push(entry);
  }
  const rows = summaries.map((summary) => ({
    id: summary.id,
    category: starts.get(summary.id)?.category ?? summary.category,
    pid: summary.pids?.join(',') ?? '',
    wallMs: summary.wallMs,
    maxCpuPct: summary.maxCpuPct,
    maxRssKb: summary.maxRssKb,
    sampleCount: summary.sampleCount,
  }));
  if (json) {
    process.stdout.write(`${JSON.stringify({ runtimeDir, commands: entries, observed: rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`runtime: ${runtimeDir}\n`);
    if (!rows.length) {
      process.stdout.write('nessuna misura PID disponibile\n');
      return;
    }
    for (const row of rows) {
      process.stdout.write(`${row.category} pid=${row.pid || '?'} wall=${row.wallMs ?? '?'}ms cpu_max=${row.maxCpuPct ?? '?'}% rss_max=${row.maxRssKb ?? '?'}KiB samples=${row.sampleCount ?? 0}\n`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0] ?? '--pre';
  const raw = mode === '--report' ? '' : readStdin();
  const info = parsePayload(raw);
  const workspace = findWorkspace(info.cwd);
  const runtimeDir = runtimeDirectory(workspace);
  try {
    if (mode === '--pre') {
      const result = guardPre(info, workspace);
      return result.allowed ? 0 : 2;
    }
    if (mode === '--post') {
      guardPost(info, workspace);
      return 0;
    }
    if (mode === '--cleanup') {
      cleanupRuntime(runtimeDir, info.sessionId === 'unknown-session' ? undefined : info.sessionId);
      return 0;
    }
    if (mode === '--report') {
      report(runtimeDir, argv.includes('--json'));
      return 0;
    }
    process.stderr.write(`uso: agent-resource-guard.mjs [--pre|--post|--cleanup|--report [--json]]\n`);
    return 0;
  } catch (error) {
    // Fail-open by design: the guard must not become a new source of outages.
    if (process.env.FRONTALIERE_RESOURCE_GUARD_VERBOSE === '1') {
      process.stderr.write(`resource-guard internal error: ${error?.stack ?? error}\n`);
    }
    return 0;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE;
if (isMain) process.exitCode = main();
