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
  realpathSync,
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
import { commandRows, matchesObservedProcess } from './agent-command-observer.mjs';
import { shellExecutableText } from './shell-command-scanner.mjs';

export const GUARD_VERSION = 1;
export const DEFAULT_LEASE_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_PRESSURE_FREE_PERCENT = 8;
export const DEFAULT_SWAP_USED_RATIO = 0.85;
// La quota di swap OCCUPATO non misura la pressione di adesso: su macOS le
// pagine gia' scritte nello swap ci restano finche' il processo che le
// possiede non le rilegge o non esce, e il file di swap cresce a gradini. Il
// 2026-10-03 lo swap era al 89% (3,66 GB su 4) con il 71% di memoria libera e
// il kernel a livello di pressione 1 (normale): la guardia rifiutava ogni test
// di ogni agente, e chi aspettava sotto l'82% poteva aspettare per ore. Lo
// swap pieno conta quindi solo se un segnale di pressione ATTUALE lo conferma:
// il kernel in avviso o critico, oppure la memoria libera sotto questa soglia.
// Senza segnale del kernel (altri sistemi, sysctl illeggibile) resta la regola
// di prima, a tutela.
export const DEFAULT_SWAP_CORROBORATION_FREE_PERCENT = 25;
// `kern.memorystatus_vm_pressure_level` su macOS: 1 normale, 2 avviso, 4 critico.
export const KERNEL_PRESSURE_WARN_LEVEL = 2;
// I comandi pesanti durano poco (2026-10-02, 24h: p90 40s, massimo 172s),
// ma il lease registrava solo il PID dell'hook, morto subito: un PostToolUse
// mancato teneva fermi tutti gli agenti fino al TTL di 2 ore. Ora il lease
// segue l'observer del comando e chi lo trova occupato aspetta in coda.
// L'attesa deve restare sotto il timeout dell'hook (360s nelle due config):
// un hook ucciso per timeout lascerebbe passare il comando senza lease.
export const DEFAULT_QUEUE_WAIT_MS = 5 * 60 * 1000;
export const DEFAULT_QUEUE_POLL_MS = 1000;
export const DEFAULT_UNOBSERVED_LEASE_MS = 15 * 60 * 1000;
export const LEASE_START_GRACE_MS = 30 * 1000;

