import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsDirectCall,
  explicitGhApiInvocation,
  pollingGhInvocation,
} from './github-api-policy.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = dirname(testDirectory);

function runPolicy(command) {
  return spawnSync(process.execPath, [join(testDirectory, 'github-api-policy.mjs')], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { command } }),
  });
}

function hookCommand(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return config.hooks.PreToolUse[0].hooks[0].command;
}

test('detects a real pull-request command', () => {
  const command = '/opt/homebrew/bin/gh pr create --base main --title "test"';
  assert.equal(explicitGhApiInvocation(command), true);
  assert.equal(containsDirectCall(command), true);
  assert.equal(runPolicy(command).status, 2);
});

test('blocks gh run watch', () => {
  assert.equal(containsDirectCall('gh run watch 123'), true);
  const result = runPolicy('gh run watch 123');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /events subscribe .*events listen <id>/);
});

test('allows the shared coordinator wrappers', () => {
  assert.equal(containsDirectCall('bin/gh-frontaliere pr view 123'), false);
  assert.equal(containsDirectCall('bin/gh-nanako run view 456'), false);
  assert.equal(runPolicy('bin/gh-frontaliere pr view 123').status, 0);
  assert.equal(runPolicy('bin/gh-nanako run view 456').status, 0);
});

test('recognizes polling only when a status query is looped or followed by sleep', () => {
  assert.equal(pollingGhInvocation('gh pr view 123; sleep 30'), true);
  assert.equal(pollingGhInvocation('while true; do gh run view 456; done'), true);
  assert.equal(pollingGhInvocation('gh pr checks 123'), false);
  assert.equal(pollingGhInvocation('echo "gh pr view 123"; sleep 30'), false);
  const result = runPolicy('gh pr view 123; sleep 30');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Polling GitHub/);
  assert.match(result.stderr, /events subscribe .*events listen <id>/);
});

test('ignores pull-request text inside a quoted task argument', () => {
  const command = 'node agent.mjs "Please run gh pr create --base main"';
  assert.equal(explicitGhApiInvocation(command), false);
  assert.equal(containsDirectCall(command), false);
  assert.equal(explicitGhApiInvocation("node agent.mjs 'Please run gh pr create --base main'"), false);
  assert.equal(containsDirectCall("node agent.mjs 'Please run gh pr create --base main'"), false);
});

test('ignores direct GitHub commands inside a heredoc body', () => {
  const command = "cat <<'TASK'\ngh pr create --base main\nTASK";
  assert.equal(explicitGhApiInvocation(command), false);
  assert.equal(containsDirectCall(command), false);
});

test('the root hook resolves the policy from a simulated child checkout', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'github-api-policy-'));
  const externalChild = mkdtempSync(join(tmpdir(), 'github-api-policy-outside-'));
  const childDirectory = join(temporaryRoot, 'frontaliere-si-o-no', '.wt', 'task');
  const policyPath = join(temporaryRoot, 'bin', 'github-api-policy.mjs');
  mkdirSync(childDirectory, { recursive: true });
  mkdirSync(dirname(policyPath), { recursive: true });
  writeFileSync(policyPath, 'process.stdout.write("resolved");\n');

  try {
    const command = hookCommand(join(workspaceDirectory, '.codex', 'hooks.json'));
    for (const [cwd, workspace] of [[childDirectory, ''], [externalChild, temporaryRoot]]) {
      const output = execFileSync('/bin/sh', ['-c', command], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: '',
          CODEX_PROJECT_DIR: '',
          PWD: cwd,
          WORKSPACE: workspace,
        },
        input: '{}',
      });
      assert.equal(output, 'resolved');
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(externalChild, { recursive: true, force: true });
  }
});

test('the two root hook configurations stay aligned', () => {
  assert.equal(
    hookCommand(join(workspaceDirectory, '.claude', 'settings.json')),
    hookCommand(join(workspaceDirectory, '.codex', 'hooks.json')),
  );
});
