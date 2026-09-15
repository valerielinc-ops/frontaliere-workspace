import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import {
  classifyBucket,
  cancellationRequestDetails,
  GitHubCoordinator,
  isSafeRead,
  parseGhApiArguments,
  retryDelayMilliseconds,
} from '../bin/github-coordinator.mjs';
import {
  ensureCoordinator,
  eventSubscriptions,
  listenForEvent,
  normalizeIdentity,
  sendRequest,
  socketPath,
  subscribeToEvents,
  waitForCoordinatorStop,
} from '../bin/github-coordinator-client.mjs';
import {
  GitHubEventBroker,
  eventMatchesSubscription,
  MAX_SUBSCRIPTION_TTL_MS,
  normalizeWebhookEvent,
  normalizeReconciliationEvent,
  verifyWebhookSignature,
} from '../bin/github-event-broker.mjs';
import { createGitHubWebhookReceiver } from '../bin/github-webhook-receiver.mjs';

const ROOT = join(import.meta.dirname, '..');
const POLICY = join(ROOT, 'bin', 'github-api-policy.mjs');

function signedWebhook(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function runPolicy(command) {
  return spawnSync(process.execPath, [POLICY], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKSPACE: ROOT,
      PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH}`,
    },
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
}

function fakeResponse(status, body, headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return normalized[String(name).toLowerCase()] ?? null; } },
    async text() { return body; },
  };
}

test('classifica i bucket GitHub senza confondere search e GraphQL', () => {
  assert.equal(classifyBucket('/graphql'), 'graphql');
  assert.equal(classifyBucket('/search/issues'), 'search');
  assert.equal(classifyBucket('/search/code'), 'code_search');
  assert.equal(classifyBucket('/repos/o/r/pulls'), 'core');
  assert.equal(classifyBucket('/repos/o/r/issues', 'POST'), 'core-write');
});

test('considera sicure solo le letture', () => {
  assert.equal(isSafeRead('GET'), true);
  assert.equal(isSafeRead('HEAD'), true);
  assert.equal(isSafeRead('POST'), false);
  assert.equal(isSafeRead('PATCH'), false);
});

test('sospende ogni cancellazione Actions fino alla conferma separata del proprietario', async () => {
  assert.deepEqual(
    cancellationRequestDetails({
      type: 'api',
      method: 'POST',
      path: '/repos/owner/repo/actions/runs/123/cancel',
    }),
    {
      kind: 'workflow-run-cancellation',
      repo: 'owner/repo',
      runId: '123',
      target: '/repos/owner/repo/actions/runs/123/cancel',
    },
  );
  assert.equal(cancellationRequestDetails({
    type: 'api', method: 'GET', path: '/repos/owner/repo/actions/runs/123/cancel',
  }), null);
  assert.equal(cancellationRequestDetails({
    type: 'exec', args: ['--repo', 'owner/repo', 'run', 'cancel', '123'],
  }).runId, '123');
  assert.equal(cancellationRequestDetails({
    type: 'exec',
    args: [
      'api', '--method', 'POST', '--input', 'payload.json',
      '--repo', 'owner/repo', 'actions/runs/123/cancel',
    ],
  }).target, '/repos/owner/repo/actions/runs/123/cancel');
  assert.equal(cancellationRequestDetails({
    type: 'exec',
    args: ['--repo', 'owner/repo', 'api', '--method', 'POST', 'actions/runs/123/cancel'],
  }).target, '/repos/owner/repo/actions/runs/123/cancel');

  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });
  const blocked = await coordinator.submit({
    type: 'exec',
    identity: 'test',
    args: ['run', 'cancel', '123', '--repo', 'owner/repo'],
    cwd: '/tmp',
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.error.code, 'owner_confirmation_required');
  assert.match(blocked.stderr, /owner_command=bin\/gh-frontaliere confirm-cancel cancel-/);
  assert.equal(coordinator.metrics.cliCommands, 0);
  assert.equal(coordinator.status().pendingCancellations.length, 1);

  const requestId = blocked.error.requestId;
  const invalid = await coordinator.confirmCancellation(requestId, 'NO');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'owner_confirmation_invalid');
  assert.equal(coordinator.status().pendingCancellations.length, 1);

  const confirmed = await coordinator.confirmCancellation(requestId, `CONFERMA ${requestId}`);
  assert.equal(confirmed.ok, true);
  assert.match(confirmed.stdout, /run cancel 123 --repo owner\/repo/);
  assert.equal(coordinator.status().pendingCancellations.length, 0);
  assert.equal(coordinator.metrics.cancellationConfirmed, 1);
});

test('conserva le subscription webhook, deduplica le delivery e consegna gli stati PR', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-'));
  const stateFile = join(stateDirectory, 'events.json');
  const secret = 'webhook-secret-for-test';
  const payload = {
    action: 'closed',
    repository: { full_name: 'owner/repo' },
    pull_request: {
      number: 42,
      merged: true,
      html_url: 'https://github.com/owner/repo/pull/42',
      head: { sha: 'abc123' },
    },
  };
  const body = JSON.stringify(payload);

  try {
    const broker = new GitHubEventBroker({ stateFile, webhookSecret: secret });
    const subscription = broker.subscribe({
      agentId: 'agent-test',
      repo: 'owner/repo',
      resource: 'pr',
      number: 42,
      waitFor: ['merged'],
      ttlSeconds: 60,
    });
    const first = broker.ingestWebhook({
      eventName: 'pull_request',
      deliveryId: 'delivery-42',
      signature: signedWebhook(body, secret),
      rawBody: body,
    });
    assert.equal(first.duplicate, false);
    assert.deepEqual(first.matchedSubscriptionIds, [subscription.id]);
    assert.equal(broker.pendingEvent(subscription.id).state, 'merged');

    const duplicate = broker.ingestWebhook({
      eventName: 'pull_request',
      deliveryId: 'delivery-42',
      signature: signedWebhook(body, secret),
      rawBody: body,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(broker.status().pendingEvents, 1);

    const restored = new GitHubEventBroker({ stateFile, webhookSecret: secret });
    assert.equal(restored.getSubscription(subscription.id).pendingEvents, 1);
    assert.equal(restored.acknowledge(subscription.id, 'delivery-42').ok, true);
    assert.equal(restored.status().pendingEvents, 0);
    assert.equal(verifyWebhookSignature(body, 'sha256=bad', secret), false);

    const bounded = broker.subscribe({
      repo: 'owner/other-repo',
      resource: 'workflow_run',
      runId: 9001,
      waitFor: ['success'],
      expiresAt: new Date(Date.now() + (MAX_SUBSCRIPTION_TTL_MS * 2)).toISOString(),
    });
    assert.ok(Date.parse(bounded.expiresAt) - Date.now() <= MAX_SUBSCRIPTION_TTL_MS + 1_000);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('collega il fallimento di un workflow alla PR associata senza polling dell agent', () => {
  const event = normalizeWebhookEvent({
    eventName: 'workflow_run',
    deliveryId: 'workflow-delivery-1',
    payload: {
      action: 'completed',
      repository: { full_name: 'owner/repo' },
      workflow_run: {
        id: 9001,
        name: 'CI',
        conclusion: 'failure',
        head_sha: 'deadbeef',
        pull_requests: [{ number: 42 }],
      },
    },
  });
  const subscription = {
    repo: 'owner/repo',
    resource: 'pull_request',
    number: 42,
    runId: null,
    sha: null,
    environment: null,
    workflow: null,
    waitFor: ['failed'],
  };
  assert.equal(event.state, 'failed');
  assert.equal(event.resources.includes('pull_request'), true);
  assert.equal(eventMatchesSubscription(event, subscription), true);

  const neutralEvent = normalizeWebhookEvent({
    eventName: 'workflow_run',
    deliveryId: 'workflow-delivery-neutral',
    payload: {
      action: 'completed',
      repository: { full_name: 'owner/repo' },
      workflow_run: { id: 9002, conclusion: 'neutral', head_sha: 'deadbeef' },
    },
  });
  assert.equal(neutralEvent.state, 'neutral');
});

test('la riconciliazione resta nel coordinatore e recupera uno stato workflow senza listener polling', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-reconcile-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse(200, JSON.stringify({
    id: 9001,
    name: 'CI',
    status: 'completed',
    conclusion: 'failure',
    head_sha: 'deadbeef',
    updated_at: '2026-09-15T12:00:00Z',
  }), { 'x-ratelimit-remaining': '100' });
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret: 'secret',
  });
  const subscription = broker.subscribe({
    repo: 'owner/repo',
    resource: 'workflow_run',
    runId: '9001',
    waitFor: ['failed'],
    ttlSeconds: 60,
  });
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
    eventBroker: broker,
  });

  try {
    const result = await coordinator.reconcileEvents(subscription.id);
    assert.deepEqual(result.matchedSubscriptionIds, [subscription.id]);
    assert.equal(broker.pendingEvent(subscription.id).state, 'failed');
    const normalized = normalizeReconciliationEvent({
      subscription: broker.getSubscriptionRecord(subscription.id),
      data: { id: 9001, status: 'completed', conclusion: 'failure', updated_at: 'v2' },
    });
    assert.equal(normalized.state, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('intercetta il sottoinsieme comune di gh api mantenendo jq e paginazione', () => {
  const parsed = parseGhApiArguments([
    'api', 'repos/octocat/Hello-World', '--jq', '.full_name', '--paginate', '--slurp',
  ]);
  assert.deepEqual(
    {
      path: parsed.path,
      method: parsed.method,
      jq: parsed.jq,
      paginate: parsed.paginate,
      slurp: parsed.slurp,
    },
    {
      path: '/repos/octocat/Hello-World',
      method: 'GET',
      jq: '.full_name',
      paginate: true,
      slurp: true,
    },
  );
  assert.equal(parseGhApiArguments(['api', '--input', 'payload.json', 'repos/o/r']), null);
});

test('rispetta retry-after e reset prima del backoff euristico', () => {
  assert.equal(retryDelayMilliseconds({ headers: { 'retry-after': '7' }, attempt: 1 }), 7_000);
  const now = 1_700_000_000_000;
  assert.equal(
    retryDelayMilliseconds({
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000010' },
      now,
      attempt: 1,
    }),
    10_250,
  );
});

test('normalizza identità e isola i socket per profilo', () => {
  assert.equal(normalizeIdentity('default'), 'default');
  assert.equal(normalizeIdentity('nanako'), 'nanako');
  assert.notEqual(socketPath('default'), socketPath('nanako'));
  assert.throws(() => normalizeIdentity('nanako/escape'), /invalid_github_identity/);
});

test('adatta la concorrenza delle letture al margine del rate limit', () => {
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: process.execPath,
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });

  assert.equal(coordinator.effectiveMaxInFlight(), 8);
  coordinator.buckets.set('core', { remaining: '1200', limit: '5000' });
  assert.equal(coordinator.effectiveMaxInFlight(), 6);
  coordinator.buckets.set('core', { remaining: '700', limit: '5000' });
  assert.equal(coordinator.effectiveMaxInFlight(), 4);
  coordinator.buckets.set('core', { remaining: '100', limit: '5000' });
  assert.equal(coordinator.effectiveMaxInFlight(), 2);
  coordinator.buckets.set('core', { remaining: '0', limit: '5000' });
  assert.equal(coordinator.effectiveMaxInFlight(), 1);
});

test('usa la corsia anonima solo come fallback per una lettura REST pubblica esaurita', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return fakeResponse(403, '{"message":"API rate limit exceeded"}', {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.ceil(Date.now() / 1_000) + 60),
        'x-ratelimit-resource': 'core',
      });
    }
    return fakeResponse(200, '{"full_name":"o/r"}', {
      'x-ratelimit-remaining': '59',
      'x-ratelimit-resource': 'core',
    });
  };
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: process.execPath,
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });

  try {
    const response = await coordinator.submit({
      type: 'api',
      identity: 'test',
      method: 'GET',
      path: '/repos/o/r',
    });
    assert.equal(response.ok, true);
    assert.equal(response.headers['x-frontaliere-auth-mode'], 'anonymous');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.authorization, 'Bearer secret-for-test');
    assert.equal(calls[1].options.headers.authorization, undefined);
    assert.equal(coordinator.metrics.anonymousFallbacks, 1);
    assert.equal(coordinator.metrics.anonymousRequests, 1);
    assert.equal(coordinator.status().anonymous.used, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('instrada in anonimo le richieste successive mentre il bucket autenticato è esaurito', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return fakeResponse(200, '{"full_name":"o/r"}', {
      'x-ratelimit-remaining': '59',
      'x-ratelimit-resource': 'core',
    });
  };
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: process.execPath,
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });
  coordinator.buckets.set('core', { remaining: '0' });

  try {
    const response = await coordinator.submit({
      type: 'exec',
      identity: 'test',
      args: ['api', 'repos/o/r', '--jq', '.full_name'],
      cwd: '/tmp',
    });
    assert.equal(response.ok, true);
    assert.equal(response.stdout, 'o/r\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.authorization, undefined);
    assert.equal(coordinator.metrics.anonymousFallbacks, 0);
    assert.equal(coordinator.metrics.anonymousRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non usa la corsia anonima per mutation o percorsi non pubblici', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length > 1) {
      return fakeResponse(200, '{"login":"owner"}', {
        'x-ratelimit-remaining': '59',
        'x-ratelimit-resource': 'core',
      });
    }
    return fakeResponse(403, '{"message":"API rate limit exceeded"}', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(Date.now() / 1_000) + 60),
      'x-ratelimit-resource': 'core',
    });
  };
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: process.execPath,
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });

  try {
    const mutation = await coordinator.submit({
      type: 'api', identity: 'test', method: 'POST', path: '/repos/o/r/issues', body: '{}',
    });
    coordinator.bucketPausedUntil.clear();
    const privatePath = await coordinator.submit({
      type: 'api', identity: 'test', method: 'GET', path: '/user',
    });
    assert.equal(mutation.rateLimited, true);
    assert.equal(privatePath.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls.every(({ options }) => options.headers.authorization === 'Bearer secret-for-test'), true);
    assert.equal(coordinator.metrics.anonymousRequests, 0);
    assert.equal(coordinator.metrics.anonymousFallbacks, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('il policy gate permette il gh shim e blocca bypass espliciti', () => {
  assert.equal(runPolicy('gh pr view 123 --repo owner/repo').status, 0);
  assert.equal(runPolicy('bin/gh-frontaliere pr view 123').status, 0);
  assert.equal(runPolicy('/opt/homebrew/bin/gh pr view 123').status, 2);
  assert.equal(runPolicy('curl https://api.github.com/rate_limit').status, 2);
  assert.equal(runPolicy('gh pr checks 123 --watch').status, 2);
  assert.equal(runPolicy('gh pr view 123; curl https://api.github.com/rate_limit').status, 2);
  assert.equal(runPolicy('echo github-coordinator; /opt/homebrew/bin/gh pr view 123').status, 2);
});

test('consegna un webhook al listener Unix e chiude la subscription dopo ack', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-event-');
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  const identity = 'event-integration';
  const secret = 'event-integration-secret';
  let receiver;

  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = secret;

  try {
    await ensureCoordinator(identity);
    const subscriptionResponse = await subscribeToEvents({
      agentId: 'agent-integration',
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 42,
      waitFor: ['merged'],
      ttlSeconds: 60,
    }, { identity });
    const subscriptionId = subscriptionResponse.subscription.id;
    const eventPromise = listenForEvent(subscriptionId, { identity, timeoutMs: 5_000 });

    receiver = createGitHubWebhookReceiver({ identity });
    await new Promise((resolvePromise, rejectPromise) => {
      receiver.once('error', rejectPromise);
      receiver.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = receiver.address();
    const payload = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 42, merged: true, head: { sha: 'abc123' } },
    };
    const body = JSON.stringify(payload);
    const rejectedWebhookResponse = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'integration-delivery-invalid',
        'x-hub-signature-256': 'sha256=invalid',
      },
      body,
    });
    assert.equal(rejectedWebhookResponse.status, 401);
    const webhookResponse = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'integration-delivery-42',
        'x-hub-signature-256': signedWebhook(body, secret),
      },
      body,
    });
    assert.equal(webhookResponse.status, 202);
    const webhookResult = await webhookResponse.json();
    assert.deepEqual(webhookResult.matchedSubscriptionIds, [subscriptionId]);

    const event = await eventPromise;
    assert.equal(event.state, 'merged');
    assert.equal(event.number, 42);
    const status = await eventSubscriptions({ identity });
    assert.equal(status.pendingEvents, 0);
    assert.equal(status.subscriptions.length, 0);
  } finally {
    if (receiver) await new Promise((resolvePromise) => receiver.close(resolvePromise));
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity, 5_000);
    } catch {
      // The daemon may not have started if setup failed; cleanup remains safe.
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
