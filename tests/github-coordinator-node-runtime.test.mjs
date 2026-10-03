import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../bin/github-coordinator-launcher', import.meta.url));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coordinator node runtime '));
  const entry = join(directory, 'entry.mjs');
  writeFileSync(entry, 'console.log(JSON.stringify({runtime:process.execPath,args:process.argv.slice(2)}));\n');
  const runtime = join(directory, 'node with spaces');
  symlinkSync(process.execPath, runtime);
  symlinkSync('/usr/bin/dirname', join(directory, 'dirname'));
  const env = {
    PATH: directory,
    FRONTALIERE_GH_COORDINATOR_ENTRY: entry,
    FRONTALIERE_GH_TOKEN: 'fixture-not-a-real-token',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'fixture-not-a-real-secret',
  };
  return {
    directory, runtime,
    run: (extra = {}) => spawnSync('/bin/bash', [launcher, 'serve', '--identity', 'fixture'], {
      env: { ...env, ...extra }, encoding: 'utf8', timeout: 5_000,
    }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('launcher uses explicit executable Node path with spaces and forwards arguments', () => {
  const f = fixture();
  try {
    const result = f.run({ FRONTALIERE_GH_NODE: f.runtime });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { runtime: process.execPath, args: ['serve', '--identity', 'fixture'] });
  } finally { f.cleanup(); }
});

test('launcher resolves Node from caller PATH before resetting PATH when override is absent', () => {
  const f = fixture();
  try {
    const result = f.run({ PATH: `${dirname(process.execPath)}:${f.directory}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runtime, process.execPath);
  } finally { f.cleanup(); }
});

test('launcher fails clearly for unavailable, relative, or nonexecutable runtime', () => {
  const f = fixture();
  try {
    const plainFile = join(f.directory, 'not executable');
    writeFileSync(plainFile, 'not an executable');
    for (const extra of [{ FRONTALIERE_GH_NODE: 'node' }, { FRONTALIERE_GH_NODE: plainFile }, { FRONTALIERE_GH_NODE: join(f.directory, 'missing') }]) {
      const result = f.run(extra);
      assert.equal(result.status, 127, result.stderr);
      assert.match(result.stderr, /Node executable unavailable/);
      assert.equal(result.stdout, '');
    }
  } finally { f.cleanup(); }
});
