import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheContext, cacheKey } from './pr-gate-cache.mjs';
import { gateFixture } from '../.codex/repo-pr-gate-dispatch.fixture.mjs';

test('la chiave del gate cambia con il comando e resta stabile a parita di contesto', () => {
  const base = {
    command: 'gh pr create --repo example/project --body-file .pr-body',
    cwd: process.cwd(),
    workspace: process.cwd(),
    dispatcher: new URL('./repo-pr-gate-dispatch.mjs', import.meta.url).pathname,
  };
  const first = cacheKey(cacheContext(base));
  const same = cacheKey(cacheContext({ ...base }));
  const changed = cacheKey(cacheContext({ ...base, command: `${base.command} --head feature/x` }));
  assert.equal(first, same);
  assert.notEqual(first, changed);
});

test('dalla root del workspace la chiave segue il commit del branch --head e il gate che giudica', (t) => {
  const fx = gateFixture();
  t.after(fx.cleanup);
  const context = () => cacheContext({
    command: 'gh pr create --repo valerielinc-ops/frontaliere-si-o-no --base main --head feat --body-file b.md',
    cwd: fx.workspace,
    workspace: fx.workspace,
    dispatcher: new URL('../.codex/repo-pr-gate-dispatch.mjs', import.meta.url).pathname,
  });
  const before = context();
  assert.equal(before.judgedCommit, fx.git(fx.feature, 'rev-parse', 'HEAD'));
  assert.ok(before.code.some((entry) => entry.startsWith(join(fx.feature, 'scripts', 'ci', 'sibling-check-gate.mjs'))));
  writeFileSync(join(fx.feature, 'other.txt'), 'nuovo commit\n');
  fx.git(fx.feature, 'add', 'other.txt');
  fx.git(fx.feature, 'commit', '-q', '-m', 'altro');
  assert.notEqual(cacheKey(context()), cacheKey(before));
});
