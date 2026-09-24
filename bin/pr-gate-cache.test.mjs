import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheContext, cacheKey } from './pr-gate-cache.mjs';

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
