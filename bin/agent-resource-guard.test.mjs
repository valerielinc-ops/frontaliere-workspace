import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEASE_START_GRACE_MS,
  acquireHeavyLease,
  classifyCommand,
  cleanupRuntime,
  guardPost,
  guardPre,
  invocationId,
  leaseStaleReason,
  parsePayload,
  pressureDecision,
  queueHead,
  redactCommand,
  runtimeDirectory,
  waitForHeavyLease,
} from './agent-resource-guard.mjs';

const DEAD_PID = 2 ** 22 + 12345;

function withRuntime(fn) {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  try {
    return fn(runtime);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

function oldLease(extra = {}) {
  const startedAt = Date.now() - LEASE_START_GRACE_MS - 1000;
  return { id: 'held', sessionId: 'other', category: 'build-or-test', startedAt, expiresAt: Date.now() + 3_600_000, ...extra };
}

function writeObserverStatus(runtime, id, seen) {
  mkdirSync(path.join(runtime, 'observer-status'), { recursive: true });
  writeFileSync(path.join(runtime, 'observer-status', `${id}.json`), JSON.stringify({ id, seen, endedAt: Date.now() }));
}

function writeTicket(runtime, enqueuedAt, pid, id) {
  mkdirSync(path.join(runtime, 'queue'), { recursive: true });
  const name = `${String(enqueuedAt).padStart(15, '0')}-${pid}-${id}.json`;
  writeFileSync(path.join(runtime, 'queue', name), JSON.stringify({ id, pid, enqueuedAt }));
  return name;
}

test('un lease e\' libero solo quando il comando e\' davvero finito o il TTL scade', () => withRuntime((runtime) => {
  const alive = { observerAlive: () => true };
  const dead = { observerAlive: () => false };
  assert.equal(leaseStaleReason({ ...oldLease({ observerPid: 42 }), startedAt: Date.now() }, runtime, dead), undefined, 'nei primi secondi l\'observer puo\' mancare');
  assert.equal(leaseStaleReason(oldLease({ expiresAt: Date.now() - 1 }), runtime, alive), 'scaduto');
  assert.equal(leaseStaleReason(oldLease({ observerPid: 42 }), runtime, alive), undefined);
  assert.equal(leaseStaleReason(oldLease({ observerPid: 42 }), runtime, dead), undefined, 'observer morto senza prova di fine');
  writeObserverStatus(runtime, 'held', true);
  assert.equal(leaseStaleReason(oldLease({ observerPid: 42 }), runtime, dead), 'comando terminato');
  const unobserved = oldLease({ id: 'quiet', startedAt: Date.now() - 16 * 60 * 1000 });
  assert.match(leaseStaleReason(unobserved, runtime, dead), /nessun processo osservato/);
}));

test('il lease di un comando finito senza PostToolUse non blocca il successivo', () => withRuntime((runtime) => {
  assert.equal(acquireHeavyLease(runtime, oldLease({ observerPid: 42 })).acquired, true);
  writeObserverStatus(runtime, 'held', true);
  const next = acquireHeavyLease(runtime, { id: 'next', startedAt: Date.now(), expiresAt: Date.now() + 60_000 }, { observerAlive: () => false });
  assert.equal(next.acquired, true);
}));

test('la coda e\' FIFO e scarta i biglietti degli hook morti', () => withRuntime((runtime) => {
  const now = Date.now();
  writeTicket(runtime, now - 3000, DEAD_PID, 'morto');
  const alive = writeTicket(runtime, now - 2000, process.pid, 'vivo');
  writeTicket(runtime, now - 1000, process.pid, 'dopo');
  assert.equal(queueHead(runtime), alive);
  assert.equal(readdirSync(path.join(runtime, 'queue')).length, 2, 'il biglietto morto e\' stato tolto');
}));

test('in coda si aspetta il proprio turno e si prende il lease appena libero', () => withRuntime((runtime) => {
  const lease = () => ({ id: 'mine', startedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const first = waitForHeavyLease(runtime, { id: 'mine' }, lease, { maxWaitMs: 1000, pollMs: 10 });
  assert.equal(first.acquired, true);
  assert.equal(readdirSync(path.join(runtime, 'queue')).length, 0, 'il biglietto viene tolto');

  // Un biglietto piu' vecchio e vivo ha la precedenza anche a lease libero.
  rmSync(path.join(runtime, 'heavy-lease.json'));
  const ahead = writeTicket(runtime, Date.now() - 5000, process.pid, 'prima');
  const blocked = waitForHeavyLease(runtime, { id: 'mine' }, lease, { maxWaitMs: 60, pollMs: 10 });
  assert.equal(blocked.acquired, false);
  assert.ok(blocked.waitedMs >= 60);
  rmSync(path.join(runtime, 'queue', ahead));
  assert.equal(waitForHeavyLease(runtime, { id: 'mine' }, lease, { maxWaitMs: 60, pollMs: 10 }).acquired, true);
}));

test('guardPre ammette un comando pesante dopo un lease orfano e respinge in coda solo a tempo scaduto', () => withRuntime((runtime) => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    FRONTALIERE_AGENT_RUNTIME_DIR: runtime,
    FRONTALIERE_RESOURCE_FREE_PERCENT: '0',
    FRONTALIERE_RESOURCE_SWAP_RATIO: '2',
    FRONTALIERE_AGENT_OBSERVER_MAX_MS: '1',
  });
  try {
    const info = { payload: {}, command: 'git grep -n Rewarded -- scripts/ci/check-sibling-patterns.mjs', cwd: process.cwd(), sessionId: 'mine', toolCallId: '' };
    assert.equal(acquireHeavyLease(runtime, oldLease({ observerPid: 42 })).acquired, true);
    const held = guardPre(info, process.cwd(), { maxWaitMs: 50, pollMs: 10, observerAlive: () => true });
    assert.equal(held.allowed, false);
    assert.match(held.reason, /in coda da \d+s senza turno/);

    writeObserverStatus(runtime, 'held', true);
    const after = guardPre(info, process.cwd(), { maxWaitMs: 50, pollMs: 10, observerAlive: () => false });
    assert.equal(after.allowed, true);
    assert.equal(JSON.parse(readFileSync(path.join(runtime, 'heavy-lease.json'), 'utf8')).id, after.id);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}));

test('classifica la ricerca Git senza limite come job pesante non delimitato', () => {
  const result = classifyCommand("git log --all -S'Rewarded service VAST' --oneline");
  assert.equal(result.kind, 'git-history');
  assert.equal(result.heavy, true);
  assert.equal(result.unbounded, true);
});

test('un git grep mirato resta serializzato ma non viene rifiutato come full scan', () => {
  const result = classifyCommand('git grep -n Rewarded -- scripts/ci/check-sibling-patterns.mjs');
  assert.equal(result.kind, 'git-history');
  assert.equal(result.heavy, true);
  assert.equal(result.unbounded, false);
});

test('classifica il typecheck diretto e riconosce il wrapper incrementale', () => {
  assert.equal(classifyCommand('npm exec tsc -- --noEmit').unbounded, true);
  assert.equal(classifyCommand('tsc --noEmit --incremental').unbounded, false);
  assert.equal(classifyCommand('node "$WORKSPACE/bin/codex-typecheck.mjs" --changed').heavy, true);
  assert.equal(classifyCommand('node "$WORKSPACE/bin/codex-typecheck.mjs" --changed').unbounded, false);
});

test('la pressione memoria blocca sotto la soglia e lascia passare sopra', () => {
  assert.equal(pressureDecision({ freePercent: 7, swapUsedBytes: 1, swapTotalBytes: 10 }).blocked, true);
  assert.equal(pressureDecision({ freePercent: 20, swapUsedBytes: 1, swapTotalBytes: 10 }).blocked, false);
  assert.equal(pressureDecision({ freePercent: 20, swapUsedBytes: 9, swapTotalBytes: 10 }).blocked, true);
});

// Il caso misurato il 2026-10-03: swap occupato all'89% (3,66 GB su 4) ma 71%
// di memoria libera e kernel a livello 1. Lo swap pieno era memoria gia'
// scaricata, non pressione, e bloccava ogni test di ogni agente.
test('lo swap pieno non blocca quando il kernel dice normale e la memoria libera abbonda', () => {
  const stale = { freePercent: 71, swapUsedBytes: 3660, swapTotalBytes: 4096, pressureLevel: 1 };
  assert.equal(pressureDecision(stale).blocked, false);
});

test('lo swap pieno blocca ancora quando un segnale di pressione attuale lo conferma', () => {
  // Kernel in avviso o critico: blocca anche con memoria libera e swap vuoto.
  assert.equal(pressureDecision({ freePercent: 71, swapUsedBytes: 9, swapTotalBytes: 10, pressureLevel: 2 }).blocked, true);
  assert.equal(pressureDecision({ freePercent: 71, swapUsedBytes: 1, swapTotalBytes: 10, pressureLevel: 4 }).blocked, true);
  // Kernel normale ma memoria libera sotto la soglia di conferma.
  assert.equal(pressureDecision({ freePercent: 20, swapUsedBytes: 9, swapTotalBytes: 10, pressureLevel: 1 }).blocked, true);
  // Il motivo nomina il segnale che ha deciso.
  assert.match(pressureDecision({ freePercent: 71, swapUsedBytes: 1, swapTotalBytes: 10, pressureLevel: 4 }).reason, /kernel/);
  assert.match(pressureDecision({ freePercent: 20, swapUsedBytes: 9, swapTotalBytes: 10, pressureLevel: 1 }).reason, /swap/);
});

test('senza il segnale del kernel lo swap pieno resta un blocco, come prima', () => {
  assert.equal(pressureDecision({ freePercent: 71, swapUsedBytes: 9, swapTotalBytes: 10 }).blocked, true);
  assert.equal(pressureDecision({ freePercent: 71, swapUsedBytes: 9, swapTotalBytes: 10, pressureLevel: Number.NaN }).blocked, true);
  // La memoria libera sotto la soglia principale blocca qualunque cosa dica il kernel.
  assert.equal(pressureDecision({ freePercent: 7, swapUsedBytes: 0, swapTotalBytes: 10, pressureLevel: 1 }).blocked, true);
});

test('il lease atomico ammette un solo job pesante', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  try {
    const first = { id: 'first', category: 'typecheck', startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const second = { id: 'second', category: 'git-history', startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    assert.equal(acquireHeavyLease(runtime, first).acquired, true);
    const blocked = acquireHeavyLease(runtime, second);
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.current.id, 'first');
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('cleanup senza sessione non libera il lease di un altro agente', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  try {
    const lease = { id: 'other', sessionId: 'other-session', category: 'build', startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    assert.equal(acquireHeavyLease(runtime, lease).acquired, true);
    cleanupRuntime(runtime);
    assert.equal(acquireHeavyLease(runtime, { id: 'local', sessionId: 'local-session', category: 'test', startedAt: Date.now(), expiresAt: Date.now() + 60_000 }).acquired, false);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('un post senza pre pendente non libera un lease ancora attivo', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  const previous = process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
  process.env.FRONTALIERE_AGENT_RUNTIME_DIR = runtime;
  try {
    const info = { payload: {}, command: 'npm run typecheck', cwd: process.cwd(), sessionId: 'same-session', toolCallId: '' };
    const lease = {
      id: invocationId(info),
      sessionId: info.sessionId,
      category: 'typecheck',
      commandHash: 'not-used-by-the-guard-without-pending',
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    assert.equal(acquireHeavyLease(runtime, lease).acquired, true);
    guardPost(info, process.cwd());
    assert.equal(acquireHeavyLease(runtime, { ...lease, id: 'next' }).acquired, false);
  } finally {
    if (previous === undefined) delete process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
    else process.env.FRONTALIERE_AGENT_RUNTIME_DIR = previous;
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('telemetria e redazione usano lo stesso id tra pre e post', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  const previous = process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
  const previousWorkspace = process.env.WORKSPACE;
  process.env.FRONTALIERE_AGENT_RUNTIME_DIR = runtime;
  process.env.WORKSPACE = path.resolve('.');
  try {
    const raw = JSON.stringify({
      session_id: 'test-session',
      cwd: process.cwd(),
      tool_input: { command: 'printf ok' },
    });
    const info = parsePayload(raw);
    const pre = guardPre(info, process.cwd());
    assert.equal(pre.allowed, true);
    guardPost({ ...info, payload: { ...info.payload, tool_response: { exit_code: 0 } } }, process.cwd());
    const lines = readFileSync(path.join(runtime, 'commands.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.filter((line) => line.type === 'command_start').length, 1);
    assert.equal(lines.filter((line) => line.type === 'command_end').length, 1);
    assert.match(redactCommand('gh --token github_pat_1234567890'), /<redacted>/);
  } finally {
    if (previous === undefined) delete process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
    else process.env.FRONTALIERE_AGENT_RUNTIME_DIR = previous;
    if (previousWorkspace === undefined) delete process.env.WORKSPACE;
    else process.env.WORKSPACE = previousWorkspace;
    rmSync(runtime, { recursive: true, force: true });
  }
});

// ── Il comando che cambia directory ────────────────────────────────────────
// L'8 ottobre 2026 un `cd <repo> && git grep ...` finito in due secondi ha
// tenuto il lease pesante per 11 minuti: l'id dell'invocazione conteneva la
// cwd, che il comando stesso aveva cambiato, quindi il PostToolUse non trovava
// il suo pending. In quella sessione 256 comandi su 1.245 erano rimasti senza
// `command_end`.

function withGuardEnv(runtime, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    FRONTALIERE_AGENT_RUNTIME_DIR: runtime,
    FRONTALIERE_RESOURCE_FREE_PERCENT: '0',
    FRONTALIERE_RESOURCE_SWAP_RATIO: '2',
    FRONTALIERE_AGENT_OBSERVER_MAX_MS: '1',
  });
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function commandEvents(runtime) {
  return readFileSync(path.join(runtime, 'commands.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .filter((line) => line.type === 'command_start' || line.type === 'command_end');
}

function pendingCount(runtime) {
  try { return readdirSync(path.join(runtime, 'pending')).length; } catch { return 0; }
}

test('un comando pesante che cambia directory viene chiuso dal suo PostToolUse e libera il lease', () => withRuntime((runtime) => withGuardEnv(runtime, () => {
  const before = {
    payload: {},
    command: 'cd sito && git grep -n Rewarded -- scripts/ci/check-sibling-patterns.mjs',
    cwd: '/workspace',
    sessionId: 'mine',
    toolCallId: '',
  };
  const pre = guardPre(before, process.cwd(), { maxWaitMs: 50, pollMs: 10 });
  assert.equal(pre.allowed, true);
  assert.equal(pre.classification.heavy, true);
  assert.equal(JSON.parse(readFileSync(path.join(runtime, 'heavy-lease.json'), 'utf8')).id, pre.id);

  // Il PostToolUse arriva con la directory in cui il comando ha lasciato la shell.
  const post = guardPost({ ...before, cwd: '/workspace/sito', payload: { tool_response: { exit_code: 0 } } }, process.cwd());

  assert.equal(post.hadPending, true);
  assert.equal(post.id, pre.id);
  assert.equal(existsSync(path.join(runtime, 'heavy-lease.json')), false);
  assert.equal(pendingCount(runtime), 0);
  assert.deepEqual(commandEvents(runtime).map((line) => [line.type, line.id]), [['command_start', pre.id], ['command_end', pre.id]]);
  // Il comando pesante successivo, di chiunque, entra subito.
  assert.equal(acquireHeavyLease(runtime, { id: 'next', sessionId: 'other', category: 'test', startedAt: Date.now(), expiresAt: Date.now() + 60_000 }).acquired, true);
})));

test('il post di un altro comando della stessa sessione non chiude il pending e non libera il lease', () => withRuntime((runtime) => withGuardEnv(runtime, () => {
  const running = {
    payload: {},
    command: 'cd sito && git grep -n Rewarded -- scripts/ci/check-sibling-patterns.mjs',
    cwd: '/workspace',
    sessionId: 'mine',
    toolCallId: '',
  };
  const pre = guardPre(running, process.cwd(), { maxWaitMs: 50, pollMs: 10 });
  assert.equal(pre.allowed, true);

  const stray = guardPost({ ...running, command: 'printf ok', cwd: '/workspace/sito' }, process.cwd());

  assert.equal(stray.hadPending, false);
  assert.equal(JSON.parse(readFileSync(path.join(runtime, 'heavy-lease.json'), 'utf8')).id, pre.id);
  assert.equal(pendingCount(runtime), 1);
  // Nemmeno lo stesso comando di un'altra sessione.
  const foreign = guardPost({ ...running, sessionId: 'someone-else', cwd: '/workspace/sito' }, process.cwd());
  assert.equal(foreign.hadPending, false);
  assert.equal(pendingCount(runtime), 1);
})));

test('un comando leggero che cambia directory non lascia un pending orfano', () => withRuntime((runtime) => withGuardEnv(runtime, () => {
  const before = { payload: {}, command: 'cd sito && printf ok', cwd: '/workspace', sessionId: 'mine', toolCallId: '' };
  const pre = guardPre(before, process.cwd());
  assert.equal(pre.allowed, true);
  assert.equal(pendingCount(runtime), 1);

  guardPost({ ...before, cwd: '/workspace/sito' }, process.cwd());

  assert.equal(pendingCount(runtime), 0);
  assert.deepEqual(commandEvents(runtime).map((line) => line.type), ['command_start', 'command_end']);
})));

test('con l\'id della chiamata l\'invocazione non dipende dalla directory ne\' dal nome del campo', () => {
  const raw = (cwd, idField) => JSON.stringify({ session_id: 's', cwd, [idField]: 'call-1', tool_input: { command: 'cd sito && printf ok' } });
  for (const field of ['tool_use_id', 'tool_call_id']) {
    const before = parsePayload(raw('/workspace', field));
    const after = parsePayload(raw('/workspace/sito', field));
    assert.equal(before.toolCallId, 'call-1', field);
    assert.equal(invocationId(before), invocationId(after), field);
  }
  const other = parsePayload(JSON.stringify({ session_id: 's', cwd: '/workspace', tool_use_id: 'call-2', tool_input: { command: 'cd sito && printf ok' } }));
  assert.notEqual(invocationId(other), invocationId(parsePayload(raw('/workspace', 'tool_use_id'))));
  // Senza id della chiamata la chiave resta comando + directory, come prima.
  const bare = (cwd) => parsePayload(JSON.stringify({ session_id: 's', cwd, tool_input: { command: 'printf ok' } }));
  assert.notEqual(invocationId(bare('/a')), invocationId(bare('/b')));
});

