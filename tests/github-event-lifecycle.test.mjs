import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  GitHubCoordinator,
  ORPHAN_IDLE_RETIRE_MS,
  ORPHAN_PENDING_RETIRE_MS,
  ORPHAN_RETIRE_STARTUP_GRACE_MS,
} from '../bin/github-coordinator.mjs';
import {
  ensureCoordinator,
  eventSubscription,
  listenForEvent,
  sendRequest,
  waitForCoordinatorStop,
} from '../bin/github-coordinator-client.mjs';
import {
  DEFERRED_PERSIST_DELAY_MS,
  GitHubEventBroker,
  REVIVED_SUBSCRIPTION_TTL_MS,
  normalizeWebhookEvent,
} from '../bin/github-event-broker.mjs';

const HOUR = 60 * 60 * 1_000;

const TEST_DEFERRED_DELAY_MS = 100;

function tempBroker({ nowMs = null, secret = 'lifecycle-secret' } = {}) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-lifecycle-'));
  const stateFile = join(stateDirectory, 'events.json');
  const clock = { nowMs: nowMs ?? Date.now() };
  const broker = new GitHubEventBroker({
    stateFile,
    webhookSecret: secret,
    now: () => clock.nowMs,
    deferredPersistDelayMs: TEST_DEFERRED_DELAY_MS,
  });
  return { stateDirectory, stateFile, clock, broker, cleanup: () => rmSync(stateDirectory, { recursive: true, force: true }) };
}

function mergedEvent(number, deliveryId, receivedAt) {
  return normalizeWebhookEvent({
    eventName: 'pull_request',
    deliveryId,
    receivedAt,
    payload: {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: { number, merged: true },
    },
  });
}

function signed(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('una delivery non abbinata non riscrive subito lo stato, un evento pending si', async () => {
  const { broker, stateFile, cleanup } = tempBroker({ nowMs: Date.now() });
  try {
    const subscription = broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 1, waitFor: ['merged'] });
    const afterSubscribe = broker.metrics.statePersists;

    const unrelated = JSON.stringify({ action: 'opened', repository: { full_name: 'owner/repo' }, pull_request: { number: 2 } });
    broker.ingestWebhook({ eventName: 'pull_request', deliveryId: 'd-unrelated', signature: signed(unrelated, 'lifecycle-secret'), rawBody: unrelated });
    assert.equal(broker.metrics.statePersists, afterSubscribe, 'nessuna scrittura sincrona');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).seenDeliveries.length, 0);

    // The duplicate is still recognized from memory before the flush.
    const duplicate = broker.ingestWebhook({ eventName: 'pull_request', deliveryId: 'd-unrelated', signature: signed(unrelated, 'lifecycle-secret'), rawBody: unrelated });
    assert.equal(duplicate.duplicate, true);
    broker.ingestWebhook({ eventName: 'pull_request', deliveryId: 'd-unrelated-2', signature: signed(unrelated, 'lifecycle-secret'), rawBody: unrelated });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, TEST_DEFERRED_DELAY_MS + 200));
    assert.equal(broker.metrics.statePersists, afterSubscribe + 1, 'scrittura accorpata');
    assert.equal(broker.metrics.deferredWrites, 1);
    assert.equal(broker.metrics.deferredPersists, 2, 'due delivery, una sola scrittura');
    assert.ok(DEFERRED_PERSIST_DELAY_MS >= 10_000, 'in produzione al massimo sei scritture differite al minuto');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).seenDeliveries.length, 2);

    const merged = JSON.stringify({ action: 'closed', repository: { full_name: 'owner/repo' }, pull_request: { number: 1, merged: true } });
    const result = broker.ingestWebhook({ eventName: 'pull_request', deliveryId: 'd-merged', signature: signed(merged, 'lifecycle-secret'), rawBody: merged });
    assert.deepEqual(result.matchedSubscriptionIds, [subscription.id]);
    assert.equal(broker.metrics.statePersists, afterSubscribe + 2, 'il pending va su disco prima della risposta');
    assert.equal(broker.metrics.durablePersists, afterSubscribe + 1);
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.subscriptions[0].pending.length, 1);
  } finally {
    cleanup();
  }
});

