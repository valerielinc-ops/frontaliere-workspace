import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LEASE_START_GRACE_MS,
  acquireHeavyLease,
  classifyCommand,
  cleanupRuntime,
  findModernGitExecutable,
  guardPost,
  guardPre,
  invocationId,
  leaseStaleReason,
  parsePayload,
  pressureDecision,
  partialCloneGitDecision,
  queueHead,
  redactCommand,
  runtimeDirectory,
  sparseCheckoutDisableDecision,
  waitForHeavyLease,
} from './agent-resource-guard.mjs';

const DEAD_PID = 2 ** 22 + 12345;

const guardScript = fileURLToPath(new URL('./agent-resource-guard.mjs', import.meta.url));
const waitingSession = `
  process.on('SIGTERM', () => process.exit(42));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  setTimeout(() => process.exit(99), 10_000);
  console.log('ready ' + process.ppid);
`;

function llmFixture(t) {
  assert.ok(['darwin', 'linux'].includes(process.platform), 'I test dei lease LLM richiedono macOS o Linux');
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-llm-test-'));
  const sessions = [];
  t.after(async () => {
    for (const { child } of sessions) child.stdin.end();
    await Promise.allSettled(sessions.map(({ done }) => done));
    rmSync(runtime, { recursive: true, force: true });
  });

  return (command, { reserve = false, args = [] } = {}) => {
    const child = spawn(process.execPath, [
      guardScript, '--run-llm', ...(reserve ? ['--reserve'] : []), '--',
      process.execPath, '-e', command, '--', ...args,
    ], {
      cwd: runtime,
      env: { ...process.env, FRONTALIERE_AGENT_RUNTIME_DIR: runtime },
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdin.on('error', () => {}); // A refused runner can close its pipe first.
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    let markReady;
    const handshake = new Promise((resolve) => { markReady = resolve; });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      const ready = /^ready (\d+)\n/.exec(stdout);
      if (ready) markReady({ supervisorPid: Number(ready[1]) });
    });
    const done = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    sessions.push({ child, done });
    return {
      child,
      done,
      async ready() {
        const result = await Promise.race([handshake, done]);
        assert.ok(result.supervisorPid > 1, 'il processo finto deve segnalare che è pronto');
        return result.supervisorPid;
      },
    };
  };
}

test('il runner ammette due sessioni e riusa lo slot alla fine', async (t) => {
  const run = llmFixture(t);
  const first = run(waitingSession);
  await first.ready();
  const second = run(waitingSession);
  await second.ready();

  const probe = 'console.log("launched")';
  assert.deepEqual(await run(probe).done, {
    code: 75, signal: null, stdout: '', stderr: 'llm-lease refused category=ordinary slot=none\n',
  });
  first.child.stdin.end();
  assert.equal((await first.done).code, 0);
  assert.deepEqual(await run(probe).done, {
    code: 0, signal: null, stdout: 'launched\n', stderr: 'llm-lease acquired category=ordinary slot=1\n',
  });
});

test('una riserva esclude la seconda e lascia disponibile lo slot ordinario', async (t) => {
  const run = llmFixture(t);
  const first = run(waitingSession, { reserve: true });
  await first.ready();

  const probe = 'console.log("launched")';
  assert.deepEqual(await run(probe, { reserve: true }).done, {
    code: 75, signal: null, stdout: '', stderr: 'llm-lease refused category=reserve slot=none\n',
  });
  assert.deepEqual(await run(probe).done, {
    code: 0, signal: null, stdout: 'launched\n', stderr: 'llm-lease acquired category=ordinary slot=2\n',
  });
});

test('il runner passa gli argomenti letterali e propaga il codice di uscita', async (t) => {
  const run = llmFixture(t);
  const args = ['due parole', '$(echo expanded); *', '--reserve', '', 'riga\nnuova'];
  const result = await run('console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = 23', { args }).done;
  assert.equal(result.code, 23);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(result.stderr, 'llm-lease acquired category=ordinary slot=1\n');
});

test('SIGTERM al runner raggiunge il processo finto e ne propaga il codice', async (t) => {
  const session = llmFixture(t)(waitingSession);
  await session.ready();
  assert.equal(session.child.kill('SIGTERM'), true);
  assert.equal((await session.done).code, 42);
});

