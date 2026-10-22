import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deployDispatchBlockedResponse,
  deployDispatchDetails,
  OWNER_DEPLOY_DISPATCH_ENV,
  OWNER_DEPLOY_DISPATCH_OVERRIDE,
  ownerDeployDispatchOverrideFromEnvironment,
} from '../bin/deploy-dispatch-policy.mjs';
import { GitHubCoordinator } from '../bin/github-coordinator.mjs';

test('blocca gh workflow run per entrambi i workflow auto-rilanciati', () => {
  for (const workflow of ['deploy.yml', 'deploy-publish.yml']) {
    const details = deployDispatchDetails({
      type: 'exec',
      args: ['workflow', 'run', workflow, '--repo', 'valerielinc-ops/frontaliere-si-o-no'],
    });
    assert.equal(details?.workflow, workflow);
    assert.equal(details?.kind, 'workflow-cli');
  }
});

test('blocca il dispatch REST POST sia via protocollo sia via gh api', () => {
  const path = '/repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/deploy.yml/dispatches';
  assert.equal(deployDispatchDetails({ type: 'api', method: 'POST', path })?.workflow, 'deploy.yml');
  assert.equal(deployDispatchDetails({
    type: 'exec',
    args: ['api', path, '--method', 'POST'],
  })?.workflow, 'deploy.yml');
  assert.equal(deployDispatchDetails({
    type: 'exec',
    args: ['api', path, '-f', 'ref=main'],
  })?.workflow, 'deploy.yml');
});

test('non-dispatch e letture REST non sono bloccati', () => {
  assert.equal(deployDispatchDetails({
    type: 'exec',
    args: ['workflow', 'run', 'tests.yml'],
  }), null);
  assert.equal(deployDispatchDetails({
    type: 'api',
    method: 'GET',
    path: '/repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/deploy.yml/dispatches',
  }), null);
  assert.equal(deployDispatchDetails({
    type: 'api',
    method: 'POST',
    path: '/repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/%ZZ/dispatches',
  }), null);
});

test('override proprietario richiede il valore esplicito', () => {
  assert.equal(ownerDeployDispatchOverrideFromEnvironment({}), false);
  assert.equal(ownerDeployDispatchOverrideFromEnvironment({
    [OWNER_DEPLOY_DISPATCH_ENV]: '1',
  }), false);
  assert.equal(ownerDeployDispatchOverrideFromEnvironment({
    [OWNER_DEPLOY_DISPATCH_ENV]: OWNER_DEPLOY_DISPATCH_OVERRIDE,
  }), true);
});

test('submit restituisce un errore chiaro senza entrare nella coda GitHub', async () => {
  const coordinator = new GitHubCoordinator({
    identity: 'test-deploy-guard',
    token: 'test-token-not-real',
    realGh: 'gh',
    socket: '/tmp/test-deploy-guard.sock',
  });
  const response = await coordinator.submit({
    type: 'exec',
    args: ['workflow', 'run', 'deploy-publish.yml'],
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'deploy_dispatch_blocked');
  assert.match(response.stderr, /auto-rilanciato/);
  assert.equal(coordinator.queue.length, 0);
});

test('l override esplicito lascia passare il request path senza cambiare la policy', async () => {
  const coordinator = new GitHubCoordinator({
    identity: 'test-deploy-guard-override',
    token: 'test-token-not-real',
    realGh: 'gh',
    socket: '/tmp/test-deploy-guard-override.sock',
  });
  coordinator.executeCli = async () => ({ ok: true, exitCode: 0, stdout: 'owner override\n', stderr: '' });
  const response = await coordinator.submit({
    type: 'exec',
    args: ['workflow', 'run', 'deploy.yml'],
    ownerDeployDispatchOverride: true,
  });
  assert.equal(response.ok, true);
  assert.equal(response.stdout, 'owner override\n');
});

