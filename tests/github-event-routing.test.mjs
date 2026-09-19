import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubCoordinator } from '../bin/github-coordinator.mjs';
import { GitHubEventBroker } from '../bin/github-event-broker.mjs';
import { normalizeIdentity } from '../bin/github-coordinator-client.mjs';
import {
  assertEventIdentity,
  loadEventRouting,
} from '../bin/github-event-routing.mjs';

const SITE_REPO = 'valerielinc-ops/frontaliere-si-o-no';
const CORPUS_REPO = 'nanakokyobashi-rgb/frontaliere-articles';

function fakeResponse(body) {
  return {
    status: 200,
    ok: true,
    headers: { get() { return '100'; } },
    async text() { return JSON.stringify(body); },
  };
}

function signedWebhook(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function coordinatorFixture({ identity, stateDirectory, fetchImpl, webhookSecret = 'routing-test-secret' }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret,
  });
  const coordinator = new GitHubCoordinator({
    identity,
    token: 'routing-test-token',
    realGh: '/bin/echo',
    socket: join(stateDirectory, `coordinator-${identity}.sock`),
    eventBroker: broker,
  });
  return { broker, coordinator, restoreFetch: () => { globalThis.fetch = originalFetch; } };
}

test('la configurazione versionata espone solo le route production attese', () => {
  const routing = loadEventRouting();
  assert.equal(routing.version, 1);
  assert.equal(routing.routes.get(SITE_REPO), 'default');
  assert.equal(routing.routes.get(CORPUS_REPO), 'nanako');
  assert.equal(routing.routes.size, 2);
});

test('canonicalizza le identità prima della selezione del coordinatore', () => {
  assert.equal(normalizeIdentity('DEFAULT'), 'default');
  assert.equal(normalizeIdentity(' default '), 'default');
  assert.equal(normalizeIdentity('nanako\n'), 'nanako');
  assert.equal(normalizeIdentity('worker-test'), 'worker-test');
  assert.throws(
    () => assertEventIdentity({
      spec: { repo: SITE_REPO },
      actualIdentity: 'worker-test',
    }),
    (error) => error.code === 'event_identity_mismatch'
      && error.actualIdentity === 'worker-test'
      && error.expectedIdentity === 'default'
      && error.exitCode === 2,
  );
});