test('il figlio conserva il lock quando il supervisore Python muore', async (t) => {
  const run = llmFixture(t);
  // When the outer CLI exits, Node closes the test's stdin pipe. Keep this
  // fake session alive independently of that pipe until its own deadline.
  const first = run("setTimeout(() => {}, 4000); console.log('ready ' + process.ppid)");
  const supervisorPid = await first.ready();
  const second = run(waitingSession);
  await second.ready();

  const runnerExit = once(first.child, 'exit');
  process.kill(supervisorPid, 'SIGKILL');
  assert.deepEqual(await runnerExit, [137, null]);
  assert.equal((await run('console.log("launched")').done).code, 75);
  assert.equal((await first.done).code, 137);
  assert.equal((await run('console.log("launched")').done).code, 0);
});

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

test('recupera un avvio mai osservato solo con identita e assenza nativa provate', () => withRuntime((runtime) => {
  const at = Date.now();
  const lease = oldLease({ startedAt: at - 120_000, hookPid: 41, observerPid: 42, command: 'node scripts/ci/check-sibling-patterns.mjs', commandHash: 'command-hash' });
  const status = { version: 2, id: lease.id, hookPid: 41, observerPid: 42, leaseStartedAt: lease.startedAt, commandHash: lease.commandHash, seen: false, startupComplete: true, ownerAbsentAtEnd: true, endedAt: at - 40_000, pids: [] };
  const writeStatus = (value) => {
    mkdirSync(path.join(runtime, 'observer-status'), { recursive: true });
    writeFileSync(path.join(runtime, 'observer-status', `${lease.id}.json`), JSON.stringify(value));
  };
  const options = { now: at, observerAlive: () => false, processAlive: () => false, processRows: () => [] };
  writeStatus(status);
  assert.equal(leaseStaleReason(lease, runtime, options), 'avvio terminato senza processi attivi');
  for (const field of ['id', 'hookPid', 'observerPid', 'leaseStartedAt', 'commandHash']) {
    writeStatus({ ...status, [field]: 'different-invocation' });
    assert.equal(leaseStaleReason(lease, runtime, options), undefined, field);
  }
  for (const change of [{ startupComplete: false }, { ownerAbsentAtEnd: false }, { pids: null }, { endedAt: at - 1_000 }, { version: 1 }]) {
    writeStatus({ ...status, ...change });
    assert.equal(leaseStaleReason(lease, runtime, options), undefined);
  }
  writeStatus(status);
  for (const pid of [41, 42]) {
    assert.equal(leaseStaleReason(lease, runtime, { ...options, processAlive: (candidate) => candidate === pid }), undefined, 'un PID vivo o riusato resta protetto');
  }
  for (const rows of [null, [{ pid: 99, ppid: 1, elapsed: '01:00:00', command: lease.command }], [{ pid: 100, ppid: 1, elapsed: '01:30', command: '/usr/bin/worker-child' }], [{ pid: 100, ppid: 1, command: '/usr/bin/worker-child' }]]) {
    assert.equal(leaseStaleReason(lease, runtime, { ...options, processRows: () => rows }), undefined, 'processo vivo/adottato o scan incompleto');
  }
  writeStatus({ ...status, pids: [101] });
  assert.equal(leaseStaleReason(lease, runtime, { ...options, processRows: () => [{ pid: 101, ppid: 1, elapsed: '01:00:00', command: '/usr/bin/worker-child' }] }), undefined, 'figlio attestato ancora vivo');
  writeStatus(status);
  assert.equal(leaseStaleReason(lease, runtime, { ...options, processRows: () => [{ pid: 102, ppid: 1, elapsed: '01:00:00', command: '/usr/bin/existing-daemon' }] }), 'avvio terminato senza processi attivi');
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


// ── Sparse checkout del sito ────────────────────────────────────────────────
// 2026-11-15: quattro worktree del sito da 5,55 GiB, nati sparse e poi resi
// completi con `git sparse-checkout disable`, hanno riempito il disco.

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function withWorkspace(fn) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'frontaliere-sparse-guard-')));
  try {
    const workspace = path.join(root, 'workspace');
    const repos = {
      site: path.join(workspace, 'frontaliere-si-o-no'),
      corpus: path.join(workspace, 'frontaliere-articles'),
      reddit: path.join(workspace, 'frontaliere-reddit-devvit'),
    };
    for (const repo of Object.values(repos)) {
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '--quiet', repo]);
      git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
    }
    const siteWorktree = path.join(repos.site, '.claude', 'worktrees', 'task');
    git(repos.site, 'worktree', 'add', '--quiet', '-b', 'task', siteWorktree);
    // A linked worktree of the site that lives OUTSIDE the site directory.
    const farWorktree = path.join(root, 'elsewhere', 'far-task');
    git(repos.site, 'worktree', 'add', '--quiet', '-b', 'far', farWorktree);
    const corpusWorktree = path.join(repos.corpus, '.claude', 'worktrees', 'task');
    git(repos.corpus, 'worktree', 'add', '--quiet', '-b', 'task', corpusWorktree);
    return fn({ root, workspace, ...repos, siteWorktree, farWorktree, corpusWorktree });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const decide = (ctx, command, cwd) => sparseCheckoutDisableDecision(command, cwd, ctx.workspace);

