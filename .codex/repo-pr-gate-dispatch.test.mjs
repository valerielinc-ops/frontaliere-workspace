import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explicitRepository,
  hasExplicitRepositoryFlag,
  hasPullRequestCreationCommand,
  literalCommandDirectory,
  repositoryCheckout,
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

test('detects a real pull-request command at a shell command boundary', () => {
  assert.equal(hasPullRequestCreationCommand('gh pr create --base main'), true);
  assert.equal(hasPullRequestCreationCommand('printf ready; gh pr create --base main'), true);
  assert.equal(hasPullRequestCreationCommand('echo "gh pr create --base main"'), false);
  assert.equal(hasPullRequestCreationCommand("echo 'gh pr create --base main'"), false);
});

test('ignores pull-request text inside a quoted task and heredoc', () => {
  assert.equal(
    hasPullRequestCreationCommand('node agent.mjs "Please run gh pr create --base main"'),
    false,
  );
  assert.equal(
    hasPullRequestCreationCommand("cat <<'TASK'\ngh pr create --base main\nTASK"),
    false,
  );
});

test('resolves an absolute worktree cd before the PR command', () => {
  const worktree = process.cwd();
  assert.equal(
    literalCommandDirectory(
      `cd ${worktree} && gh pr create --base main`,
      worktree,
    ),
    worktree,
  );
});

test('keeps the configured checkout when the literal cd is not a sibling worktree', () => {
  assert.equal(
    repositoryCheckout('/workspace/frontaliere-si-o-no', 'gh pr create --base main', '/workspace'),
    '/workspace/frontaliere-si-o-no',
  );
});