test('il dedup delle delivery resta limitato e riconosce le piu recenti', () => {
  const { broker, cleanup } = tempBroker({ nowMs: Date.now() });
  try {
    const body = JSON.stringify({ action: 'opened', repository: { full_name: 'owner/repo' }, pull_request: { number: 9 } });
    const signature = signed(body, 'lifecycle-secret');
    for (let index = 0; index <= 5_000; index += 1) {
      broker.ingestWebhook({ eventName: 'pull_request', deliveryId: `bulk-${index}`, signature, rawBody: body });
    }
    assert.equal(broker.state.seenDeliveries.length, 5_000);
    assert.equal(broker.state.seenDeliveries[0].id, 'bulk-1');
    assert.equal(broker.ingestWebhook({ eventName: 'pull_request', deliveryId: 'bulk-5000', signature, rawBody: body }).duplicate, true);
    assert.notEqual(broker.ingestWebhook({ eventName: 'pull_request', deliveryId: 'bulk-0', signature, rawBody: body }).duplicate, true);
    broker.flush();
  } finally {
    cleanup();
  }
});

test('una subscription one-shot privata non accoda eventi dopo il primo terminale', () => {
  const { broker, clock, cleanup } = tempBroker({ nowMs: Date.parse('2026-09-28T10:00:00Z') });
  try {
    const privateOnce = broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 5, waitFor: ['merged', 'closed'] });
    const shared = broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 5, waitFor: ['merged', 'closed'], shared: true, allowDuplicate: true });
    const at = new Date(clock.nowMs).toISOString();
    broker.recordEvent(mergedEvent(5, 'first-merge', at));
    broker.recordEvent(mergedEvent(5, 'redelivered-merge', at));
    assert.equal(broker.getSubscriptionRecord(privateOnce.id).pending.length, 1);
    assert.equal(broker.getSubscriptionRecord(shared.id).pending.length, 2, 'lo stream condiviso resta intero');
    assert.equal(broker.metrics.pendingSuperseded, 1);
    broker.flush();
  } finally {
    cleanup();
  }
});

test('la scadenza non scansiona finche nulla puo scadere', () => {
  const { broker, clock, cleanup } = tempBroker({ nowMs: Date.parse('2026-09-28T10:00:00Z') });
  try {
    const subscription = broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 6, waitFor: ['merged'], ttlSeconds: 10 });
    assert.deepEqual(broker.expireSubscriptions(), []);
    assert.equal(broker.nextPruneAtMs, broker.getSubscriptionRecord(subscription.id).expiresAtMs);
    let scans = 0;
    const original = broker.pruneExpiredSubscriptions.bind(broker);
    broker.pruneExpiredSubscriptions = (...args) => { scans += 1; return original(...args); };
    clock.nowMs += 5_000;
    for (let index = 0; index < 100; index += 1) broker.expireSubscriptions();
    assert.equal(scans, 0);
    clock.nowMs += 6_000;
    assert.deepEqual(broker.expireSubscriptions(), [subscription.id]);
    assert.equal(scans, 1);
  } finally {
    cleanup();
  }
});

test('archivia e ripristina una subscription con i suoi pending, anche dopo un riavvio', () => {
  const { broker, stateFile, clock, cleanup } = tempBroker({ nowMs: Date.parse('2026-09-28T10:00:00Z') });
  try {
    const subscription = broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 7, waitFor: ['merged'], ttlSeconds: 600 });
    broker.recordEvent(mergedEvent(7, 'merge-7', new Date(clock.nowMs).toISOString()));
    assert.deepEqual(broker.retireSubscriptions([{ id: subscription.id, reason: 'pending_without_listener' }]), [subscription.id]);
    assert.equal(broker.getSubscriptionRecord(subscription.id), null);
    assert.equal(broker.summary().retiredSubscriptionCount, 1);
    assert.equal(broker.metrics.pendingEventsRetired, 1);

    clock.nowMs += 2 * HOUR;
    const restored = new GitHubEventBroker({ stateFile, webhookSecret: 'lifecycle-secret', now: () => clock.nowMs });
    assert.equal(restored.retiredSubscription(subscription.id).retiredReason, 'pending_without_listener');
    const revived = restored.reviveSubscription(subscription.id);
    assert.equal(revived.id, subscription.id);
    assert.equal(revived.pending[0].id, 'merge-7');
    assert.ok(revived.expiresAtMs >= clock.nowMs + REVIVED_SUBSCRIPTION_TTL_MS);
    assert.equal(restored.retiredSubscription(subscription.id), null);
    assert.equal(restored.pendingEvent(subscription.id).id, 'merge-7');
    assert.equal(restored.acknowledge(subscription.id, 'merge-7').subscriptionRemoved, true);
  } finally {
    cleanup();
  }
});

