import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explicitRepository,
  hasExplicitRepositoryFlag,
  repositoryDirectory,
} from './repo-pr-gate-dispatch.mjs';

test('routes a literal corpus --repo to the corpus checkout', () => {
  assert.equal(
    explicitRepository('gh pr create --repo nanakokyobashi-rgb/frontaliere-articles --base main'),
    'nanakokyobashi-rgb/frontaliere-articles',
  );
  assert.equal(
    repositoryDirectory('nanakokyobashi-rgb/frontaliere-articles', '/workspace'),
    '/workspace/frontaliere-articles',
  );
});

test('keeps the site as the default repository', () => {
  assert.equal(explicitRepository('gh pr create --base main'), undefined);
  assert.equal(repositoryDirectory(undefined, '/workspace'), '/workspace/frontaliere-si-o-no');
});

test('ignores unknown explicit repositories instead of applying the site gate', () => {
  assert.equal(explicitRepository('gh pr create --repo example/other'), undefined);
  assert.equal(hasExplicitRepositoryFlag('gh pr create --repo example/other'), true);
  assert.equal(repositoryDirectory('example/other', '/workspace'), undefined);
});