const THIS_FILE = fileURLToPath(import.meta.url);
const BIN_DIR = path.dirname(THIS_FILE);
const WORKSPACE_FROM_BIN = path.resolve(BIN_DIR, '..');
const LEASE_NAME = 'heavy-lease.json';
const COMMANDS_NAME = 'commands.jsonl';
const PENDING_DIR = 'pending';
const OBSERVER_REGISTRY_NAME = 'observers.jsonl';
const OBSERVER_STATUS_DIR = 'observer-status';
const QUEUE_DIR = 'queue';
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
    // Claude Code lo chiama `tool_use_id`, Codex `tool_call_id`.
    const toolCallId = String(
      payload.tool_call_id ?? payload.toolCallId ?? payload.tool_use_id ?? payload.toolUseId
        ?? input.tool_call_id ?? input.toolCallId ?? input.tool_use_id ?? input.toolUseId ?? '',
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

// Restore only a Node script operand, not quoted prose or heredoc bodies.
function officialNodeScript(command) {
  const source = String(command ?? '');
  const executable = shellExecutableText(source);
  const pattern = /(?:^|[\s;&|])(?:[^\s;&|]*\/)?node\s+(?:(?:--(?:max-old-space-size|stack-size)(?:=\d+|\s+\d+)|--(?:enable-source-maps|no-warnings)|--)\s+)*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|]+))/g;
  for (const match of source.matchAll(pattern)) {
    const prefix = match[0].indexOf('node');
    if (executable.slice(match.index + prefix, match.index + prefix + 4) !== 'node') continue;
    const script = match[1] ?? match[2] ?? match[3];
    const runner = script.match(/(?:^|\/)(codex-typecheck|run-related-tests|check-sibling-patterns|sibling-check-gate)\.mjs$/)?.[1];
    if (runner) return { name: runner, start: match.index, end: match.index + match[0].length };
  }
  return undefined;
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

  // Official wrappers wait for their heavy child process; observe the wrapper
  // itself so discovery covers planning/startup as well as compiler/test time.
  const runner = officialNodeScript(command);
  if (runner) {
    const otherHeavyPhase = classifyCommand(String(command).slice(0, runner.start) + ' ' + String(command).slice(runner.end)).heavy;
    return {
      kind: runner.name === 'codex-typecheck' ? 'typecheck' : runner.name === 'run-related-tests' ? 'build-or-test' : 'sibling-gate',
      heavy: true,
      unbounded: otherHeavyPhase,
      text,
      reason: otherHeavyPhase ? 'più fasi pesanti nello stesso comando: eseguirle in chiamate separate' : runner.name === 'codex-typecheck' ? 'typecheck incrementale del progetto' : runner.name === 'run-related-tests' ? 'suite di test correlati' : 'sweep dei file gemelli',
      matchNeedle: `${runner.name}.mjs`,
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

  const vitestRun = /(?:^|[\s/])vitest(?:\.mjs)?\s+run\b/.test(text);
  const viteBuild = /(?:^|[\s/])vite(?:\.js)?\s+build\b/.test(text);
  const playwrightTest = /\bplaywright\s+test\b/.test(text);
  if (vitestRun || viteBuild || playwrightTest || /\bnpm\s+run\s+(?:build|test)\b/.test(text)) {
    const matchNeedle = vitestRun ? 'vitest' : viteBuild ? 'vite' : playwrightTest ? 'playwright' : 'node';
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
  const pressureLevelOutput = process.platform === 'darwin'
    ? runQuiet('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim()
    : '';
  const pressureLevel = /^\d+$/.test(pressureLevelOutput) ? Number(pressureLevelOutput) : undefined;

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
    pressureLevel,
    processCount,
  };
}

export function pressureDecision(snapshot, options = {}) {
  const freeThreshold = numberFromEnv('FRONTALIERE_RESOURCE_FREE_PERCENT', options.freePercent ?? DEFAULT_PRESSURE_FREE_PERCENT);
  const swapRatioThreshold = numberFromEnv('FRONTALIERE_RESOURCE_SWAP_RATIO', options.swapRatio ?? DEFAULT_SWAP_USED_RATIO);
  const corroborationFree = numberFromEnv(
    'FRONTALIERE_RESOURCE_SWAP_CORROBORATION_FREE_PERCENT',
    options.swapCorroborationFreePercent ?? DEFAULT_SWAP_CORROBORATION_FREE_PERCENT,
  );
  if (Number.isFinite(snapshot?.freePercent) && snapshot.freePercent <= freeThreshold) {
    return {
      blocked: true,
      reason: `memoria libera ${snapshot.freePercent.toFixed(1)}% (soglia ${freeThreshold}%)`,
    };
  }
  const kernelLevel = Number.isFinite(snapshot?.pressureLevel) ? snapshot.pressureLevel : undefined;
  if (kernelLevel !== undefined && kernelLevel >= KERNEL_PRESSURE_WARN_LEVEL) {
    return {
      blocked: true,
      reason: `pressione memoria del kernel a livello ${kernelLevel} (avviso da ${KERNEL_PRESSURE_WARN_LEVEL})`,
    };
  }
  if (
    Number.isFinite(snapshot?.swapUsedBytes) &&
    Number.isFinite(snapshot?.swapTotalBytes) &&
    snapshot.swapTotalBytes > 0 &&
    snapshot.swapUsedBytes / snapshot.swapTotalBytes >= swapRatioThreshold
  ) {
    const ratio = (snapshot.swapUsedBytes / snapshot.swapTotalBytes) * 100;
    // Con il kernel a livello normale lo swap pieno e' memoria gia' scaricata,
    // non pressione: conta solo se anche la memoria libera e' scarsa.
    const freeIsLow = Number.isFinite(snapshot?.freePercent) && snapshot.freePercent < corroborationFree;
    if (kernelLevel === undefined || freeIsLow) {
      return { blocked: true, reason: `swap utilizzato ${ratio.toFixed(1)}% (soglia ${(swapRatioThreshold * 100).toFixed(0)}%)` };
    }
  }
  return { blocked: false };
}

/**
 * L'id deve essere lo stesso nel PreToolUse e nel PostToolUse della stessa
 * chiamata. La directory corrente non lo e': un comando che fa `cd` la cambia
 * fra i due hook. Quando l'harness passa l'id della chiamata basta quello;
 * senza, command e cwd restano l'unica chiave e `guardPost` ritrova il pending
 * anche da un'altra directory (vedi `pendingOfMovedCommand`).
 */
export function invocationId(info) {
  if (info.toolCallId) {
    return sha256(JSON.stringify({ sessionId: info.sessionId, toolCallId: info.toolCallId })).slice(0, 32);
  }
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function observerStatusPath(runtimeDir, id) {
  return path.join(runtimeDir, OBSERVER_STATUS_DIR, `${id}.json`);
}

function defaultObserverAlive(pid) {
  return pidAlive(pid) && observerIsOurs(pid);
}

function unobservedStartupEnded(lease, status, at, options) {
  if (status?.version !== 2 || status.seen !== false || status.startupComplete !== true || status.ownerAbsentAtEnd !== true
    || status.id !== lease.id || status.hookPid !== lease.hookPid
    || status.observerPid !== lease.observerPid || status.leaseStartedAt !== lease.startedAt
    || !lease.commandHash || status.commandHash !== lease.commandHash
    || !Number.isFinite(status.endedAt) || status.endedAt < lease.startedAt
    || at - status.endedAt < LEASE_START_GRACE_MS || !Array.isArray(status.pids)) return false;
  const alive = options.processAlive ?? pidAlive;
  // Reused PIDs also remain blocking: absence, not a different command name,
  // is required before an unseen invocation can be reclaimed early.
  if (!(lease.hookPid > 0) || alive(lease.hookPid) || alive(lease.observerPid)) return false;
  const rows = (options.processRows ?? commandRows)();
  if (!Array.isArray(rows)) return false;
  const classification = classifyCommand(lease.command);
  const knownPids = new Set(status.pids || []);
  const ageSeconds = (at - lease.startedAt) / 1000;
  return !rows.some((row) => {
    if (knownPids.has(row.pid)) return true;
    if (row.pid === process.pid || row.ppid === process.pid) return false;
    if (matchesObservedProcess(row, classification.kind, classification.matchNeedle || '', lease.command, new Set())) return true;
    // An unseen wrapper might have exited between samples, leaving an adopted
    // child with another executable name. Any younger/unknown process keeps
    // the lease, except the hook dispatchers which are only waiting in FIFO.
    if (/(?:^|\s)\S*node\s+\S*\/bin\/hook-dispatch\.mjs\s+(?:pre|post)-bash\s*$/.test(row.command)) return false;
    const elapsed = String(row.elapsed || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!elapsed) return true;
    const seconds = Number(elapsed[1] || 0) * 86400 + Number(elapsed[2] || 0) * 3600 + Number(elapsed[3]) * 60 + Number(elapsed[4]);
    return seconds <= ageSeconds + 2;
  });
}

/**
 * Perche' un lease non vale piu', o undefined se e' ancora valido. Un lease e'
 * libero quando scade, quando il suo observer e' morto dopo aver visto il
 * comando (il comando e' finito anche se il PostToolUse non e' arrivato), o
 * quando nessuno osserva il comando da piu' del TTL ridotto per i lease non
 * osservati. Nei primi secondi l'observer puo' non essere ancora registrato.
 */
export function leaseStaleReason(lease, runtimeDir, options = {}) {
  if (!lease) return 'assente';
  const at = options.now ?? now();
  if (Number(lease.expiresAt) <= at) return 'scaduto';
  const age = at - Number(lease.startedAt || at);
  if (age < LEASE_START_GRACE_MS) return undefined;
  const observerAlive = options.observerAlive ?? defaultObserverAlive;
  const observerPid = Number(lease.observerPid);
  if (observerPid > 0) {
    if (observerAlive(observerPid)) return undefined;
    const status = readJson(observerStatusPath(runtimeDir, lease.id));
    if (status?.seen) return 'comando terminato';
    if (unobservedStartupEnded(lease, status, at, options)) return 'avvio terminato senza processi attivi';
  }
  const unobservedMs = numberFromEnv('FRONTALIERE_RESOURCE_UNOBSERVED_LEASE_MS', DEFAULT_UNOBSERVED_LEASE_MS);
  if (age >= unobservedMs) return `nessun processo osservato da ${Math.round(age / 1000)}s`;
  return undefined;
}

export function acquireHeavyLease(runtimeDir, lease, options = {}) {
  ensureRuntime(runtimeDir);
  const file = leasePath(runtimeDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = readLease(runtimeDir);
    if (current && !leaseStaleReason(current, runtimeDir, options)) return { acquired: false, current };
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function queuePath(runtimeDir) {
  return path.join(runtimeDir, QUEUE_DIR);
}

function enqueue(runtimeDir, info) {
  const dir = queuePath(runtimeDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const enqueuedAt = now();
  // Il nome ordina la coda: istante di arrivo, poi pid e id per gli ex aequo.
  const name = `${String(enqueuedAt).padStart(15, '0')}-${process.pid}-${info.id}.json`;
  writeJsonAtomic(path.join(dir, name), { ...info, pid: process.pid, enqueuedAt });
  return name;
}

function dequeue(runtimeDir, name) {
  try { unlinkSync(path.join(queuePath(runtimeDir), name)); } catch { /* already gone */ }
}

/**
 * Il biglietto vivo piu' vecchio. I biglietti di hook morti (uccisi dal
 * timeout o dalla fine della sessione) vengono tolti strada facendo.
 */
export function queueHead(runtimeDir, options = {}) {
  const alive = options.pidAlive ?? pidAlive;
  let names = [];
  try { names = readdirSync(queuePath(runtimeDir)).filter((name) => name.endsWith('.json')).sort(); } catch { return undefined; }
  for (const name of names) {
    const ticket = readJson(path.join(queuePath(runtimeDir), name));
    if (ticket && alive(Number(ticket.pid))) return name;
    dequeue(runtimeDir, name);
  }
  return undefined;
}

/**
 * Attende il lease in coda FIFO fino a maxWaitMs. Restituisce il lease
 * acquisito oppure quello che lo ha impedito fino alla scadenza dell'attesa.
 */
export function waitForHeavyLease(runtimeDir, info, makeLease, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? numberFromEnv('FRONTALIERE_RESOURCE_QUEUE_MS', DEFAULT_QUEUE_WAIT_MS);
  const pollMs = options.pollMs ?? numberFromEnv('FRONTALIERE_RESOURCE_QUEUE_POLL_MS', DEFAULT_QUEUE_POLL_MS);
  const startedAt = now();
  const ticket = enqueue(runtimeDir, info);
  try {
    for (;;) {
      if (queueHead(runtimeDir, options) === ticket) {
        const acquired = acquireHeavyLease(runtimeDir, makeLease(), options);
        if (acquired.acquired) return { acquired: true, lease: acquired.lease, waitedMs: now() - startedAt };
      }
      const waitedMs = now() - startedAt;
      if (waitedMs >= maxWaitMs) return { acquired: false, current: readLease(runtimeDir), waitedMs };
      sleepSync(Math.min(pollMs, maxWaitMs - waitedMs));
    }
  } finally {
    dequeue(runtimeDir, ticket);
  }
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

/**
 * Il pending di un comando che ha cambiato directory: stessa sessione, stesso
 * comando, nessun id di chiamata, partito da un'altra cwd. Senza questo il
 * PostToolUse non trova niente da chiudere, e il lease di un comando pesante
 * resta appeso fino al TTL dei lease non osservati (15 minuti di coda ferma
 * per tutte le sessioni). Il piu' recente vince: e' quello che sta finendo.
 */
function pendingOfMovedCommand(runtimeDir, info) {
  if (info.toolCallId) return undefined;
  const command = redactCommand(info.command);
  let names = [];
  try { names = readdirSync(path.join(runtimeDir, PENDING_DIR)).filter((name) => name.endsWith('.json')); } catch { return undefined; }
  let found;
  for (const name of names) {
    const pending = readJson(path.join(runtimeDir, PENDING_DIR, name));
    if (!pending || pending.toolCallId || pending.sessionId !== info.sessionId) continue;
    if (pending.command !== command || pending.cwd === info.cwd) continue;
    if (!found || Number(pending.startedAt || 0) > Number(found.startedAt || 0)) found = pending;
  }
  return found;
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
    const matched = matchesObservedProcess({ pid: Number(match[1]), command }, classification.kind, needle, classification.text, new Set());
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
      '--status', observerStatusPath(runtimeDir, record.id),
      '--hook-pid', String(record.hookPid),
      '--lease-started-at', String(record.leaseStartedAt),
      '--command-hash', record.commandHash,
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
  const cutoff = now() - 24 * 60 * 60 * 1000;
  for (const name of [PENDING_DIR, OBSERVER_STATUS_DIR]) {
    const dir = path.join(runtimeDir, name);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch { /* best effort */ }
    }
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
  if (lease && (leaseStaleReason(lease, runtimeDir) || (sessionId && lease.sessionId === sessionId))) removeLease(runtimeDir);

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

// ── Sparse checkout del sito ───────────────────────────────────────────────
// Il 2026-11-15 il disco si è riempito per quattro worktree del sito da
// 5,55 GiB creati tra le 00:20 e le 04:27Z. Nascevano sparse
// (`fast-worktree.sh`), poi una sessione eseguiva `git sparse-checkout
// disable`: `config.worktree` dichiarava `core.sparseCheckout=false` e `data/`
// e `public/` comparivano 36 s dopo la creazione. Sul clone del sito (o su un
// suo worktree) questi comandi vengono rifiutati. Il corpus e il repo Reddit
// sono piccoli e restano liberi.
const FALSEY_GIT_BOOL = new Set(['false', 'no', 'off', '0', '']);
const SPARSE_KEY = 'core.sparsecheckout';
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--config-env', '--attr-source']);
const CONFIG_OPTIONS_WITH_VALUE = new Set(['-f', '--file', '--blob', '--type', '-t', '--default', '--comment']);
const WRAPPER_WORDS = new Set(['command', 'exec', 'time', 'nohup', 'nice', 'builtin']);

/** Quoted text is masked by shellExecutableText, so separators are found on it and the raw text is sliced. */
function shellSegments(command) {
  const raw = String(command ?? '');
  const executable = shellExecutableText(raw);
  const segments = [];
  let start = 0;
  const flush = (end) => {
    const text = raw.slice(start, end).trim();
    if (text) segments.push(text);
  };
  for (let index = 0; index < executable.length; index += 1) {
    const character = executable[index];
    // `${VAR}` is one word, not a block.
    if (character === '$' && executable[index + 1] === '{') {
      const close = executable.indexOf('}', index);
      if (close > 0) {
        index = close;
        continue;
      }
    }
    if (character === ';' || character === '\n' || character === '|' || character === '&' || character === '(' || character === ')' || character === '{' || character === '}') {
      flush(index);
      start = index + 1;
    }
  }
  flush(raw.length);
  return segments;
}

function shellWords(segment) {
  const words = [];
  let current = '';
  let active = false;
  let quote;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === '\\' && index + 1 < segment.length && '"\\$`'.includes(segment[index + 1])) current += segment[++index];
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
    } else if (character === '\\' && index + 1 < segment.length) {
      current += segment[++index];
      active = true;
    } else if (/\s/.test(character)) {
      if (active) words.push(current);
      current = '';
      active = false;
    } else {
      current += character;
      active = true;
    }
  }
  if (active) words.push(current);
  return words;
}

/** Expand `~`, `$HOME`, `$WORKSPACE`...; `undefined` when a variable cannot be resolved (the target is then unknown). */
function expandPathWord(word, workspace) {
  let text = String(word);
  if (text === '~' || text.startsWith('~/')) text = `${os.homedir()}${text.slice(1)}`;
  let unresolved = false;
  text = text.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, braced, plain) => {
    const name = braced ?? plain;
    const value = name === 'WORKSPACE' ? (process.env.WORKSPACE || workspace) : process.env[name];
    if (value === undefined || value === '') unresolved = true;
    return value ?? '';
  });
  return unresolved || /[`$]/.test(text) ? undefined : text;
}

function canonicalPath(target) {
  const missing = [];
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  try {
    current = realpathSync(current);
  } catch {
    // keep the lexical path
  }
  return path.join(current, ...missing);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The site clone, or a linked worktree of it wherever it lives (same git common dir). */
function isSiteRepoPath(target, workspace) {
  const site = canonicalPath(process.env.FRONTALIERE_SITE_REPO || path.join(workspace, 'frontaliere-si-o-no'));
  const dir = canonicalPath(target);
  if (isInside(dir, site)) return true;
  let probe = dir;
  while (!isDirectory(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    const common = execFileSync('git', ['-C', probe, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim();
    return Boolean(common) && canonicalPath(path.resolve(probe, common)) === canonicalPath(path.join(site, '.git'));
  } catch {
    return false;
  }
}

function sparseOffReason(form) {
  return `${form} nel clone del sito (o in un suo worktree) materializza circa 5,5 GiB di public/ e data/: `
    + 'quattro worktree sparse sono diventati completi così il 2026-11-15 e hanno riempito il disco. '
    + 'Alternative: `git sparse-checkout add <path>` per il solo path che serve, `git show origin/main:<path>` '
    + 'per leggere un file, `git ls-tree` per elencare.';
}

function sparseWideReason(form) {
  return `${form} nel clone del sito (o in un suo worktree) materializza per intero data/ (circa 3,7 GiB), `
    + 'public/ o la radice: il 2026-11-15 un worktree è arrivato a 4,7 GiB con `git sparse-checkout add data`. '
    + 'Aggiungi solo il sotto-path che serve (es. `git sparse-checkout add data/faq-hub`), '
    + 'oppure leggi con `git show origin/main:<path>` ed elenca con `git ls-tree`.';
}

// Le cartelle del sito che `fast-worktree.sh` esclude perché pesano GiB.
// Un pattern sparse che le riprende per intero (o che riprende la radice)
// costa sul disco quanto `disable`; un loro sotto-path resta libero.
const HEAVY_SPARSE_ROOTS = new Set(['data', 'public']);

function normalizedSparsePattern(pattern) {
  return String(pattern).trim().replace(/^(?:\.\/|\/)+/, '').replace(/(?:\/\*\*|\/\*|\/)+$/, '');
}

const isRootSparsePattern = (normalized) => normalized === '' || normalized === '.' || normalized === '*' || normalized === '**';

/**
 * Il primo pattern di `sparse-checkout add|set` (o di `fast-worktree.sh --add`)
 * che materializza per intero data/, public/ o la radice, altrimenti
 * `undefined`. Con `set` una radice seguita dalle esclusioni di data/ e
 * public/ è il profilo di `fast-worktree.sh` e resta ammessa. `--stdin`: i
 * pattern non sono nel comando, bersaglio ignoto (fail-open come il resto).
 */
function heavySparseOperand(mode, operands) {
  if (operands.includes('--stdin')) return undefined;
  const patterns = operands.filter((word) => !word.startsWith('-'));
  const whole = patterns.find((pattern) => !pattern.startsWith('!') && HEAVY_SPARSE_ROOTS.has(normalizedSparsePattern(pattern)));
  if (whole) return whole;
  const rootIndex = patterns.findIndex((pattern) => !pattern.startsWith('!') && isRootSparsePattern(normalizedSparsePattern(pattern)));
  if (rootIndex < 0) return undefined;
  if (mode === 'set') {
    const excluded = new Set(patterns.slice(rootIndex + 1)
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => normalizedSparsePattern(pattern.slice(1))));
    if ([...HEAVY_SPARSE_ROOTS].every((root) => excluded.has(root))) return undefined;
  }
  return patterns[rootIndex];
}

/**
 * Detects the commands that turn a sparse checkout of the site into a full one:
 * `git sparse-checkout disable`, `git config [--worktree] core.sparseCheckout
 * false` (or `--unset`) and `git -c core.sparseCheckout=false <command>`, plus
 * the ones that re-include a whole heavy directory or the root:
 * `git sparse-checkout add|set data|public|/*` and `fast-worktree.sh --add data`.
 * Follows `cd` and `git -C <dir>` (relative paths included) to find the target
 * repo; an unresolvable target is not blocked (the guard stays fail-open).
 * Returns `{ form, reason }` or `undefined`.
 */
export function sparseCheckoutDisableDecision(command, cwd, workspace = findWorkspace(cwd)) {
  let current = cwd ? path.resolve(String(cwd)) : undefined;
  for (const segment of shellSegments(command)) {
    let words = shellWords(segment);
    // `env`, `command`, VAR=value in front of git.
    let at = 0;
    while (at < words.length) {
      const word = words[at];
      if (ENV_ASSIGNMENT.test(word) || WRAPPER_WORDS.has(word)) at += 1;
      else if (word === 'env') {
        at += 1;
        while (at < words.length && (words[at].startsWith('-') || ENV_ASSIGNMENT.test(words[at]))) at += words[at] === '-u' ? 2 : 1;
      } else break;
    }
    words = words.slice(at);
    if (!words.length) continue;

    if (words[0] === 'cd' || words[0] === 'pushd' || words[0] === 'popd') {
      const operand = words.slice(1).find((word) => !/^-[LPe@]*$/.test(word) || word === '-');
      if (words[0] === 'popd' || operand === '-') current = undefined;
      else if (operand === undefined) current = os.homedir();
      else {
        const expanded = expandPathWord(operand, workspace);
        current = expanded === undefined || current === undefined && !path.isAbsolute(expanded)
          ? undefined
          : path.resolve(current ?? '/', expanded);
      }
      continue;
    }

    // `fast-worktree.sh <nome> --add data`: lo stesso costo, prima di git.
    const helperAt = path.basename(words[0]) === 'fast-worktree.sh' ? 0
      : (['bash', 'sh', 'zsh'].includes(words[0]) && path.basename(words[1] ?? '') === 'fast-worktree.sh' ? 1 : -1);
    if (helperAt >= 0) {
      const added = [];
      for (let position = helperAt + 1; position < words.length; position += 1) {
        if (words[position] === '--add' && words[position + 1] !== undefined) added.push(words[++position]);
      }
      const heavy = heavySparseOperand('add', added);
      const script = expandPathWord(words[helperAt], workspace);
      const scriptPath = script === undefined || (current === undefined && !path.isAbsolute(script))
        ? undefined
        : path.resolve(current ?? '/', script);
      if (heavy && scriptPath && isSiteRepoPath(path.dirname(scriptPath), workspace)) {
        const form = `\`fast-worktree.sh --add ${heavy}\``;
        return { form, reason: sparseWideReason(form) };
      }
      continue;
    }
    if (path.basename(words[0]) !== 'git') continue;

    // Global git options: -C <dir>, -c <k=v>, --git-dir, --work-tree...
    let directory = current;
    let sparseOffByConfig = false;
    let targets = [];
    let index = 1;
    while (index < words.length && words[index].startsWith('-')) {
      const option = words[index];
      const [name, inlineValue] = option.startsWith('--') && option.includes('=') ? [option.slice(0, option.indexOf('=')), option.slice(option.indexOf('=') + 1)] : [option, undefined];
      const takesValue = GIT_OPTIONS_WITH_VALUE.has(name);
      const value = inlineValue ?? (takesValue ? words[index + 1] : undefined);
      index += takesValue && inlineValue === undefined ? 2 : 1;
      if (name === '-C') {
        const expanded = value === undefined ? undefined : expandPathWord(value, workspace);
        directory = expanded === undefined || directory === undefined && !path.isAbsolute(expanded) ? undefined : path.resolve(directory ?? '/', expanded);
      } else if (name === '-c' && value !== undefined) {
        const separator = value.indexOf('=');
        const key = (separator < 0 ? value : value.slice(0, separator)).toLowerCase();
        if (key === SPARSE_KEY && separator >= 0 && FALSEY_GIT_BOOL.has(value.slice(separator + 1).trim().toLowerCase())) sparseOffByConfig = true;
      } else if ((name === '--git-dir' || name === '--work-tree') && value !== undefined) {
        const expanded = expandPathWord(value, workspace);
        if (expanded !== undefined) targets.push(path.resolve(directory ?? '/', expanded));
      }
    }
    const subcommand = words[index];
    const args = words.slice(index + 1);
    if (directory !== undefined) targets = [directory, ...targets];

    let form;
    let wide = false;
    let global = false;
    if (sparseOffByConfig) form = '`git -c core.sparseCheckout=false`';
    if (subcommand === 'sparse-checkout' && args[0] === 'disable') form = '`git sparse-checkout disable`';
    if (subcommand === 'sparse-checkout' && (args[0] === 'add' || args[0] === 'set')) {
      const heavy = heavySparseOperand(args[0], args.slice(1));
      if (heavy) {
        form = `\`git sparse-checkout ${args[0]} ${heavy}\``;
        wide = true;
      }
    }
    if (subcommand === 'config') {
      const positionals = [];
      let unset = false;
      for (let position = 0; position < args.length; position += 1) {
        const argument = args[position];
        if (argument === '--global' || argument === '--system') global = true;
        else if (argument === '--unset' || argument === '--unset-all') unset = true;
        else if (CONFIG_OPTIONS_WITH_VALUE.has(argument)) position += 1;
        else if (!argument.startsWith('-') || argument === '-') positionals.push(argument);
      }
      if (positionals[0] === 'set' && positionals.length >= 3) positionals.shift();
      else if (positionals[0] === 'unset' && positionals.length >= 2) {
        positionals.shift();
        unset = true;
      }
      if (positionals[0]?.toLowerCase() === SPARSE_KEY && (unset || (positionals.length >= 2 && FALSEY_GIT_BOOL.has(positionals[1].trim().toLowerCase())))) {
        form = unset ? '`git config --unset core.sparseCheckout`' : '`git config core.sparseCheckout false`';
      }
    }
    if (!form) continue;
    // --global/--system reach the site clone from any directory.
    if (global || targets.some((target) => isSiteRepoPath(target, workspace))) {
      return { form, reason: wide ? sparseWideReason(form) : sparseOffReason(form) };
    }
  }
  return undefined;
}

export function guardPre(info, workspace = findWorkspace(info.cwd), options = {}) {
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

  const sparseOff = isBypassEnabled() ? undefined : sparseCheckoutDisableDecision(info.command, info.cwd, workspace);
  if (sparseOff) {
    appendJson(runtimeDir, { type: 'command_blocked', ...baseRecord, reason: sparseOff.reason });
    process.stderr.write(`\n🚫 resource-guard: comando bloccato — ${sparseOff.reason}\n`);
    return { allowed: false, id, classification, runtimeDir, reason: sparseOff.reason };
  }

  if (!classification.heavy) {
    appendJson(runtimeDir, { type: 'command_start', ...baseRecord });
    writePending(runtimeDir, id, baseRecord);
    return { allowed: true, id, classification, runtimeDir };
  }

  if (!isBypassEnabled() && classification.unbounded) {
    const fullReason = `${classification.reason}: comando non delimitato. ${remediation(classification)}`;
    appendJson(runtimeDir, { type: 'command_blocked', ...baseRecord, reason: fullReason });
    process.stderr.write(`\n🚫 resource-guard: comando pesante bloccato — ${fullReason}\n`);
    return { allowed: false, id, classification, runtimeDir, reason: fullReason };
  }

  const makeLease = () => ({
    version: GUARD_VERSION,
    id,
    sessionId: info.sessionId,
    category: classification.kind,
    command,
    commandHash: sha256(info.command),
    startedAt: now(),
    expiresAt: now() + numberFromEnv('FRONTALIERE_RESOURCE_LEASE_MS', DEFAULT_LEASE_TTL_MS),
    hookPid: process.pid,
  });
  const waited = waitForHeavyLease(runtimeDir, { id, sessionId: info.sessionId, category: classification.kind }, makeLease, options);
  if (!waited.acquired) {
    const reason = `${leaseMessage(waited.current)}; in coda da ${Math.round(waited.waitedMs / 1000)}s senza turno`;
    appendJson(runtimeDir, { type: 'command_blocked', ...baseRecord, reason, waitedMs: waited.waitedMs });
    process.stderr.write(`\n🚫 resource-guard: ${reason}. ${remediation(classification)}\n`);
    return { allowed: false, id, classification, runtimeDir, reason };
  }
  const { lease } = waited;
  if (waited.waitedMs > 0) appendJson(runtimeDir, { type: 'command_dequeued', id, category: classification.kind, waitedMs: waited.waitedMs, at: now() });

  const snapshot = readHostSnapshot();
  const pressure = pressureDecision(snapshot);
  if (!isBypassEnabled() && pressure.blocked) {
    removeOwnLease(runtimeDir, id);
    const fullReason = `${pressure.reason}. ${remediation(classification)}`;
    appendJson(runtimeDir, { type: 'command_blocked', ...baseRecord, snapshot, reason: fullReason });
    process.stderr.write(`\n🚫 resource-guard: comando pesante bloccato — ${fullReason}\n`);
    return { allowed: false, id, classification, runtimeDir, reason: fullReason };
  }

  const record = { ...baseRecord, snapshot, leaseStartedAt: lease.startedAt, commandHash: lease.commandHash, leaseExpiresAt: lease.expiresAt, waitedMs: waited.waitedMs };
  appendJson(runtimeDir, { type: 'command_start', ...record });
  writePending(runtimeDir, id, record);
  const observerPid = startObserver(runtimeDir, record, classification);
  if (observerPid) {
    appendJson(runtimeDir, { type: 'observer_start', id, observerPid, category: classification.kind, at: now() });
    // Da qui la vita del lease segue quella dell'observer, non solo il TTL.
    if (readLease(runtimeDir)?.id === id) writeJsonAtomic(leasePath(runtimeDir), { ...lease, observerPid });
  } else {
    appendJson(runtimeDir, { type: 'observer_unavailable', id, category: classification.kind, at: now() });
  }
  return { allowed: true, id, classification, runtimeDir, observerPid, waitedMs: waited.waitedMs };
}

function removeOwnLease(runtimeDir, id) {
  if (readLease(runtimeDir)?.id === id) removeLease(runtimeDir);
}

export function guardPost(info, workspace = findWorkspace(info.cwd)) {
  const runtimeDir = runtimeDirectory(workspace);
  const computedId = invocationId(info);
  const pending = readPending(runtimeDir, computedId) ?? pendingOfMovedCommand(runtimeDir, info);
  const id = pending?.id ?? computedId;
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
    try { unlinkSync(observerStatusPath(runtimeDir, id)); } catch { /* no status */ }
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

async function runLlm(args) {
  const reserve = args[0] === '--reserve';
  const [separator, ...command] = reserve ? args.slice(1) : args;
  if (separator !== '--' || !command[0]) {
    process.stderr.write('uso: agent-resource-guard.mjs --run-llm [--reserve] -- PROGRAM ARG...\n');
    return 2;
  }

  try {
    let runtimeDir;
    if (process.env.FRONTALIERE_AGENT_RUNTIME_DIR?.trim()) {
      runtimeDir = runtimeDirectory();
    } else {
      const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: WORKSPACE_FROM_BIN,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trimEnd();
      runtimeDir = runtimeDirectory(path.dirname(realpathSync(commonDir)));
    }
    const helper = spawn('python3', [
      path.join(BIN_DIR, 'agent-session-lease.py'), runtimeDir, reserve ? 'reserve' : 'ordinary', ...command,
    ], { stdio: 'inherit', detached: true });
    const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [
      signal, () => helper.kill(signal),
    ]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    try {
      return await new Promise((resolve, reject) => {
        helper.once('error', reject);
        helper.once('exit', (code, signal) => resolve(code ?? 128 + os.constants.signals[signal]));
      });
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  } catch {
    process.stderr.write('resource-guard: errore di avvio del runner LLM\n');
    return 1;
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
    process.stderr.write('uso: agent-resource-guard.mjs [--pre|--post|--cleanup|--report [--json]|--run-llm [--reserve] -- PROGRAM ARG...]\n');
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
if (isMain) {
  if (process.argv[2] === '--run-llm') {
    runLlm(process.argv.slice(3)).then((code) => { process.exitCode = code; });
  } else {
    process.exitCode = main();
  }
}