test('archivia solo gli orfani certi, dopo la grace di avvio', () => {
  const nowMs = Date.parse('2026-09-28T12:00:00Z');
  const { broker, clock, cleanup } = tempBroker({ nowMs: nowMs - 8 * HOUR });
  try {
    const subscribe = (spec) => broker.subscribe({ repo: 'owner/repo', ttlSeconds: 7 * 24 * 3_600, ...spec }).id;
    const idleOld = subscribe({ resource: 'pull_request', number: 10, waitFor: ['merged'] });
    const idleUnreconcilable = subscribe({ resource: 'workflow_run', branch: 'main', waitFor: ['completed'] });
    const live = subscribe({ resource: 'pull_request', number: 11, waitFor: ['merged'] });
    const expiringSoon = subscribe({ resource: 'pull_request', number: 14, waitFor: ['merged'], ttlSeconds: 3_600 });
    clock.nowMs = nowMs - 7.5 * HOUR;
    broker.recordEvent(mergedEvent(14, 'merge-14', new Date(clock.nowMs).toISOString()));
    clock.nowMs = nowMs - 2 * HOUR;
    const pendingOld = subscribe({ resource: 'pull_request', number: 12, waitFor: ['merged'] });
    broker.recordEvent(mergedEvent(12, 'merge-12', new Date(clock.nowMs).toISOString()));
    clock.nowMs = nowMs - 10 * 60 * 1_000;
    const pendingRecent = subscribe({ resource: 'pull_request', number: 13, waitFor: ['merged'] });
    broker.recordEvent(mergedEvent(13, 'merge-13', new Date(clock.nowMs).toISOString()));
    clock.nowMs = nowMs;

    const coordinator = new GitHubCoordinator({
      identity: 'lifecycle-test',
      token: 'secret-for-test',
      realGh: '/bin/echo',
      socket: '/tmp/frontaliere-event-lifecycle.sock',
      eventBroker: broker,
    });
    coordinator.setEventListenerInspector((id) => id === live);
    coordinator.startedAtMs = nowMs - ORPHAN_RETIRE_STARTUP_GRACE_MS + 1_000;
    assert.deepEqual(coordinator.retireOrphanedSubscriptions({ nowMs }), [], 'appena avviato: nessuna archiviazione');

    coordinator.startedAtMs = nowMs - 12 * HOUR;
    const retired = coordinator.retireOrphanedSubscriptions({ nowMs });
    assert.deepEqual(new Set(retired), new Set([idleOld, pendingOld, expiringSoon]));
    const reasons = Object.fromEntries(retired.map((id) => [id, broker.retiredSubscription(id).retiredReason]));
    assert.equal(reasons[idleOld], 'listener_absent');
    assert.equal(reasons[pendingOld], 'pending_without_listener');
    assert.equal(reasons[expiringSoon], 'expired_without_listener');
    for (const kept of [idleUnreconcilable, live, pendingRecent]) {
      assert.ok(broker.getSubscriptionRecord(kept), `${kept} resta attiva`);
    }
    assert.ok(ORPHAN_PENDING_RETIRE_MS < 2 * HOUR && ORPHAN_IDLE_RETIRE_MS < 8 * HOUR);

    // Recent listener activity postpones the archive.
    coordinator.noteListenerActivity(pendingRecent, nowMs);
    assert.deepEqual(coordinator.retireOrphanedSubscriptions({ nowMs: nowMs + ORPHAN_PENDING_RETIRE_MS - 1_000 }), []);
  } finally {
    cleanup();
  }
});

