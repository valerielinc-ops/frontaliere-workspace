import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dailyBriefWorkflowEnableDetails,
  DAILY_BRIEF_WORKFLOW_ID,
  DAILY_BRIEF_WORKFLOW_NAME,
  DAILY_BRIEF_WORKFLOW_PATH,
} from './daily-brief-owner-policy.mjs';
import { containsDirectCall, explicitGhApiInvocation } from './github-api-policy.mjs';
import { GitHubCoordinator } from './github-coordinator.mjs';

function coordinator() {
  return new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: '/tmp/frontaliere-github-coordinator-daily-brief-test.sock',
  });
}

test('identifica la daily-brief per nome, path e id', () => {
  for (const selector of [DAILY_BRIEF_WORKFLOW_NAME, DAILY_BRIEF_WORKFLOW_PATH, DAILY_BRIEF_WORKFLOW_ID]) {
    const details = dailyBriefWorkflowEnableDetails({
      type: 'exec',
      args: ['workflow', 'enable', selector, '--repo', 'valerielinc-ops/frontaliere-si-o-no'],
    });
    assert.equal(details.workflow, DAILY_BRIEF_WORKFLOW_PATH);
    assert.equal(details.workflowId, DAILY_BRIEF_WORKFLOW_ID);
  }

  assert.equal(dailyBriefWorkflowEnableDetails({
    type: 'api',
    method: 'PUT',
    path: '/repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/329980428/enable',
  }).repo, 'valerielinc-ops/frontaliere-si-o-no');
  assert.equal(dailyBriefWorkflowEnableDetails({
    type: 'exec',
    args: [
      'api', '--method', 'PUT', '--repo', 'valerielinc-ops/frontaliere-si-o-no',
      'actions/workflows/send-daily-brief.yml/enable',
    ],
  }).workflow, DAILY_BRIEF_WORKFLOW_PATH);
  assert.equal(dailyBriefWorkflowEnableDetails({
    type: 'exec',
    args: ['workflow', 'enable', 'other.yml'],
  }), null);
  assert.equal(dailyBriefWorkflowEnableDetails({
    type: 'api',
    method: 'POST',
    path: '/repos/owner/repo/actions/workflows/329980428/enable',
  }), null);
});
test('il guard hook continua a bloccare un gh reale fuori dallo shim', () => {
  const command = '/opt/homebrew/bin/gh workflow enable send-daily-brief.yml --repo valerielinc-ops/frontaliere-si-o-no';
  assert.equal(explicitGhApiInvocation(command), true);
  assert.equal(containsDirectCall(command), true);
});

test('sospende gh workflow enable fino alla conferma interattiva del proprietario', async () => {
  const instance = coordinator();
  const request = {
    type: 'exec',
    identity: 'test',
    args: ['workflow', 'enable', DAILY_BRIEF_WORKFLOW_PATH, '--repo', 'valerielinc-ops/frontaliere-si-o-no'],
    cwd: '/tmp',
  };

  const blocked = await instance.submit(request);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.error.code, 'daily_brief_workflow_enable_owner_confirmation_required');
  assert.match(blocked.stderr, /owner_command=bin\/gh-frontaliere confirm-workflow-enable enable-daily-brief-/);
  assert.equal(instance.metrics.cliCommands, 0);
  assert.equal(instance.status().pendingWorkflowEnables.length, 1);

  const requestId = blocked.error.requestId;
  const pending = instance.getPendingWorkflowEnable(requestId);
  assert.equal(pending.ok, true);
  assert.equal(pending.workflowEnable.workflowId, DAILY_BRIEF_WORKFLOW_ID);

  const invalid = await instance.confirmWorkflowEnable(requestId, 'NO');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'owner_confirmation_invalid');
  assert.equal(instance.status().pendingWorkflowEnables.length, 1);

  const confirmed = await instance.confirmWorkflowEnable(requestId, `CONFERMA ${requestId}`);
  assert.equal(confirmed.ok, true);
  assert.match(confirmed.stdout, /workflow enable send-daily-brief\.yml/);
  assert.equal(instance.status().pendingWorkflowEnables.length, 0);
  assert.equal(instance.metrics.workflowEnableConfirmed, 1);
});

test('blocca anche il PUT REST equivalente senza eseguire una richiesta', async () => {
  const instance = coordinator();
  const blocked = await instance.submit({
    type: 'api',
    method: 'PUT',
    path: '/repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/329980428/enable',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.error.code, 'daily_brief_workflow_enable_owner_confirmation_required');
  assert.equal(instance.metrics.networkRequests, 0);
});
