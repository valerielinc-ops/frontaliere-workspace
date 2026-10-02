import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(classifyCommand('node "$WORKSPACE/bin/codex-typecheck.mjs" --changed').heavy, false);
});

test('la pressione memoria blocca sotto la soglia e lascia passare sopra', () => {
  assert.equal(pressureDecision({ freePercent: 7, swapUsedBytes: 1, swapTotalBytes: 10 }).blocked, true);
  assert.equal(pressureDecision({ freePercent: 20, swapUsedBytes: 1, swapTotalBytes: 10 }).blocked, false);
  assert.equal(pressureDecision({ freePercent: 20, swapUsedBytes: 9, swapTotalBytes: 10 }).blocked, true);
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
