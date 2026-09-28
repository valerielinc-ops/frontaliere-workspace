import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { baseBranchMovement, GitHubCoordinator } from '../bin/github-coordinator.mjs';
import {
  eventMatchesSubscription,
  GitHubEventBroker,
  normalizeReconciliationEvent,
} from '../bin/github-event-broker.mjs';

const SITE = 'valerielinc-ops/frontaliere-si-o-no';
const SECRET = 'conflict-secret';

function signed(body) {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function setup({ listening = () => true } = {}) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-conflict-'));
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret: SECRET,
    deferredPersistDelayMs: 50,
  });
  const coordinator = new GitHubCoordinator({
    identity: 'default',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });
  coordinator.setEventListenerInspector(listening);
  coordinator.mergeabilityRecheckDelayMs = 0;
  coordinator.mergeabilityRetryDelaysMs = [10, 10, 10];
  const notified = [];
  coordinator.setEventNotifier((subscriptionId) => notified.push(subscriptionId));
  return {
    broker,
    coordinator,
    notified,
    cleanup() {
      broker.flush();
      rmSync(stateDirectory, { recursive: true, force: true });
    },
  };
}

function mockPulls(responses) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    calls.push(pathname);
    const queue = responses[pathname];
    const body = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
    if (!body) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function mergedPullRequestWebhook(number, { base = 'main', mergeSha = '63272d9fca9' } = {}) {
  return JSON.stringify({
    action: 'closed',
    number,
    repository: { full_name: SITE },
    pull_request: { number, merged: true, merge_commit_sha: mergeSha, base: { ref: base }, head: { sha: 'f00' } },
  });
}

const openPullRequest = (overrides = {}) => ({
  number: 10233,
  state: 'open',
  updated_at: '2026-09-28T13:50:00Z',
  base: { ref: 'main', sha: '63272d9fca9' },
  head: { sha: 'e980634cc2c' },
  mergeable: false,
  mergeable_state: 'dirty',
  ...overrides,
});

test('ogni observer di una PR riceve conflict anche senza chiederlo, qualunque sia la head', () => {
  const subscription = {
    id: 'sub-a', repo: SITE, resource: 'pull_request', number: 10233, sha: 'aaaaaaa1111',
    waitFor: ['merged', 'closed', 'reviewed'],
  };
  const conflict = normalizeReconciliationEvent({ subscription, data: openPullRequest() });
  assert.equal(conflict.state, 'conflict');
  assert.equal(eventMatchesSubscription(conflict, subscription), true, 'implicito e non vincolato allo SHA sottoscritto');

  const clean = normalizeReconciliationEvent({ subscription, data: openPullRequest({ mergeable: true, mergeable_state: 'clean' }) });
  assert.equal(eventMatchesSubscription(clean, { ...subscription, sha: null }), false);

  const anyPullRequest = { id: 'sub-b', repo: SITE, resource: 'pull_request', number: null, waitFor: ['opened'] };
  assert.equal(eventMatchesSubscription({ ...conflict, number: 10233 }, anyPullRequest), false, 'solo per una PR precisa');
});

test('riconosce lo spostamento della base dai webhook che arrivano davvero', () => {
  assert.deepEqual(baseBranchMovement('pull_request', JSON.parse(mergedPullRequestWebhook(10232))), {
    repo: SITE, branch: 'main', excludeNumber: 10232,
  });
  assert.deepEqual(baseBranchMovement('workflow_run', {
    action: 'requested', repository: { full_name: SITE }, workflow_run: { event: 'push', head_branch: 'main' },
  }), { repo: SITE, branch: 'main' });
  assert.equal(baseBranchMovement('workflow_run', {
    action: 'requested', repository: { full_name: SITE }, workflow_run: { event: 'pull_request', head_branch: 'feature' },
  }), null);
  assert.equal(baseBranchMovement('workflow_run', {
    action: 'completed', repository: { full_name: SITE }, workflow_run: { event: 'push', head_branch: 'main' },
  }), null);
  assert.deepEqual(baseBranchMovement('push', { ref: 'refs/heads/main', repository: { full_name: SITE } }), { repo: SITE, branch: 'main' });
  assert.equal(baseBranchMovement('pull_request', {
    action: 'closed', repository: { full_name: SITE }, pull_request: { number: 1, merged: false, base: { ref: 'main' } },
  }), null);
});

