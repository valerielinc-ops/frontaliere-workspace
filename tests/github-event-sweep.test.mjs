import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubCoordinator } from '../bin/github-coordinator.mjs';
import {
  createUtf8ChunkDecoder,
  ensureCoordinator,
  sendRequest,
  socketPath,
  subscribeToEvents,
  waitForCoordinatorStop,
} from '../bin/github-coordinator-client.mjs';
import { eventLifecycleHealth } from '../bin/github-coordinator-health.mjs';
import {
  GitHubEventBroker,
  eventMatchesSubscription,
  normalizeWebhookEvent,
  shaMatches,
} from '../bin/github-event-broker.mjs';

function fakeResponse(status, body) {
  return new Response(body, { status, headers: { 'x-ratelimit-remaining': '100' } });
}

function makeCoordinator(stateDirectory, secret = 'sweep-secret') {
  const broker = new GitHubEventBroker({ stateFile: join(stateDirectory, 'events.json'), webhookSecret: secret });
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });
  return { broker, coordinator };
}

test('il decoder UTF-8 per stream ricompone un carattere spezzato fra due chunk', () => {
  const bytes = Buffer.from('revisione è ok 🔴', 'utf8');
  const cut = bytes.indexOf(Buffer.from('è', 'utf8')) + 1;
  const naive = bytes.subarray(0, cut).toString('utf8') + bytes.subarray(cut).toString('utf8');
  assert.notEqual(naive, 'revisione è ok 🔴');
  const decode = createUtf8ChunkDecoder();
  assert.equal(decode(bytes.subarray(0, cut)) + decode(bytes.subarray(cut)), 'revisione è ok 🔴');
});

test('una PR mergiata raggiunge l observer anche se la head e cambiata o lo SHA e abbreviato', () => {
  assert.equal(shaMatches('a211bffcc3e00079d631e93356c998460ffff94a', 'a211bffcc3e'), true);
  assert.equal(shaMatches('a211bffcc3e00079d631e93356c998460ffff94a', 'a211bf'), false);
  assert.equal(shaMatches('a211bffcc3e00079d631e93356c998460ffff94a', 'b211bffcc3e'), false);

  const subscription = {
    repo: 'owner/repo', resource: 'pull_request', number: 9262, sha: '322536e3c642', waitFor: ['merged', 'failed'],
  };
  const merged = normalizeWebhookEvent({
    eventName: 'pull_request',
    deliveryId: 'merged-after-autorebase',
    payload: {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 9262, merged: true, head: { sha: 'ffffffffffffffffffffffffffffffffffffffff' } },
    },
  });
  assert.equal(eventMatchesSubscription(merged, subscription), true);

  const failedOnOldHead = normalizeWebhookEvent({
    eventName: 'workflow_run',
    deliveryId: 'failed-other-head',
    payload: {
      action: 'completed',
      repository: { full_name: 'owner/repo' },
      workflow_run: {
        id: 1, conclusion: 'failure', head_sha: 'ffffffffffffffffffffffffffffffffffffffff', pull_requests: [{ number: 9262 }],
      },
    },
  });
  assert.equal(eventMatchesSubscription(failedOnOldHead, subscription), false, 'lo SHA filtra ancora i check');
});

test('waitFor reviewed consegna ogni review inviata con l autore', () => {
  const subscription = { repo: 'owner/repo', resource: 'pull_request', number: 5, waitFor: ['review_submitted'] };
  const broker = new GitHubEventBroker({
    stateFile: join(mkdtempSync(join(tmpdir(), 'frontaliere-review-')), 'events.json'),
    webhookSecret: 'x',
  });
  const created = broker.subscribe({ ...subscription, ttlSeconds: 60 });
  assert.deepEqual(broker.getSubscriptionRecord(created.id).waitFor, ['reviewed']);
  for (const state of ['commented', 'changes_requested', 'approved']) {
    const event = normalizeWebhookEvent({
      eventName: 'pull_request_review',
      deliveryId: `review-${state}`,
      payload: {
        action: 'submitted',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'claude[bot]' },
        review: { state, user: { login: 'claude[bot]' }, html_url: 'https://example/review' },
        pull_request: { number: 5, head: { sha: 'abc' } },
      },
    });
    assert.equal(event.actor, 'claude[bot]');
    assert.equal(eventMatchesSubscription(event, broker.getSubscriptionRecord(created.id)), true, state);
  }
  const comment = normalizeWebhookEvent({
    eventName: 'issue_comment',
    deliveryId: 'comment',
    payload: {
      action: 'created',
      repository: { full_name: 'owner/repo' },
      comment: { id: 9, user: { login: 'github-actions[bot]' }, html_url: 'https://example/c' },
      issue: { number: 5, pull_request: {} },
    },
  });
  assert.equal(comment.actor, 'github-actions[bot]');
  assert.equal(eventMatchesSubscription(comment, { ...subscription, waitFor: ['commented'] }), true);
});

