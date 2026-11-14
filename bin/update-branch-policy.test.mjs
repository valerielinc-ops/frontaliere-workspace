import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_UPDATE_BRANCH_ENV,
  OWNER_UPDATE_BRANCH_OVERRIDE,
  ownerUpdateBranchOverrideFromEnvironment,
  updateBranchBlockedResponse,
  updateBranchDetails,
  updateBranchInCommand,
} from './update-branch-policy.mjs';
import { GitHubCoordinator } from './github-coordinator.mjs';

const SITE = 'valerielinc-ops/frontaliere-si-o-no';
const CORPUS = 'nanakokyobashi-rgb/frontaliere-articles';
const here = dirname(fileURLToPath(import.meta.url));

test('blocca gh pr update-branch per sito e corpus', () => {
  for (const repo of [SITE, CORPUS]) {
    const details = updateBranchDetails({ type: 'exec', args: ['pr', 'update-branch', '123', '--repo', repo] });
    assert.equal(details?.kind, 'pr-cli');
    assert.equal(details?.repo, repo);
  }
  assert.equal(updateBranchDetails({
    type: 'exec', args: ['pr', 'update-branch', `https://github.com/${SITE}/pull/9`],
  })?.repo, SITE);
  assert.equal(updateBranchDetails({ type: 'exec', args: ['-R', SITE, 'pr', 'update-branch', '1'] })?.repo, SITE);
});

test('un repo non esplicito e trattato come coperto (fail-closed)', () => {
  assert.equal(updateBranchDetails({ type: 'exec', args: ['pr', 'update-branch', '12'] })?.repo, 'repo non esplicito');
  assert.ok(updateBranchDetails({
    type: 'exec', args: ['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/3/update-branch'],
  }));
});

test('blocca PUT update-branch via gh api, con -X o --method, e via protocollo api', () => {
  const path = `repos/${SITE}/pulls/42/update-branch`;
  for (const args of [
    ['api', '-X', 'PUT', path],
    ['api', '--method', 'PUT', `/${path}`],
    ['api', '--method=PUT', path],
    ['api', path, '-X', 'PUT', '-f', 'expected_head_sha=abc'],
    ['api', '-X', 'PUT', `https://api.github.com/repos/${CORPUS}/pulls/7/update-branch`],
  ]) {
    assert.equal(updateBranchDetails({ type: 'exec', args })?.kind, 'rest-cli', args.join(' '));
  }
  assert.equal(updateBranchDetails({ type: 'api', method: 'PUT', path: `/${path}` })?.kind, 'rest-api');
});