test('blocca sparse-checkout disable, config core.sparseCheckout false e -c nel clone del sito', () => withWorkspace((ctx) => {
  const blocked = [
    'git sparse-checkout disable',
    'git config core.sparseCheckout false',
    'git config --worktree core.sparseCheckout false',
    'git config --local core.sparsecheckout FALSE',
    'git config --worktree core.sparseCheckout 0',
    'git config --worktree --unset core.sparseCheckout',
    'git config set --worktree core.sparseCheckout false',
    'git -c core.sparseCheckout=false checkout main',
    "git -c 'core.sparseCheckout=false' read-tree -mu HEAD",
    'git -c core.sparseCheckout=false worktree add ../x origin/main',
    'git --no-pager sparse-checkout disable',
    'FOO=1 git sparse-checkout disable',
    'git config core.sparseCheckout false 2>&1',
    'echo prima && git sparse-checkout disable && echo dopo',
  ];
  for (const command of blocked) {
    const decision = decide(ctx, command, ctx.site);
    assert.ok(decision, command);
    assert.match(decision.reason, /5,5 GiB di public\/ e data\//);
    assert.match(decision.reason, /git sparse-checkout add <path>/);
    assert.match(decision.reason, /git show origin\/main:<path>/);
    assert.match(decision.reason, /git ls-tree/);
  }
}));

test('lo stesso vale in un worktree del sito, dentro o fuori dalla sua cartella', () => withWorkspace((ctx) => {
  for (const cwd of [ctx.siteWorktree, ctx.farWorktree, path.join(ctx.siteWorktree, 'scripts', 'dev')]) {
    assert.ok(decide(ctx, 'git sparse-checkout disable', cwd), cwd);
    assert.ok(decide(ctx, 'git config --worktree core.sparseCheckout false', cwd), cwd);
  }
}));

test('segue git -C, cd e i path relativi per trovare il repo bersaglio', () => withWorkspace((ctx) => {
  // da fuori dal sito, ma il bersaglio e' il sito
  assert.ok(decide(ctx, `git -C ${ctx.site} sparse-checkout disable`, ctx.workspace));
  assert.ok(decide(ctx, `git -C "${ctx.siteWorktree}" sparse-checkout disable`, ctx.corpus));
  assert.ok(decide(ctx, 'git -C frontaliere-si-o-no sparse-checkout disable', ctx.workspace), 'path relativo alla cwd');
  assert.ok(decide(ctx, 'git -C ../frontaliere-si-o-no config core.sparseCheckout false', ctx.corpus), 'path relativo con ..');
  assert.ok(decide(ctx, 'git -C . -C .claude/worktrees/task sparse-checkout disable', ctx.site), '-C ripetuti si compongono');
  assert.ok(decide(ctx, 'cd frontaliere-si-o-no && git sparse-checkout disable', ctx.workspace));
  assert.ok(decide(ctx, 'cd frontaliere-si-o-no; cd .claude/worktrees/task; git -c core.sparseCheckout=false checkout .', ctx.workspace));
  assert.ok(decide(ctx, `cd "${ctx.farWorktree}" && git sparse-checkout disable`, ctx.corpus));
  assert.equal(decide(ctx, 'git -C "$VARIABILE_SCONOSCIUTA_XYZ/frontaliere-si-o-no" sparse-checkout disable', ctx.corpus), undefined, 'variabile non risolta: bersaglio ignoto, fail-open');
  const savedWorkspace = process.env.WORKSPACE;
  process.env.WORKSPACE = ctx.workspace;
  try {
    assert.ok(decide(ctx, 'git -C "$WORKSPACE/frontaliere-si-o-no" sparse-checkout disable', ctx.corpus), '$WORKSPACE si espande');
    assert.ok(decide(ctx, 'git -C ${WORKSPACE}/frontaliere-si-o-no sparse-checkout disable', ctx.corpus), '${WORKSPACE} si espande');
  } finally {
    if (savedWorkspace === undefined) delete process.env.WORKSPACE;
    else process.env.WORKSPACE = savedWorkspace;
  }
  // cwd nel sito ma il comando entra nel corpus: consentito
  assert.equal(decide(ctx, `git -C ${ctx.corpus} sparse-checkout disable`, ctx.site), undefined);
  assert.equal(decide(ctx, 'cd ../frontaliere-articles && git sparse-checkout disable', ctx.site), undefined);
}));

test('consente gli stessi comandi nel corpus e nel repo Reddit', () => withWorkspace((ctx) => {
  for (const cwd of [ctx.corpus, ctx.reddit, ctx.corpusWorktree, ctx.workspace]) {
    for (const command of ['git sparse-checkout disable', 'git config --worktree core.sparseCheckout false', 'git -c core.sparseCheckout=false checkout main']) {
      assert.equal(decide(ctx, command, cwd), undefined, `${command} in ${cwd}`);
    }
  }
}));

test('consente git sparse-checkout add e le alternative indicate nel messaggio', () => withWorkspace((ctx) => {
  for (const command of [
    'git sparse-checkout add docs',
    'git sparse-checkout add data/health-premiums public/data',
    'git sparse-checkout list',
    'git sparse-checkout set docs',
    'git config core.sparseCheckout',
    'git config --get core.sparseCheckout',
    'git config core.sparseCheckout true',
    'git config --worktree core.sparseCheckoutCone true',
    'git -c core.sparseCheckout=true status',
    'git show origin/main:docs/LOCAL-DEV.md',
    'git ls-tree -r origin/main docs',
    'git status',
    'echo "git sparse-checkout disable"',
    "git commit -m 'git sparse-checkout disable e config core.sparseCheckout false'",
  ]) {
    assert.equal(decide(ctx, command, ctx.site), undefined, command);
    assert.equal(decide(ctx, command, ctx.siteWorktree), undefined, command);
  }
}));

// 2026-11-15 11:24: un worktree sparse del sito è arrivato a 4,7 GiB con
// `git sparse-checkout add data`, senza mai disattivare lo sparse.
test('blocca sparse-checkout add/set che riprendono per intero data/, public/ o la radice nel sito', () => withWorkspace((ctx) => {
  const blocked = [
    'git sparse-checkout add data',
    'git sparse-checkout add data/',
    'git sparse-checkout add /data/',
    'git sparse-checkout add ./data/**',
    'git sparse-checkout add public',
    'git sparse-checkout add docs public/',
    "git sparse-checkout add '/*'",
    "git sparse-checkout set --no-cone '/*'",
    "git sparse-checkout set --no-cone '/*' '!/public/'",
    'git sparse-checkout set data',
    'git -C .claude/worktrees/task sparse-checkout add data',
  ];
  for (const command of blocked) {
    const decision = decide(ctx, command, ctx.site);
    assert.ok(decision, command);
    assert.match(decision.reason, /per intero data\//);
    assert.match(decision.reason, /git sparse-checkout add data\/faq-hub/);
  }
  assert.ok(decide(ctx, 'git sparse-checkout add data', ctx.farWorktree), 'worktree fuori dalla cartella del sito');
}));

test('consente i sotto-path, il profilo di fast-worktree e lo stesso comando fuori dal sito', () => withWorkspace((ctx) => {
  for (const command of [
    'git sparse-checkout add data/faq-hub public/assets/bridge.css',
    'git sparse-checkout add data/health-premiums public/data',
    "git sparse-checkout set --no-cone '/*' '!/public/' '!/data/'",
    "git sparse-checkout add '!/data/jobs/'",
    'git sparse-checkout add --stdin',
  ]) {
    assert.equal(decide(ctx, command, ctx.site), undefined, command);
  }
  for (const cwd of [ctx.corpus, ctx.corpusWorktree, ctx.reddit]) {
    assert.equal(decide(ctx, 'git sparse-checkout add data', cwd), undefined, cwd);
  }
}));

test('fast-worktree.sh --add data del sito è bloccato, quello del corpus no', () => withWorkspace((ctx) => {
  assert.ok(decide(ctx, 'frontaliere-si-o-no/scripts/dev/fast-worktree.sh x --add data', ctx.workspace));
  assert.ok(decide(ctx, 'scripts/dev/fast-worktree.sh x --add public/', ctx.site));
  assert.ok(decide(ctx, 'bash scripts/dev/fast-worktree.sh x --add docs --add data', ctx.site));
  assert.equal(decide(ctx, 'scripts/dev/fast-worktree.sh x --add data/health-premiums', ctx.site), undefined);
  assert.equal(decide(ctx, 'scripts/dev/fast-worktree.sh x', ctx.site), undefined);
  assert.equal(decide(ctx, 'frontaliere-articles/scripts/dev/fast-worktree.sh x --add data', ctx.workspace), undefined);
}));

test('--global e --system raggiungono il sito da qualsiasi directory', () => withWorkspace((ctx) => {
  assert.ok(decide(ctx, 'git config --global core.sparseCheckout false', ctx.corpus));
  assert.equal(decide(ctx, 'git config --global core.sparseCheckout true', ctx.corpus), undefined);
}));

test('guardPre rifiuta il comando nel sito, lo ammette nel corpus e rispetta il bypass del proprietario', () => withWorkspace((ctx) => withRuntime((runtime) => withGuardEnv(runtime, () => {
  const info = (command, cwd) => ({ payload: {}, command, cwd, sessionId: 'mine', toolCallId: '' });
  const blocked = guardPre(info('git sparse-checkout disable', ctx.siteWorktree), ctx.workspace);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /git sparse-checkout add <path>/);
  assert.ok(readFileSync(path.join(runtime, 'commands.jsonl'), 'utf8').includes('command_blocked'));
  assert.equal(guardPre(info('git sparse-checkout add docs', ctx.siteWorktree), ctx.workspace).allowed, true);
  assert.equal(guardPre(info('git sparse-checkout disable', ctx.corpusWorktree), ctx.workspace).allowed, true);
  assert.equal(guardPre(info('git sparse-checkout disable', ctx.reddit), ctx.workspace).allowed, true);
  process.env.FRONTALIERE_RESOURCE_GUARD_BYPASS = '1';
  assert.equal(guardPre(info('git sparse-checkout disable', ctx.siteWorktree), ctx.workspace).allowed, true);
}))));

// ── Clone parziale e oid completo ──────────────────────────────────────────
// Il clone filtrato resta locale e isolato: l'oid assente esiste solo nel bare
// usato come origin, quindi la sonda --no-lazy-fetch non deve toccare la rete.
function withPartialClone(fn) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'frontaliere-partial-git-')));
  try {
    const origin = path.join(root, 'origin.git');
    const source = path.join(root, 'source');
    const partial = path.join(root, 'partial clone');
    const full = path.join(root, 'full clone');
    mkdirSync(source);
    execFileSync('git', ['init', '--bare', '--quiet', origin]);
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', source]);
    git(source, 'config', 'user.email', 'guard-test@example.invalid');
    git(source, 'config', 'user.name', 'Guard test');
    writeFileSync(path.join(source, 'tracked.txt'), 'first commit\n');
    git(source, 'add', 'tracked.txt');
    git(source, 'commit', '--quiet', '-m', 'first');
    git(source, 'push', '--quiet', origin, 'HEAD:refs/heads/main');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');

    const originUrl = pathToFileURL(origin).href;
    execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', originUrl, partial]);
    const presentOid = git(source, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(source, 'second.txt'), 'second commit only in origin\n');
    git(source, 'add', 'second.txt');
    git(source, 'commit', '--quiet', '-m', 'second');
    git(source, 'push', '--quiet', origin, 'HEAD:refs/heads/main');
    const absentOid = git(source, 'rev-parse', 'HEAD').trim();
    execFileSync('git', ['clone', '--quiet', originUrl, full]);

    assert.equal(git(partial, 'config', '--get', 'remote.origin.promisor').trim(), 'true');
    return fn({ root, origin, source, partial, full, presentOid, absentOid });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const systemModernGit = findModernGitExecutable();
const modernGitSkip = systemModernGit ? false : 'richiede Git >= 2.44 per cat-file --no-lazy-fetch';

test('blocca gli oid completi assenti nelle forme di revisione e nei comandi Git che leggono oggetti', { skip: modernGitSkip }, () => withPartialClone((ctx) => {
  const oid = ctx.absentOid;
  const revisions = [
    oid,
    `${oid}^`,
    `${oid}~2`,
    `${oid}^{tree}`,
    `${oid}@{0}`,
    `${oid}:tracked.txt`,
    `${oid}..HEAD`,
    `HEAD...${oid}`,
  ];
  for (const revision of revisions) {
    const decision = partialCloneGitDecision(`git -C "${ctx.partial}" show ${revision}`, ctx.root);
    assert.ok(decision, revision);
    assert.match(decision.reason, /circa 450 MB/);
    assert.match(decision.reason, /git fetch origin refs\/pull\/<N>\/head/);
    assert.match(decision.reason, new RegExp(`git fetch origin ${oid}`));
  }
  const sha256Oid = 'a'.repeat(64);
  assert.match(partialCloneGitDecision(`git -C "${ctx.partial}" show ${sha256Oid}`, ctx.root)?.reason ?? '', new RegExp(sha256Oid));

  const objectReaders = [
    `git checkout ${oid}`,
    `git switch ${oid}`,
    `git reset ${oid}`,
    `git branch candidate ${oid}`,
    `git cherry-pick ${oid}`,
    `git revert ${oid}`,
    `git merge ${oid}`,
    `git rebase --onto ${oid}`,
    `git diff ${oid}`,
    `git log ${oid}`,
    `git show ${oid}`,
    `git merge-base ${oid} HEAD`,
    `git rev-list ${oid}`,
    `git rev-parse ${oid}`,
    `git cat-file -e ${oid}`,
    `git blame ${oid} -- tracked.txt`,
    `git describe ${oid}`,
    `git name-rev ${oid}`,
    `git range-diff ${oid}..HEAD`,
    `git format-patch ${oid}`,
    `git merge-tree ${oid} HEAD HEAD`,
    `git diff-tree ${oid}`,
    `git ls-tree ${oid}`,
    `git worktree add ../new-worktree ${oid}`,
  ];
  for (const command of objectReaders) {
    const decision = partialCloneGitDecision(`git -C "${ctx.partial}" ${command.slice(4)}`, ctx.root);
    assert.ok(decision, command);
  }

  for (const command of [
    `git -C "${ctx.partial}" show ${oid}`,
    `cd "${ctx.partial}" && git show ${oid}`,
    `env GUARD_TEST=1 git -C "${ctx.partial}" show ${oid}`,
    `git -c core.quotepath=false -C "${ctx.partial}" show ${oid} && printf ok`,
    `(git -C "${ctx.partial}" show ${oid})`,
    `printf start; git -C "${ctx.partial}" show ${oid} | cat`,
  ]) {
    assert.ok(partialCloneGitDecision(command, ctx.root), command);
  }

  const pre = guardPre({
    payload: {},
    command: `git -C "${ctx.partial}" show ${oid}`,
    cwd: ctx.root,
    sessionId: 'partial-clone-test',
    toolCallId: 'missing-oid',
  }, ctx.root);
  assert.equal(pre.allowed, false);
  assert.match(pre.reason, /circa 450 MB/);
}));

test('lascia passare oid presenti e clone completo, prefissi sconosciuti, fetch e sottocomandi esclusi', () => withPartialClone((ctx) => {
  if (systemModernGit) {
    assert.equal(partialCloneGitDecision(`git -C "${ctx.partial}" show ${ctx.presentOid}`, ctx.root), undefined);
  }
  const abbreviated = '1234567890abcdef';
  assert.equal(partialCloneGitDecision(`git -C "${ctx.partial}" log -1 ${abbreviated}`, ctx.root), undefined);
  assert.equal(partialCloneGitDecision(`git -C "${ctx.partial}" fetch origin ${ctx.absentOid}`, ctx.root), undefined);
  assert.equal(partialCloneGitDecision(`git -C "${ctx.partial}" push origin ${ctx.absentOid}`, ctx.root), undefined);
  assert.equal(partialCloneGitDecision(`git -C "${ctx.partial}" ls-remote origin ${ctx.absentOid}`, ctx.root), undefined);
  assert.equal(partialCloneGitDecision(`git -C "${ctx.partial}" config remote.origin.promisor ${ctx.absentOid}`, ctx.root), undefined);
  assert.equal(partialCloneGitDecision(`git --no-lazy-fetch -C "${ctx.partial}" show ${ctx.absentOid}`, ctx.root), undefined);
  assert.equal(partialCloneGitDecision(`git -C "${ctx.partial}" show ${ctx.absentOid}`, ctx.root, ctx.root, { modernGit: null }), undefined);
  const missingFromFullClone = execFileSync('git', ['-C', ctx.full, 'hash-object', '--stdin'], { input: 'computed but never stored\n', encoding: 'utf8' }).trim();
  assert.equal(partialCloneGitDecision(`git -C "${ctx.full}" show ${missingFromFullClone}`, ctx.root), undefined);
}));

test('riconosce un clone parziale da extensions.partialClone anche senza remote promisor', () => withPartialClone((ctx) => {
  git(ctx.partial, 'config', '--unset', 'remote.origin.promisor');
  git(ctx.partial, 'config', 'extensions.partialClone', 'origin');
  const decision = partialCloneGitDecision(`git -C "${ctx.partial}" log -p`, ctx.root);
  assert.ok(decision);
  assert.match(decision.reason, /blob storici/);
}));

test('senza Git >= 2.44 non sonda un oid assente', () => withPartialClone((ctx) => {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const legacyGit = path.join(ctx.root, 'git-legacy');
  const probeMarker = path.join(ctx.root, 'unexpected-probe');
  writeFileSync(legacyGit, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'git version 2.43.0\\n'; exit 0; fi\nif [ "$1" = "--no-lazy-fetch" ]; then : > '${probeMarker}'; exit 1; fi\nexec '${realGit}' "$@"\n`);
  chmodSync(legacyGit, 0o755);
  assert.equal(partialCloneGitDecision(
    `git -C "${ctx.partial}" show ${ctx.absentOid}`,
    ctx.root,
    ctx.root,
    { gitCandidates: [legacyGit] },
  ), undefined);
  assert.equal(existsSync(probeMarker), false, 'il Git vecchio non riceve mai la sonda cat-file');
}));

test('nei cloni parziali blocca scansioni log con blob storici e blame senza limite', () => withPartialClone((ctx) => {
  const blocked = [
    `git -C "${ctx.partial}" log -p`,
    `git -C "${ctx.partial}" log --patch -- tracked.txt`,
    `git -C "${ctx.partial}" whatchanged -Sneedle`,
    `cd "${ctx.partial}" && git log -Gneedle`,
    `git -C "${ctx.partial}" log --follow -- tracked.txt`,
    `git -C "${ctx.partial}" blame tracked.txt`,
  ];
  for (const command of blocked) {
    const decision = partialCloneGitDecision(command, ctx.root);
    assert.ok(decision, command);
    assert.match(decision.reason, /blob storici/);
  }
  for (const command of [
    `git -C "${ctx.partial}" blame -n 20 tracked.txt`,
    `git -C "${ctx.partial}" blame --max-count=20 tracked.txt`,
    `git -C "${ctx.partial}" blame --since=2026-01-01 tracked.txt`,
    `git -C "${ctx.partial}" blame HEAD~2..HEAD -- tracked.txt`,
    `git --no-lazy-fetch -C "${ctx.partial}" log -p`,
    `git -C "${ctx.full}" log -p`,
  ]) {
    assert.equal(partialCloneGitDecision(command, ctx.root), undefined, command);
  }
}));

test('il bypass del proprietario salta anche il blocco degli oid nei cloni parziali', () => withPartialClone((ctx) => withRuntime((runtime) => withGuardEnv(runtime, () => {
  const info = {
    payload: {},
    command: `git -C "${ctx.partial}" show ${ctx.absentOid}`,
    cwd: ctx.root,
    sessionId: 'partial-clone-bypass-test',
    toolCallId: 'bypass-oid',
  };
  process.env.FRONTALIERE_RESOURCE_GUARD_BYPASS = '1';
  assert.equal(guardPre(info, ctx.root).allowed, true);
}))));