test('un nuovo agente non eredita gli eventi pending di un observer condiviso abbandonato', async () => {
  const { broker, cleanup } = tempBroker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ number: 21, state: 'open', head: { sha: 'abc' } }), { status: 200 });
  };
  try {
    const coordinator = new GitHubCoordinator({
      identity: 'lifecycle-test',
      token: 'secret-for-test',
      realGh: '/bin/echo',
      socket: '/tmp/frontaliere-event-lifecycle.sock',
      eventBroker: broker,
    });
    const listening = new Set();
    coordinator.setEventListenerInspector((id) => listening.has(id));
    const spec = { repo: 'owner/repo', resource: 'pull_request', number: 21, waitFor: ['merged', 'closed'], shared: true, ttlSeconds: 3_600 };
    const stale = broker.subscribe({ ...spec, agentId: 'gone' });
    broker.recordEvent(mergedEvent(21, 'old-merge-21', new Date().toISOString()));

    const joined = await coordinator.eventSubscription({ ...spec, agentId: 'newcomer' });
    assert.notEqual(joined.subscription.id, stale.id, 'nessun join sul record con eventi vecchi');
    assert.equal(joined.subscription.pendingEvents, 0);
    assert.equal(calls.length, 1, 'riconciliato come una subscription nuova');

    // With a live listener the canonical record is shared as before.
    listening.add(stale.id);
    const shared = await coordinator.eventSubscription({ ...spec, agentId: 'teammate' });
    assert.equal(shared.subscription.id, stale.id);
    assert.equal(calls.length, 1);
    broker.flush();
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test('lo sweep serve prima gli observer con listener e ritarda gli orfani', async () => {
  const { broker, cleanup } = tempBroker();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ number: 1, state: 'open', head: { sha: 'abc' } }), { status: 200 });
  };
  try {
    const coordinator = new GitHubCoordinator({
      identity: 'lifecycle-test',
      token: 'secret-for-test',
      realGh: '/bin/echo',
      socket: '/tmp/frontaliere-event-lifecycle.sock',
      eventBroker: broker,
    });
    const orphan = broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 31, waitFor: ['merged'], ttlSeconds: 3_600 });
    const live = broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 32, waitFor: ['merged'], ttlSeconds: 3_600 });
    coordinator.setEventListenerInspector((id) => id === live.id);
    const nowMs = Date.now();
    await coordinator.reconcileStaleSubscriptions({ nowMs, minIntervalMs: 600_000, maxPerSweep: 1 });
    assert.deepEqual(calls, ['/repos/owner/repo/pulls/32']);
    await coordinator.reconcileStaleSubscriptions({ nowMs, minIntervalMs: 600_000, maxPerSweep: 1 });
    assert.deepEqual(calls.at(-1), '/repos/owner/repo/pulls/31');

    calls.length = 0;
    await coordinator.reconcileStaleSubscriptions({ nowMs: nowMs + 600_000, minIntervalMs: 600_000, maxPerSweep: 5 });
    assert.deepEqual(calls, ['/repos/owner/repo/pulls/32'], 'l orfano aspetta un intervallo piu lungo');
    assert.ok(broker.getSubscriptionRecord(orphan.id));
  } finally {
    globalThis.fetch = originalFetch;
    broker.flush();
    cleanup();
  }
});

test('events listen ripristina dal daemon una subscription archiviata e consegna il pending', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-event-revive-');
  const identity = 'event-revive-integration';
  const secret = 'event-revive-secret';
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = secret;

  try {
    // Archive written by a previous daemon: a dead session's merged PR.
    const seed = new GitHubEventBroker({ stateFile: join(stateDirectory, `github-events-${identity}.json`), webhookSecret: secret });
    const subscription = seed.subscribe({ agentId: 'dead-session', repo: 'owner/repo', resource: 'pull_request', number: 41, waitFor: ['merged'], ttlSeconds: 3_600 });
    seed.recordEvent(mergedEvent(41, 'merge-41', new Date().toISOString()));
    seed.retireSubscriptions([{ id: subscription.id, reason: 'pending_without_listener' }]);

    await ensureCoordinator(identity);
    await assert.rejects(
      eventSubscription(subscription.id, { identity }),
      (error) => error.code === 'event_subscription_not_found' && error.nextAction === 'listen_to_revive',
    );
    const event = await listenForEvent(subscription.id, {
      identity,
      agentId: 'dead-session',
      timeoutMs: 5_000,
      heartbeatIntervalMs: 50,
      reconcileAfterMs: 0,
    });
    assert.equal(event.id, 'merge-41');
    assert.equal(event.state, 'merged');
  } finally {
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity, 5_000);
    } catch {
      // The daemon may not have started if the setup failed.
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
