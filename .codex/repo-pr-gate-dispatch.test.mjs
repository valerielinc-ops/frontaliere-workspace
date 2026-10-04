import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  branchWorktree,
  explicitRepository,
  hasExplicitRepositoryFlag,
  headBranch,
  hasPullRequestCreationCommand,
  literalCommandDirectory,
  repositoryCheckout,
  repositoryDirectory,
} from './repo-pr-gate-dispatch.mjs';
import { gateFixture } from './repo-pr-gate-dispatch.fixture.mjs';

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

// Incident 2026-10-04: a sub-agent ran `gh pr create --head <branch>` from the
// workspace root, without `cd`. The dispatcher fell back to the main site
// checkout, which sat on another session's branch with a gate and a sibling
// checker weeks behind origin/main, and the PR was blocked on candidates the
// proposed code did not have. The fixture reproduces that layout: each copy of
// the gate only says which copy it is.
const DISPATCHER = fileURLToPath(new URL('./repo-pr-gate-dispatch.mjs', import.meta.url));
const SITE_REPO = 'valerielinc-ops/frontaliere-si-o-no';
function runDispatcher(workspace, command) {
  return spawnSync(process.execPath, [DISPATCHER], {
    input: JSON.stringify({ tool_input: { command }, cwd: workspace }),
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE: workspace },
  });
}

test('headBranch reads --head/-H literals and drops the owner prefix', () => {
  assert.equal(headBranch('gh pr create --repo o/r --base main --head feat/x --body-file b.md'), 'feat/x');
  assert.equal(headBranch('gh pr create --head=feat'), 'feat');
  assert.equal(headBranch('gh pr create -H "owner:feat"'), 'feat');
  assert.equal(headBranch("gh pr create --head 'feat'"), 'feat');
  assert.equal(headBranch('gh pr create --base main'), undefined);
  assert.equal(headBranch('gh pr create --head "$BRANCH"'), undefined);
  assert.equal(headBranch('git push --head x; echo ok'), undefined);
});

test('without cd, --head routes the gate to the worktree of that branch, not the main checkout', (t) => {
  const fx = gateFixture();
  t.after(fx.cleanup);
  assert.equal(branchWorktree(fx.site, 'feat'), realpathSync(fx.feature));
  const result = runDispatcher(fx.workspace, `gh pr create --repo ${SITE_REPO} --base main --head feat --body-file b.md`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gate: head-worktree/);
  assert.doesNotMatch(result.stderr, /stale-main-checkout/);
});

test('without cd and without a checked-out --head, hooks-main judges instead of the main checkout', (t) => {
  const fx = gateFixture();
  t.after(fx.cleanup);
  for (const command of [
    `gh pr create --repo ${SITE_REPO} --base main --body-file b.md`,
    `gh pr create --repo ${SITE_REPO} --base main --head not-checked-out --body-file b.md`,
  ]) {
    const result = runDispatcher(fx.workspace, command);
    assert.match(result.stderr, /gate: origin-main/, command);
  }
});

test('the main checkout stays the last resort when hooks-main is missing', (t) => {
  const fx = gateFixture();
  t.after(fx.cleanup);
  fx.git(fx.site, 'worktree', 'remove', '--force', join(fx.site, '.claude', 'worktrees', 'hooks-main'));
  const result = runDispatcher(fx.workspace, `gh pr create --repo ${SITE_REPO} --base main --body-file b.md`);
  assert.match(result.stderr, /gate: stale-main-checkout/);
});