test('lo sweep riconcilia le subscription persistite e consegna un merge perso', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-sweep-'));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return fakeResponse(200, JSON.stringify({
      number: 9254, state: 'closed', merged: true, merged_at: '2026-09-19T14:02:53Z',
      updated_at: '2026-09-19T14:02:53Z', head: { sha: 'newhead' },
    }));
  };
  const { broker, coordinator } = makeCoordinator(stateDirectory);
  try {
    // Persisted before a restart: no subscribe-time reconciliation in this process.
    const created = broker.subscribe({
      repo: 'owner/repo', resource: 'pull_request', number: 9254, sha: '0f4745d2', waitFor: ['merged'], ttlSeconds: 3600,
    });
    const nowMs = Date.now();
    const first = await coordinator.reconcileStaleSubscriptions({ nowMs });
    assert.deepEqual(calls, ['https://api.github.com/repos/owner/repo/pulls/9254']);
    assert.equal(first.reconciled.length, 1);
    assert.equal(broker.pendingEvent(created.id).state, 'merged');

    const second = await coordinator.reconcileStaleSubscriptions({ nowMs: nowMs + 60_000 });
    assert.equal(second.reconciled.length, 0, 'pending o intervallo non scaduto: nessuna nuova GET');
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('lo sweep rispetta l intervallo minimo e salta i target non riconciliabili', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-sweep-interval-'));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return fakeResponse(200, JSON.stringify({ number: 1, state: 'open', head: { sha: 'abc' } }));
  };
  const { broker, coordinator } = makeCoordinator(stateDirectory);
  try {
    broker.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 1, waitFor: ['merged'], ttlSeconds: 3600 });
    broker.subscribe({ repo: 'owner/repo', resource: 'workflow_run', branch: 'main', waitFor: ['completed'], ttlSeconds: 3600 });
    const nowMs = Date.now();
    await coordinator.reconcileStaleSubscriptions({ nowMs, minIntervalMs: 600_000 });
    await coordinator.reconcileStaleSubscriptions({ nowMs: nowMs + 300_000, minIntervalMs: 600_000 });
    assert.equal(calls.length, 1);
    await coordinator.reconcileStaleSubscriptions({ nowMs: nowMs + 600_000, minIntervalMs: 600_000 });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('il gc programmato in dry-run segnala l evento pending senza listener e non rimuove nulla', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-scheduled-gc-'));
  const { broker, coordinator } = makeCoordinator(stateDirectory);
  const originalWrite = process.stderr.write;
  const logged = [];
  try {
    coordinator.setEventListenerInspector(() => false);
    const created = broker.subscribe({
      agentId: 'dead-agent', repo: 'owner/repo', resource: 'pull_request', number: 9228, waitFor: ['merged'], ttlSeconds: 36_000,
    });
    broker.recordEvent(normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'merged-9228',
      receivedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      payload: {
        action: 'closed', repository: { full_name: 'owner/repo' }, pull_request: { number: 9228, merged: true },
      },
    }));
    process.stderr.write = (chunk) => { logged.push(String(chunk)); return true; };
    const report = coordinator.scheduledEventGarbageCollection();
    process.stderr.write = originalWrite;
    assert.equal(report.orphanedWithPending.length, 1);
    assert.equal(report.orphanedWithPending[0].id, created.id);
    assert.equal(report.orphanedWithPending[0].pendingState, 'merged');
    assert.ok(broker.getSubscriptionRecord(created.id), 'dry-run: la subscription resta');
    assert.ok(logged.some((line) => line.includes('event_gc_orphans_detected')));

    const health = eventLifecycleHealth({ scheduledGc: report }, 'default');
    assert.equal(health.alerts.some(({ code }) => code === 'orphaned_pending_events'), true);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('lo status compatto espone i contatori pending senza materializzare i dettagli del gc', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-compact-status-'));
  const { broker, coordinator } = makeCoordinator(stateDirectory);
  try {
    coordinator.setEventListenerInspector(() => false);
    const receivedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const created = broker.subscribe({
      agentId: 'compact-agent',
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 9229,
      waitFor: ['merged'],
      ttlSeconds: 36_000,
    });
    broker.recordEvent(normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'merged-9229',
      receivedAt,
      payload: {
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 9229, merged: true },
      },
    }));
    coordinator.scheduledEventGarbageCollection();

    const compact = coordinator.status({ compact: true });
    assert.equal(compact.events.pendingEvents, 1);
    assert.equal(compact.events.pendingSubscriptionCount, 1);
    assert.equal(compact.events.oldestPendingAt, receivedAt);
    assert.equal(Object.prototype.hasOwnProperty.call(compact.events, 'pendingEventDetails'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(compact.events.scheduledGc, 'orphanedWithPending'), false);
    assert.equal(compact.events.scheduledGc.orphanedWithPendingSubscriptionCount, 1);
    assert.equal(compact.events.scheduledGc.orphanedWithPendingEventCount, 1);
    assert.equal(compact.events.scheduledGc.nextAction, 'reattach_or_explicit_ack');

    const eventSummary = coordinator.eventSubscriptionSummary();
    assert.equal(Object.prototype.hasOwnProperty.call(eventSummary, 'pendingEventDetails'), false);

    const full = coordinator.status();
    assert.equal(full.events.pendingEventDetails.length, 1);
    assert.equal(full.events.scheduledGc.orphanedWithPending[0].id, created.id);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('il riepilogo compatto non materializza ogni subscription persistita', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-compact-summary-'));
  const { broker, coordinator } = makeCoordinator(stateDirectory);
  let publicSubscriptionCalls = 0;
  const publicSubscription = broker.publicSubscription.bind(broker);
  broker.publicSubscription = (...args) => {
    publicSubscriptionCalls += 1;
    return publicSubscription(...args);
  };
  try {
    broker.subscribe({
      agentId: 'compact-summary-agent',
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 9231,
      waitFor: ['merged'],
      ttlSeconds: 3600,
    });
    publicSubscriptionCalls = 0;
    const compact = coordinator.status({ compact: true });
    assert.equal(compact.events.subscriptionCount, 1);
    assert.equal(publicSubscriptionCalls, 0);

    coordinator.eventSubscriptionSummary();
    assert.equal(publicSubscriptionCalls, 0, 'anche events summary deve restare compatto');

    coordinator.status();
    assert.ok(publicSubscriptionCalls > 0, 'il dettaglio esplicito può materializzare le subscription');
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('il primo status dopo un riavvio non avvia GC sincrona e il bootstrap post-listen conserva il backlog', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-restart-gc-'));
  const originalWrite = process.stderr.write;
  const logged = [];
  try {
    const first = makeCoordinator(stateDirectory);
    const created = first.broker.subscribe({
      agentId: 'restarted-agent',
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 9230,
      waitFor: ['merged'],
      ttlSeconds: 36_000,
    });
    const receivedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    first.broker.recordEvent(normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'merged-9230',
      receivedAt,
      payload: {
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 9230, merged: true },
      },
    }));

    // A new coordinator process restores the persisted broker state but has
    // no in-memory scheduled GC report yet.
    const { broker, coordinator } = makeCoordinator(stateDirectory);
    coordinator.setEventListenerInspector(() => false);
    process.stderr.write = (chunk) => { logged.push(String(chunk)); return true; };

    const compact = coordinator.status({ compact: true });
    assert.equal(coordinator.lastScheduledGc, null, 'status non deve avviare la scansione GC');
    assert.equal(compact.events.pendingEvents, 1);
    assert.equal(compact.events.pendingSubscriptionCount, 1);
    assert.equal(compact.events.oldestPendingAt, receivedAt);
    assert.equal(broker.getSubscriptionRecord(created.id).pending.length, 1, 'il probe non deve ackare o rimuovere pending');

    coordinator.ensureScheduledEventGarbageCollection();
    await new Promise((resolve) => {
      const waitForBootstrap = () => {
        if (coordinator.lastScheduledGc) {
          resolve();
          return;
        }
        setImmediate(waitForBootstrap);
      };
      waitForBootstrap();
    });

    const health = eventLifecycleHealth({ scheduledGc: coordinator.lastScheduledGc }, 'test');
    assert.equal(coordinator.lastScheduledGc.orphanedWithPendingSubscriptionCount, 1);
    assert.equal(coordinator.lastScheduledGc.orphanedWithPendingEventCount, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(coordinator.lastScheduledGc, 'orphanedWithPending'), true);
    assert.deepEqual(health.alerts.map(({ code }) => code), ['orphaned_pending_events']);
    assert.equal(health.alerts[0].eventCount, 1);
    assert.equal(health.alerts[0].subscriptionCount, 1);
    assert.ok(logged.some((line) => line.includes('event_gc_orphans_detected')));

    const secondCompact = coordinator.status({ compact: true });
    assert.equal(secondCompact.events.scheduledGc.orphanedWithPendingEventCount, 1);

    const full = coordinator.status();
    assert.equal(full.events.pendingEventDetails.length, 1);
    assert.equal(full.events.scheduledGc.orphanedWithPending.length, 1);
    assert.equal(full.events.scheduledGc.orphanedWithPending[0].id, created.id);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('una GC post-listen a backlog grande cede il loop e non riscrive lo snapshot', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-large-gc-'));
  const { broker, coordinator } = makeCoordinator(stateDirectory);
  try {
    coordinator.setEventListenerInspector(() => false);
    const seed = broker.subscribe({
      agentId: 'large-backlog-seed',
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: 'large-backlog-run',
      waitFor: ['completed'],
      ttlSeconds: 36_000,
      allowDuplicate: true,
    });
    const seedRecord = broker.getSubscriptionRecord(seed.id);
    const receivedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    for (let index = 0; index < 256; index += 1) {
      const copy = structuredClone(seedRecord);
      copy.id = `sub-large-${index}`;
      copy.agentId = `large-agent-${index}`;
      copy.runId = `large-run-${index}`;
      copy.createdAt = receivedAt;
      copy.pending = [{
        id: `event-large-${index}`,
        deliveryId: `delivery-large-${index}`,
        receivedAt,
        state: 'completed',
      }];
      broker.state.subscriptions.push(copy);
    }
    broker.persist();
    const beforeIds = broker.state.subscriptions.map(({ id }) => id);

    let statusTurnYielded = false;
    setImmediate(() => { statusTurnYielded = true; });
    const compact = coordinator.status({ compact: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statusTurnYielded, true);
    assert.equal(coordinator.lastScheduledGc, null, 'status non deve eseguire GC');
    assert.equal(compact.events.pendingEvents, 256);

    let gcTurnYielded = false;
    const gcPromise = coordinator.scheduledEventGarbageCollectionAsync({ batchSize: 8 });
    setImmediate(() => { gcTurnYielded = true; });
    const report = await gcPromise;
    assert.equal(gcTurnYielded, true, 'la scansione deve cedere il loop tra i batch');
    assert.equal(report.orphanedWithPendingSubscriptionCount, 256);
    assert.deepEqual(broker.state.subscriptions.map(({ id }) => id), beforeIds);
    assert.ok(broker.getSubscriptionRecord(seed.id), 'la subscription del run resta presente');
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('lo startup con backlog grande mantiene ping e status del socket reattivi', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-large-socket-');
  // Keep the identity short: macOS caps Unix-domain socket paths at 104 bytes.
  const identity = `lg-${process.pid}`;
  const secret = 'large-socket-secret';
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
    const broker = new GitHubEventBroker({
      stateFile: join(stateDirectory, `github-events-${identity}.json`),
      webhookSecret: secret,
    });
    const seed = broker.subscribe({
      agentId: 'large-socket-seed',
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: 'large-socket-run',
      waitFor: ['completed'],
      ttlSeconds: 36_000,
      allowDuplicate: true,
    });
    const seedRecord = broker.getSubscriptionRecord(seed.id);
    const receivedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    for (let index = 0; index < 512; index += 1) {
      const copy = structuredClone(seedRecord);
      copy.id = `sub-socket-${index}`;
      copy.agentId = `socket-agent-${index}`;
      copy.runId = `socket-run-${index}`;
      copy.createdAt = receivedAt;
      copy.pending = [{
        id: `event-socket-${index}`,
        deliveryId: `delivery-socket-${index}`,
        receivedAt,
        state: 'completed',
      }];
      broker.state.subscriptions.push(copy);
    }
    broker.persist();

    const firstPingAt = Date.now();
    const firstPing = await ensureCoordinator(identity);
    assert.equal(firstPing.status.identity, identity);
    assert.ok(Date.now() - firstPingAt < 5_000, 'il ping iniziale non deve attendere il GC');

    const [statusResponse, livenessResponse] = await Promise.all([
      sendRequest({ type: 'status', compact: true }, { identity }),
      sendRequest({ type: 'ping', compact: true }, { identity }),
    ]);
    assert.equal(statusResponse.status.events.pendingEvents, 512);
    assert.equal(statusResponse.status.events.pendingSubscriptionCount, 512);
    assert.equal(livenessResponse.status.identity, identity);
  } finally {
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity);
    } catch {
      // The assertions above are the diagnostic; cleanup is best effort.
    }
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('il daemon accetta un webhook firmato con caratteri multibyte spezzati sul socket', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-utf8-');
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  const identity = `utf8-split-${process.pid}`;
  const secret = 'utf8-split-secret';
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = secret;
  try {
    await ensureCoordinator(identity);
    await subscribeToEvents({
      agentId: 'utf8', repo: 'owner/repo', resource: 'pull_request', number: 77, waitFor: ['merged'], ttlSeconds: 60,
    }, { identity });
    const rawBody = JSON.stringify({
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 77, merged: true, body: 'Perché è già mergiata 🔴', head: { sha: 'abc' } },
    });
    const signature = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
    const line = Buffer.from(`${JSON.stringify({
      type: 'events-webhook', eventName: 'pull_request', deliveryId: 'utf8-split', signature, rawBody,
    })}\n`, 'utf8');
    const cut = line.indexOf(Buffer.from('è', 'utf8')) + 1;
    const response = await new Promise((resolvePromise, rejectPromise) => {
      const socket = createConnection(socketPath(identity));
      let buffer = '';
      const timer = setTimeout(() => { socket.destroy(); rejectPromise(new Error('timeout')); }, 5_000);
      socket.on('connect', () => {
        socket.write(line.subarray(0, cut));
        setTimeout(() => socket.write(line.subarray(cut)), 50);
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        socket.end();
        resolvePromise(JSON.parse(buffer.slice(0, newline)));
      });
      socket.on('error', rejectPromise);
    });
    assert.equal(response.ok, true, JSON.stringify(response.error || {}));
    assert.equal(response.matchedSubscriptionIds.length, 1);
  } finally {
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity, 5_000);
    } catch {
      // cleanup best effort
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('una lettura lenta del token viene ritentata invece di far morire il daemon', async () => {
  const { resolveToken } = await import('../bin/github-coordinator.mjs');
  const saved = { FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  delete process.env.FRONTALIERE_GH_TOKEN; delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  try {
    let calls = 0;
    const token = resolveToken('default', '/bin/false', {
      exec: (_bin, _args, options) => {
        calls += 1;
        assert.equal(options.timeout, 30_000);
        if (calls < 3) throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return 'token-value\n';
      },
    });
    assert.equal(token, 'token-value');
    assert.equal(calls, 3);
    assert.throws(() => resolveToken('default', '/bin/false', { exec: () => { throw new Error('x'); } }),
      /github_token_unavailable_for_identity: default/);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
});