test('replay 28-09: il merge di #10232 su main produce conflict per l observer di #10233', async () => {
  const { broker, coordinator, notified, cleanup } = setup();
  // Il primo GET avvia il calcolo della mergeability e risponde null.
  const pulls = mockPulls({
    '/repos/valerielinc-ops/frontaliere-si-o-no/pulls/10233': [
      openPullRequest({ mergeable: null, mergeable_state: 'unknown' }),
      openPullRequest(),
    ],
  });
  try {
    const subscription = broker.subscribe({
      agentId: 'job-65da9118', repo: SITE, resource: 'pull_request', number: 10233,
      waitFor: ['merged', 'closed', 'reviewed'], ttlSeconds: 3_600,
    });
    const body = mergedPullRequestWebhook(10232);
    coordinator.ingestWebhook({
      eventName: 'pull_request', deliveryId: 'merge-10232', signature: signed(body), rawBody: body,
      receivedAt: '2026-09-28T14:16:12Z',
    });
    await coordinator.mergeabilityRecheckIdle();

    const pending = broker.pendingEvent(subscription.id);
    assert.equal(pending?.state, 'conflict');
    assert.equal(pending.mergeableState, 'dirty');
    assert.equal(pending.sha, 'e980634cc2c');
    assert.ok(notified.includes(subscription.id), 'il listener viene svegliato');
    assert.deepEqual(pulls.calls, [
      '/repos/valerielinc-ops/frontaliere-si-o-no/pulls/10233',
      '/repos/valerielinc-ops/frontaliere-si-o-no/pulls/10233',
    ], 'nessun GET per la PR appena mergiata; un retry sul mergeable null');
    assert.equal(coordinator.metrics.mergeabilityRetries, 1);
    assert.equal(coordinator.metrics.mergeabilityConflicts, 1);

    // Stessa head al prossimo spostamento di main: nessun duplicato dopo l'ack.
    assert.equal(broker.acknowledge(subscription.id, pending.id, { deferOnceRemoval: true }).ok, true);
    const nextPush = JSON.stringify({
      action: 'requested', repository: { full_name: SITE }, workflow_run: { id: 1, event: 'push', head_branch: 'main' },
    });
    coordinator.ingestWebhook({ eventName: 'workflow_run', deliveryId: 'push-run', signature: signed(nextPush), rawBody: nextPush });
    await coordinator.mergeabilityRecheckIdle();
    assert.equal(broker.pendingEvent(subscription.id), null);
  } finally {
    pulls.restore();
    cleanup();
  }
});

test('non interroga gli orfani, rispetta la base e riporta un conflitto su una head nuova', async () => {
  const listening = new Set();
  const { broker, coordinator, cleanup } = setup({ listening: (id) => listening.has(id) });
  const path = '/repos/valerielinc-ops/frontaliere-si-o-no/pulls/10233';
  const responses = { [path]: [openPullRequest()] };
  const pulls = mockPulls(responses);
  try {
    const subscription = broker.subscribe({
      repo: SITE, resource: 'pull_request', number: 10233, waitFor: ['merged'], ttlSeconds: 3_600, shared: true,
    });
    await coordinator.recheckMergeability({ repo: SITE, branch: 'main' });
    assert.deepEqual(pulls.calls, [], 'observer senza listener: nessun GET');

    listening.add(subscription.id);
    responses[path] = [openPullRequest({ base: { ref: 'release', sha: 'x' } })];
    await coordinator.recheckMergeability({ repo: SITE, branch: 'main' });
    assert.equal(broker.pendingEvent(subscription.id), null, 'la PR punta a un altro branch');

    responses[path] = [openPullRequest()];
    await coordinator.recheckMergeability({ repo: SITE, branch: 'main' });
    const first = broker.pendingEvent(subscription.id);
    assert.equal(first.state, 'conflict');
    broker.acknowledge(subscription.id, first.id, { deferOnceRemoval: true });

    // L'agente ha pushato una nuova head che resta in conflitto.
    responses[path] = [openPullRequest({ head: { sha: 'abcdef12345' } })];
    await coordinator.recheckMergeability({ repo: SITE, branch: 'main' });
    const second = broker.pendingEvent(subscription.id);
    assert.equal(second?.state, 'conflict');
    assert.notEqual(second.id, first.id);
  } finally {
    pulls.restore();
    cleanup();
  }
});
