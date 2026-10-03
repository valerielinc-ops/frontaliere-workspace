import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCommand, leaseStaleReason, LEASE_START_GRACE_MS } from './agent-resource-guard.mjs';
import { matchesObservedProcess } from './agent-command-observer.mjs';

for (const command of [
  'npx vitest run src/example.test.ts',
  'node node_modules/vitest/vitest.mjs run src/example.test.ts',
  'node /tmp/project/node_modules/vitest/vitest.mjs run src/example.test.ts',
  'node_modules/.bin/vitest run src/example.test.ts',
]) {
  test(`classifies and observes ${command}`, () => {
    const result = classifyCommand(command);
    assert.equal(result.heavy, true);
    assert.equal(result.matchNeedle, 'vitest');
    const row = { pid: 42, command: 'node /tmp/project/node_modules/vitest/vitest.mjs run src/example.test.ts' };
    assert.equal(matchesObservedProcess(row, result.kind, result.matchNeedle, command, new Set()), true);
    assert.equal(matchesObservedProcess(row, result.kind, result.matchNeedle, command, new Set([42])), false);
  });
}

test('vite build is distinct from vitest, including vitest-named paths', () => {
  const result = classifyCommand('cd /tmp/vitest-project && npx vite build');
  assert.equal(result.matchNeedle, 'vite');
  assert.equal(matchesObservedProcess({ pid: 1, command: 'node node_modules/vitest/vitest.mjs run' }, result.kind, result.matchNeedle, result.text, new Set()), false);
  assert.equal(matchesObservedProcess({ pid: 1, command: 'node node_modules/vite/bin/vite.js build' }, result.kind, result.matchNeedle, result.text, new Set()), true);
});

test('real ps observer sees a vitest entrypoint and proves lease completion', { timeout: 15000 }, async () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'resource-observer-test-'));
  const script = path.join(runtime, 'node_modules/vitest/vitest.mjs');
  const status = path.join(runtime, 'status.json');
  mkdirSync(path.dirname(script), { recursive: true });
  // Minimal idle fixture exercises actual process discovery without running a test suite.
  writeFileSync(script, 'setTimeout(() => {}, 3500);');
  const command = `node ${script} run`;
  const classification = classifyCommand(command);
  const baseline = execFileSync('ps', ['-axo', 'pid='], { encoding: 'utf8' }).trim().split(/\s+/).join(',');
  const fixture = spawn(process.execPath, [script, 'run'], { stdio: 'ignore' });
  const observer = spawn(process.execPath, [fileURLToPath(new URL('./agent-command-observer.mjs', import.meta.url)), '--runtime', runtime, '--id', 'fixture', '--command', command, '--category', classification.kind, '--needle', classification.matchNeedle, '--status', status, '--baseline-pids', baseline], { stdio: 'ignore', env: { ...process.env, FRONTALIERE_AGENT_OBSERVER_MAX_MS: '10000' } });
  try {
    const [code] = await once(observer, 'exit');
    assert.equal(code, 0);
    const summary = readFileSync(path.join(runtime, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(row => row.type === 'observer_summary');
    assert.equal(summary.seen, true);
    assert.ok(summary.pids.includes(fixture.pid));
    assert.ok(summary.wallMs < 10000, 'observer exits after fixture completion');
    mkdirSync(path.join(runtime, 'observer-status'));
    writeFileSync(path.join(runtime, 'observer-status/fixture.json'), readFileSync(status));
    assert.equal(leaseStaleReason({ id: 'fixture', observerPid: observer.pid, startedAt: Date.now() - LEASE_START_GRACE_MS - 1000, expiresAt: Date.now() + 900000 }, runtime, { observerAlive: () => false }), 'comando terminato');
  } finally {
    if (fixture.exitCode === null) fixture.kill();
    if (observer.exitCode === null) observer.kill();
    rmSync(runtime, { recursive: true, force: true });
  }
});
