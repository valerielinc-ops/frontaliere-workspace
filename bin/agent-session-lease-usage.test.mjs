import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./agent-resource-guard.mjs', import.meta.url));
const waitingSession = `
  process.on('SIGTERM', () => process.exit(42));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  setTimeout(() => process.exit(99), 10_000).unref();
  console.log('ready');
`;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'llm-lease-usage-test-'));
  const log = path.join(root, 'usage.jsonl');
  const sessions = [];
  for (const name of ['codex', 'claude', 'node']) {
    symlinkSync(process.execPath, path.join(root, name));
  }
  t.after(async () => {
    for (const { child } of sessions) child.stdin.end();
    await Promise.allSettled(sessions.map(({ done }) => done));
    rmSync(root, { recursive: true, force: true });
  });

  function run(name, script, { logPath = log, args = [] } = {}) {
    const env = {
      PATH: process.env.PATH,
      FRONTALIERE_AGENT_RUNTIME_DIR: path.join(root, 'runtime'),
    };
    if (logPath !== null) env.FRONTALIERE_LLM_USAGE_LOG = logPath;
    const child = spawn(process.execPath, [guard, '--run-llm', '--', path.join(root, name),
      '-e', script, '--', ...args], { cwd: root, env, timeout: 15_000 });
    let stdout = '';
    let stderr = '';
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (stdout.startsWith('ready\n')) markReady(true);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    sessions.push({ child, done });
    return {
      child,
      done,
      async ready() {
        assert.equal(await Promise.race([ready, done]), true);
      },
    };
  }

  function records() {
    const contents = readFileSync(log, 'utf8');
    assert.ok(contents.endsWith('\n'));
    return contents.slice(0, -1).split('\n').map((line) => JSON.parse(line));
  }

  return { root, log, run, records };
}

function assertPair([started, finished], provider) {
  const { id, startedAt } = started;
  const identity = { version: 1, id, provider, startedAt };
  assert.match(id, /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  assert.match(startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(new Date(startedAt).toISOString(), startedAt);
  assert.deepEqual(started, { ...identity, event: 'started' });
  const { durationMs } = finished;
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 0);
  assert.deepEqual(finished, { ...identity, event: 'finished', durationMs });
}

test('registra la coppia minima e preserva argomenti, output e codice del figlio', async (t) => {
  const { log, run, records } = fixture(t);
  const args = ['due parole', '$(echo expanded); *', '--reserve', '', 'riga\nnuova'];
  const result = await run('codex', 'console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = 23', { args }).done;
  assert.deepEqual(result, {
    code: 23, signal: null, stdout: JSON.stringify(args) + '\n',
    stderr: 'llm-lease acquired category=ordinary slot=1\n',
  });
  const events = records();
  assert.equal(events.length, 2);
  assertPair(events, 'codex');
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test('omette gli eventi senza opt-in, con path non valido, senza provider o con spawn fallito', async (t) => {
  const { root, log, run } = fixture(t);
  const scenarios = [
    ['codex', null, 0],
    ['codex', 'usage.jsonl', 0],
    ['codex', path.join(root, 'missing-parent', 'usage.jsonl'), 0],
    ['node', log, 0],
    ['missing/codex', log, 1],
  ];
  for (const [executable, logPath, code] of scenarios) {
    const result = await run(executable, '', { logPath }).done;
    assert.equal(result.code, code);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(path.join(root, 'missing-parent')), false);
  }
});

test('rifiuta symlink, file accessibili ad altri e hard link senza cambiare l’esito del figlio', async (t) => {
  const { root, log, run } = fixture(t);
  const target = path.join(root, 'target');
  writeFileSync(target, 'sentinel', { mode: 0o600 });
  const shared = path.join(root, 'shared');
  writeFileSync(shared, 'sentinel');
  chmodSync(shared, 0o644);
  const alias = path.join(root, 'alias');
  symlinkSync(target, log);
  assert.equal((await run('claude', '').done).code, 0);
  assert.equal(readFileSync(target, 'utf8'), 'sentinel');

  linkSync(target, alias);
  for (const unsafePath of [alias, shared]) {
    assert.equal((await run('claude', '', { logPath: unsafePath }).done).code, 0);
    assert.equal(readFileSync(unsafePath, 'utf8'), 'sentinel');
  }
});

test('registra due lease sovrapposti e conserva la fine dopo SIGTERM', async (t) => {
  const { run, records } = fixture(t);
  const first = run('codex', waitingSession);
  const second = run('claude', waitingSession);
  await Promise.all([first.ready(), second.ready()]);
  const refused = await run('codex', 'console.log("unexpected")').done;
  assert.deepEqual(refused, {
    code: 75, signal: null, stdout: '', stderr: 'llm-lease refused category=ordinary slot=none\n',
  });

  assert.equal(second.child.kill('SIGTERM'), true);
  assert.equal((await second.done).code, 42);
  first.child.stdin.end();
  assert.equal((await first.done).code, 0);

  const events = records();
  assert.equal(events.length, 4);
  const starts = events.filter(({ event }) => event === 'started');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].id, starts[1].id);
  for (const provider of ['codex', 'claude']) {
    const pair = events.filter((event) => event.provider === provider);
    assert.equal(pair.length, 2);
    assertPair(pair, provider);
  }
});
