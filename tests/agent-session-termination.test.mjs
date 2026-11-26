import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../bin/agent-resource-guard.mjs', import.meta.url));
const probe = spawnSync('python3', ['-c', `
import os, signal
assert hasattr(os, "waitid") and hasattr(os, "WNOWAIT") and hasattr(signal, "setitimer")
`]);
const pythonAvailable = !probe.error && probe.status !== null;
const supportsGrace = probe.status === 0;

const fixture = `
import os, signal, sys

mode = sys.argv[1]
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
if mode != "legacy":
    descendant = os.fork()
    if descendant == 0:
        signal.alarm(12)
        while True:
            signal.pause()
if mode != "stubborn":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(23))
signal.alarm(12)
print("ready", flush=True)
while True:
    signal.pause()
`;

async function within(promise, ms) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: timer.signal }).then(() => {
        throw new Error(`Timeout dopo ${ms} ms`);
      }),
    ]);
  } finally {
    timer.abort();
  }
}

async function run(args, verify) {
  const runtime = await mkdtemp(join(tmpdir(), 'agent-session-termination-'));
  const runner = spawn(process.execPath, [guard, '--run-llm', ...args], {
    env: { ...process.env, FRONTALIERE_AGENT_RUNTIME_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(runner, 'close');
  let output = '';
  let errors = '';
  runner.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  runner.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  let closeObserved = false;
  runner.once('close', () => { closeObserved = true; });
  try {
    await verify({
      runner,
      result: async (ms = 5000) => {
        const [code, signal] = await within(closed, ms);
        return { code, signal, errors };
      },
      ready: async () => {
        await within((async () => {
          while (!output.includes('\n')) {
            const [event] = await Promise.race([
              once(runner.stdout, 'data').then(() => ['data']),
              closed.then(() => ['close']),
            ]);
            assert.equal(event, 'data', errors);
          }
        })(), 5000);
      },
    });
  } finally {
    try {
      if (!closeObserved) {
        runner.kill('SIGTERM');
        try {
          // Each fixture has its own watchdog in case the relay regresses.
          await within(closed, 13000);
        } catch (error) {
          runner.kill('SIGKILL');
          await within(closed, 5000);
          throw error;
        }
      }
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  }
}

test('rifiuta valori non canonici e opzioni fuori ordine', async () => {
  const flag = '--termination-grace-ms';
  const invalid = [
    ...['0', '01', '-1', '+1', '1.0', '1e2', '1\n', '30001'].map((value) => [flag, value]),
    [flag],
    [flag, '1', '--reserve'],
    [flag, '1', flag, '2'],
  ];
  for (const options of invalid) {
    await run([...options, '--', 'python3', '-c', 'raise SystemExit(99)'], async ({ result }) => {
      const { code, errors } = await result();
      assert.equal(code, 2, JSON.stringify(options));
      assert.match(errors, /uso:/);
      assert.doesNotMatch(errors, /llm-lease acquired/);
    });
  }
});

test('il relay legacy inoltra TERM e restituisce il codice del figlio', { skip: !pythonAvailable }, async () => {
  await run(['--', 'python3', '-c', fixture, 'legacy'], async ({ runner, ready, result }) => {
    await ready();
    assert.ok(runner.kill('SIGTERM'));
    assert.equal((await result()).code, 23);
  });
});

test('opt-in con riserva conserva l’uscita normale', { skip: !supportsGrace }, async () => {
  await run(['--reserve', '--termination-grace-ms', '30000', '--', 'python3', '-c', 'raise SystemExit(17)'],
    async ({ result }) => {
      const { code, errors } = await result();
      assert.equal(code, 17);
      assert.match(errors, /acquired category=reserve/);
    });
});

test('la scadenza termina leader e discendente anche con segnali ripetuti', { skip: !supportsGrace }, async () => {
  await run(['--termination-grace-ms', '600', '--', 'python3', '-c', fixture, 'stubborn'],
    async ({ runner, ready, result }) => {
      await ready();
      const started = performance.now();
      assert.ok(runner.kill('SIGTERM'));
      const repeated = setInterval(() => runner.kill('SIGINT'), 100);
      try {
        const { code, signal, errors } = await result(3000);
        assert.equal(signal, null, errors);
        assert.equal(code, 137, errors);
        assert.ok(performance.now() - started >= 550);
      } finally {
        clearInterval(repeated);
      }
    });
});

test('l’uscita del leader dopo TERM termina subito il discendente', { skip: !supportsGrace }, async () => {
  await run(['--termination-grace-ms', '30000', '--', 'python3', '-c', fixture, 'leader-exits'],
    async ({ runner, ready, result }) => {
      await ready();
      assert.ok(runner.kill('SIGTERM'));
      // The descendant inherits stdout, so close also requires its exit.
      assert.equal((await result()).code, 23);
    });
});
