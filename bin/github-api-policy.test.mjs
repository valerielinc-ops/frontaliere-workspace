import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsDirectCall,
  explicitGhApiInvocation,
} from './github-api-policy.mjs';

test('detects a real pull-request command', () => {
  const command = '/opt/homebrew/bin/gh pr create --base main --title "test"';
  assert.equal(explicitGhApiInvocation(command), true);
  assert.equal(containsDirectCall(command), true);
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