test('canonicalizza anche le identità dichiarate nella configurazione di routing', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-config-'));
  const configPath = join(stateDirectory, 'routing.json');
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    routes: { [CORPUS_REPO]: 'NaNaKo' },
  }));
  try {
    const routing = loadEventRouting(configPath);
    assert.equal(routing.routes.get(CORPUS_REPO), 'nanako');
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('rifiuta il corpus sul coordinatore default prima di fetch, subscribe e persist', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-mismatch-'));
  const stateFile = join(stateDirectory, 'events.json');
  let fetchCalls = 0;
  const { broker, coordinator, restoreFetch } = coordinatorFixture({
    identity: 'DEFAULT ',
    stateDirectory,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not be reached');
    },
  });

  try {
    await assert.rejects(
      () => coordinator.eventSubscription({
        repo: CORPUS_REPO,
        resource: 'workflow_run',
        runId: '1595',
        waitFor: ['failed'],
        ttlSeconds: 60,
      }),
      (error) => {
        assert.equal(error.code, 'event_identity_mismatch');
        assert.equal(error.repo, CORPUS_REPO);
        assert.equal(error.actualIdentity, 'default');
        assert.equal(error.expectedIdentity, 'nanako');
        assert.equal(error.exitCode, 2);
        assert.match(error.nextAction, /--identity.*nanako/);
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(broker.state.subscriptions.length, 0);
    assert.equal(existsSync(stateFile), false);
  } finally {
    restoreFetch();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('identità sconosciute non possono usare route production mappate', async () => {
  for (const identity of ['worker-test', 'nanakoo']) {
    const stateDirectory = mkdtempSync(join(tmpdir(), `frontaliere-event-routing-unknown-${identity}-`));
    const stateFile = join(stateDirectory, 'events.json');
    let fetchCalls = 0;
    const { broker, coordinator, restoreFetch } = coordinatorFixture({
      identity,
      stateDirectory,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('fetch must not be reached');
      },
    });

    try {
      await assert.rejects(
        () => coordinator.eventSubscription({
          repo: CORPUS_REPO,
          resource: 'workflow_run',
          runId: '1595',
          waitFor: ['failed'],
          ttlSeconds: 60,
        }),
        (error) => {
          assert.equal(error.code, 'event_identity_mismatch');
          assert.equal(error.repo, CORPUS_REPO);
          assert.equal(error.actualIdentity, identity);
          assert.equal(error.expectedIdentity, 'nanako');
          assert.equal(error.exitCode, 2);
          assert.match(error.nextAction, /--identity.*nanako/);
          return true;
        },
      );
      assert.equal(fetchCalls, 0);
      assert.equal(broker.state.subscriptions.length, 0);
      assert.equal(existsSync(stateFile), false);
    } finally {
      restoreFetch();
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  }
});

test('rifiuta una route sconosciuta in modo fail-closed prima di fetch, subscribe e persist', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-missing-'));
  const stateFile = join(stateDirectory, 'events.json');
  let fetchCalls = 0;
  const { broker, coordinator, restoreFetch } = coordinatorFixture({
    identity: 'default\n',
    stateDirectory,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not be reached');
    },
  });

  try {
    await assert.rejects(
      () => coordinator.eventSubscription({
        repo: 'unknown-owner/unknown-repo',
        resource: 'pull_request',
        number: 42,
        waitFor: ['merged'],
        ttlSeconds: 60,
      }),
      (error) => {
        assert.equal(error.code, 'event_identity_route_missing');
        assert.equal(error.repo, 'unknown-owner/unknown-repo');
        assert.equal(error.actualIdentity, 'default');
        assert.equal(error.expectedIdentity, null);
        assert.equal(error.exitCode, 2);
        assert.match(error.nextAction, /config\/github-event-routing\.json/);
        assert.match(error.nextAction, /nessun autoroute/);
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(broker.state.subscriptions.length, 0);
    assert.equal(existsSync(stateFile), false);
  } finally {
    restoreFetch();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('accetta una subscription corpus sul coordinatore nanako e riconcilia via fixture', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-corpus-'));
  const calls = [];
  const { broker, coordinator, restoreFetch } = coordinatorFixture({
    identity: 'nanako\n',
    stateDirectory,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return fakeResponse({
        id: 1595,
        status: 'completed',
        conclusion: 'failure',
        head_branch: 'main',
        updated_at: '2026-09-19T10:12:57Z',
      });
    },
  });

  try {
    const result = await coordinator.eventSubscription({
      repo: CORPUS_REPO,
      resource: 'workflow_run',
      runId: '1595',
      waitFor: ['failed'],
      ttlSeconds: 60,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /repos\/nanakokyobashi-rgb\/frontaliere-articles\/actions\/runs\/1595$/);
    assert.equal(broker.state.subscriptions.length, 1);
  } finally {
    restoreFetch();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('accetta una subscription sito sul coordinatore default e riconcilia via fixture', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-site-'));
  const calls = [];
  const { broker, coordinator, restoreFetch } = coordinatorFixture({
    identity: 'DEFAULT',
    stateDirectory,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return fakeResponse({
        number: 9215,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-19T10:12:57Z',
        updated_at: '2026-09-19T10:12:57Z',
        head: { sha: 'routing-site-head' },
      });
    },
  });

  try {
    const result = await coordinator.eventSubscription({
      repo: SITE_REPO,
      resource: 'pull_request',
      number: 9215,
      waitFor: ['merged'],
      ttlSeconds: 60,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /repos\/valerielinc-ops\/frontaliere-si-o-no\/pulls\/9215$/);
    assert.equal(broker.state.subscriptions.length, 1);
  } finally {
    restoreFetch();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('blocca reconcile sul coordinatore default prima di REST per una subscription corpus già presente', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-reconcile-'));
  let fetchCalls = 0;
  const { broker, coordinator, restoreFetch } = coordinatorFixture({
    identity: 'default',
    stateDirectory,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not be reached');
    },
  });
  const subscription = broker.subscribe({
    repo: CORPUS_REPO,
    resource: 'workflow_run',
    runId: '1595',
    waitFor: ['failed'],
    ttlSeconds: 60,
  });

  try {
    await assert.rejects(
      () => coordinator.reconcileEvents(subscription.id),
      (error) => {
        assert.equal(error.code, 'event_identity_mismatch');
        assert.equal(error.repo, CORPUS_REPO);
        assert.equal(error.actualIdentity, 'default');
        assert.equal(error.expectedIdentity, 'nanako');
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(broker.state.subscriptions.length, 1);
  } finally {
    restoreFetch();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('rifiuta webhook con route mismatch o sconosciuta dopo la firma, senza pending o audit', () => {
  const cases = [
    {
      name: 'mismatch',
      identity: 'DEFAULT',
      subscriptionRepo: CORPUS_REPO,
      payloadRepo: CORPUS_REPO,
      code: 'event_identity_mismatch',
      expectedIdentity: 'nanako',
    },
    {
      name: 'route mancante',
      identity: 'nanako\n',
      subscriptionRepo: CORPUS_REPO,
      payloadRepo: 'unknown-owner/unknown-repo',
      code: 'event_identity_route_missing',
      expectedIdentity: null,
    },
    {
      name: 'identità worker non configurata',
      identity: 'worker-test',
      subscriptionRepo: CORPUS_REPO,
      payloadRepo: CORPUS_REPO,
      code: 'event_identity_mismatch',
      expectedIdentity: 'nanako',
    },
    {
      name: 'identità nanakoo non configurata',
      identity: 'nanakoo',
      subscriptionRepo: CORPUS_REPO,
      payloadRepo: CORPUS_REPO,
      code: 'event_identity_mismatch',
      expectedIdentity: 'nanako',
    },
  ];

  for (const scenario of cases) {
    const stateDirectory = mkdtempSync(join(tmpdir(), `frontaliere-event-routing-webhook-${scenario.name}-`));
    const secret = 'routing-webhook-secret';
    const { broker, coordinator, restoreFetch } = coordinatorFixture({
      identity: scenario.identity,
      stateDirectory,
      fetchImpl: async () => { throw new Error('webhook guard must not fetch'); },
      webhookSecret: secret,
    });
    const subscription = broker.subscribe({
      repo: scenario.subscriptionRepo,
      resource: 'pull_request',
      number: 42,
      waitFor: ['merged'],
      ttlSeconds: 60,
    });
    const payload = {
      action: 'closed',
      repository: { full_name: scenario.payloadRepo },
      pull_request: { number: 42, merged: true, head: { sha: 'routing-webhook-head' } },
    };
    const rawBody = JSON.stringify(payload);
    const before = {
      seen: broker.state.seenDeliveries.length,
      audit: broker.state.eventAudit.length,
      pending: broker.pendingEvent(subscription.id),
    };

    try {
      assert.throws(
        () => coordinator.ingestWebhook({
          eventName: 'pull_request',
          deliveryId: `routing-${scenario.name}`,
          signature: signedWebhook(rawBody, secret),
          rawBody,
        }),
        (error) => {
          assert.equal(error.code, scenario.code);
          assert.equal(error.repo, scenario.payloadRepo);
          assert.equal(error.actualIdentity, normalizeIdentity(scenario.identity));
          assert.equal(error.expectedIdentity, scenario.expectedIdentity);
          assert.equal(error.exitCode, 2);
          assert.ok(error.nextAction);
          return true;
        },
      );
      assert.deepEqual({
        seen: broker.state.seenDeliveries.length,
        audit: broker.state.eventAudit.length,
        pending: broker.pendingEvent(subscription.id),
      }, before);
      assert.equal(broker.audit({}).events.length, 0);
    } finally {
      restoreFetch();
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  }
});

test('usa il payload firmato quando il caller passa un payload in conflitto', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-webhook-conflict-'));
  const secret = 'routing-conflict-secret';
  const { broker, coordinator, restoreFetch } = coordinatorFixture({
    identity: 'default',
    stateDirectory,
    fetchImpl: async () => { throw new Error('signed payload guard must not fetch'); },
    webhookSecret: secret,
  });
  const subscription = broker.subscribe({
    repo: SITE_REPO,
    resource: 'pull_request',
    number: 42,
    waitFor: ['merged'],
    ttlSeconds: 60,
  });
  const signedPayload = {
    action: 'closed',
    repository: { full_name: CORPUS_REPO },
    pull_request: { number: 42, merged: true, head: { sha: 'routing-conflict-head' } },
  };
  const conflictingPayload = {
    ...signedPayload,
    repository: { full_name: SITE_REPO },
  };
  const rawBody = JSON.stringify(signedPayload);
  const before = {
    seen: broker.state.seenDeliveries.length,
    audit: broker.state.eventAudit.length,
    pending: broker.pendingEvent(subscription.id),
  };

  try {
    assert.throws(
      () => coordinator.ingestWebhook({
        eventName: 'pull_request',
        deliveryId: 'routing-signed-corpus-conflicting-site',
        signature: signedWebhook(rawBody, secret),
        rawBody,
        payload: conflictingPayload,
      }),
      (error) => error.code === 'event_identity_mismatch'
        && error.repo === CORPUS_REPO
        && error.actualIdentity === 'default'
        && error.expectedIdentity === 'nanako'
        && error.exitCode === 2,
    );
    assert.deepEqual({
      seen: broker.state.seenDeliveries.length,
      audit: broker.state.eventAudit.length,
      pending: broker.pendingEvent(subscription.id),
    }, before);
    assert.equal(broker.audit({}).events.length, 0);
  } finally {
    restoreFetch();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('verifica la firma prima del preflight di routing webhook', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-event-routing-webhook-signature-'));
  const secret = 'routing-signature-secret';
  const { broker, coordinator, restoreFetch } = coordinatorFixture({
    identity: 'default',
    stateDirectory,
    fetchImpl: async () => { throw new Error('webhook guard must not fetch'); },
    webhookSecret: secret,
  });
  const rawBody = JSON.stringify({
    action: 'closed',
    repository: { full_name: CORPUS_REPO },
    pull_request: { number: 42, merged: true },
  });

  try {
    assert.throws(
      () => coordinator.ingestWebhook({
        eventName: 'pull_request',
        deliveryId: 'routing-invalid-signature',
        signature: 'sha256=invalid',
        rawBody,
      }),
      (error) => error.code === 'event_webhook_signature_invalid',
    );
    assert.equal(broker.state.seenDeliveries.length, 0);
    assert.equal(broker.state.eventAudit.length, 0);
  } finally {
    restoreFetch();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