test('blocca la mutation GraphQL updatePullRequestBranch (inline, file, --input, body)', () => {
  const mutation = 'mutation { updatePullRequestBranch(input: {pullRequestId: "PR_x"}) { clientMutationId } }';
  assert.equal(updateBranchDetails({
    type: 'exec', args: ['api', 'graphql', '-f', `query=${mutation}`],
  })?.kind, 'graphql-cli');
  const dir = mkdtempSync(join(tmpdir(), 'update-branch-'));
  try {
    writeFileSync(join(dir, 'm.graphql'), mutation);
    assert.ok(updateBranchDetails({
      type: 'exec', cwd: dir, args: ['api', 'graphql', '-F', 'query=@m.graphql'],
    }));
    assert.ok(updateBranchDetails({
      type: 'exec', cwd: dir, args: ['api', 'graphql', '--input', 'm.graphql'],
    }));
    writeFileSync(join(dir, 'q.graphql'), 'query { viewer { login } }');
    assert.equal(updateBranchDetails({
      type: 'exec', cwd: dir, args: ['api', 'graphql', '-F', 'query=@q.graphql'],
    }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(updateBranchDetails({ type: 'api', method: 'POST', path: '/graphql', body: { query: mutation } }));
  assert.equal(updateBranchDetails({
    type: 'api', method: 'POST', path: '/graphql', body: { query: 'query { viewer { login } }' },
  }), null);
});

test('repo non coperti, GET innocui e altri comandi passano', () => {
  assert.equal(updateBranchDetails({
    type: 'exec', args: ['pr', 'update-branch', '1', '--repo', 'valerielinc-ops/frontaliere-workspace'],
  }), null);
  assert.equal(updateBranchDetails({
    type: 'exec', args: ['api', '-X', 'PUT', 'repos/someone/else/pulls/1/update-branch'],
  }), null);
  assert.equal(updateBranchDetails({
    type: 'exec', args: ['api', `repos/${SITE}/pulls/42/update-branch`],
  }), null);
  assert.equal(updateBranchDetails({
    type: 'api', method: 'GET', path: `/repos/${SITE}/pulls/42/update-branch`,
  }), null);
  for (const args of [
    ['api', `repos/${SITE}/pulls/42`],
    ['api', '-X', 'GET', `repos/${SITE}/pulls`, '-f', 'state=open'],
    ['pr', 'view', '12', '--repo', SITE],
    ['pr', 'merge', '12', '--repo', SITE, '--auto'],
    ['workflow', 'run', 'tests.yml'],
  ]) {
    assert.equal(updateBranchDetails({ type: 'exec', args }), null, args.join(' '));
  }
});

test('override proprietario richiede il valore esplicito', () => {
  assert.equal(ownerUpdateBranchOverrideFromEnvironment({}), false);
  assert.equal(ownerUpdateBranchOverrideFromEnvironment({ [OWNER_UPDATE_BRANCH_ENV]: '1' }), false);
  assert.equal(ownerUpdateBranchOverrideFromEnvironment({
    [OWNER_UPDATE_BRANCH_ENV]: OWNER_UPDATE_BRANCH_OVERRIDE,
  }), true);
});

test('messaggio rimanda ad AGENTS.md:71 e alla procedura conflitti', () => {
  const response = updateBranchBlockedResponse(updateBranchDetails({
    type: 'exec', args: ['pr', 'update-branch', '1', '--repo', SITE],
  }));
  assert.equal(response.ok, false);
  assert.equal(response.exitCode, 2);
  assert.equal(response.error.code, 'update_branch_blocked');
  assert.match(response.stderr, /AGENTS\.md:71/);
  assert.match(response.stderr, /git merge-tree/);
  assert.match(response.stderr, new RegExp(`${OWNER_UPDATE_BRANCH_ENV}=${OWNER_UPDATE_BRANCH_OVERRIDE}`));
});

test('il coordinatore rifiuta senza accodare e l override lascia passare', async () => {
  const coordinator = new GitHubCoordinator({
    identity: 'test-update-branch-guard',
    token: 'test-token-not-real',
    realGh: 'gh',
    socket: '/tmp/test-update-branch-guard.sock',
  });
  const request = { type: 'exec', args: ['pr', 'update-branch', '5', '--repo', SITE] };
  const blocked = await coordinator.submit(request);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'update_branch_blocked');
  assert.equal(coordinator.queue.length, 0);

  coordinator.executeCli = async () => ({ ok: true, exitCode: 0, stdout: 'owner override\n', stderr: '' });
  const allowed = await coordinator.submit({ ...request, ownerUpdateBranchOverride: true });
  assert.equal(allowed.ok, true);
});

test('updateBranchInCommand legge la forma shell, ignora heredoc e riconosce l override inline', () => {
  assert.ok(updateBranchInCommand(`gh pr update-branch 5 --repo ${SITE}`));
  assert.ok(updateBranchInCommand(`cd x && bin/gh-frontaliere pr update-branch 5 --repo ${CORPUS}`));
  assert.ok(updateBranchInCommand(`gh api --method PUT "repos/${SITE}/pulls/5/update-branch"`));
  assert.ok(updateBranchInCommand(
    `gh api graphql -f query='mutation { updatePullRequestBranch(input:{pullRequestId:"x"}) { clientMutationId } }'`,
  ));
  assert.equal(updateBranchInCommand(`cat <<'EOF'\ngh pr update-branch 5 --repo ${SITE}\nEOF`), null);
  assert.equal(updateBranchInCommand(`echo "gh pr update-branch 5 --repo ${SITE}"`), null);
  assert.equal(updateBranchInCommand(`gh pr view 5 --repo ${SITE}`), null);
  assert.equal(updateBranchInCommand(`${OWNER_UPDATE_BRANCH_ENV}=${OWNER_UPDATE_BRANCH_OVERRIDE} gh pr update-branch 5 --repo ${SITE}`)
    ?.inlineOverride, true);
});

function runHook(command, env = {}) {
  return spawnSync(process.execPath, [join(here, 'github-api-policy.mjs')], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { command } }),
    env: { ...process.env, [OWNER_UPDATE_BRANCH_ENV]: '', ...env },
  });
}

test('hook PreToolUse: blocca le tre forme con exit 2 e feedback', () => {
  for (const command of [
    `gh pr update-branch 5 --repo ${SITE}`,
    `gh api -X PUT repos/${CORPUS}/pulls/5/update-branch`,
    `gh api graphql -f query='mutation { updatePullRequestBranch(input:{pullRequestId:"x"}) { clientMutationId } }'`,
  ]) {
    const result = runHook(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /AGENTS\.md:71/);
  }
});

test('hook PreToolUse: override via env o inline, repo non coperti e letture passano', () => {
  const command = `gh pr update-branch 5 --repo ${SITE}`;
  assert.equal(runHook(command, { [OWNER_UPDATE_BRANCH_ENV]: OWNER_UPDATE_BRANCH_OVERRIDE }).status, 0);
  assert.equal(runHook(`${OWNER_UPDATE_BRANCH_ENV}=${OWNER_UPDATE_BRANCH_OVERRIDE} ${command}`).status, 0);
  assert.equal(runHook('gh pr update-branch 5 --repo someone/else').status === 2, false);
  assert.equal(runHook(`gh api repos/${SITE}/pulls/5/update-branch`).status === 2, false);
});
