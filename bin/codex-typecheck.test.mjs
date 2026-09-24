import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, relevantToTypecheck, runTypecheck } from './codex-typecheck.mjs';

test('il wrapper separa opzioni Codex dagli argomenti passati a tsc', () => {
  assert.deepEqual(parseArgs(['--changed', '--project', 'tsconfig.json', '--', '--strict']), {
    repo: undefined,
    project: 'tsconfig.json',
    changed: true,
    full: false,
    json: false,
    extra: ['--strict'],
  });
});

test('solo sorgenti/configurazioni TypeScript rendono rilevante il typecheck', () => {
  assert.equal(relevantToTypecheck('src/App.tsx'), true);
  assert.equal(relevantToTypecheck('tsconfig.json'), true);
  assert.equal(relevantToTypecheck('README.md'), false);
});

test('il runner passa sempre incremental, tsbuildinfo dedicato e project a tsc', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-typecheck-test-'));
  try {
    mkdirSync(path.join(repo, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(path.join(repo, 'tsconfig.json'), '{}\n');
    writeFileSync(
      path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    const result = runTypecheck({ repoRoot: repo, project: 'tsconfig.json', extra: [], emit: false });
    assert.equal(result.status, 0);
    const args = JSON.parse(result.stdout);
    assert.ok(args.includes('--incremental'));
    assert.ok(args.includes('--tsBuildInfoFile'));
    assert.ok(args.includes('--project'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
