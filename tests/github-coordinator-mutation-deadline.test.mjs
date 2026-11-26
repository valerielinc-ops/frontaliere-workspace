import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { GitHubCoordinator } from '../bin/github-coordinator.mjs';

const mutation = { type: 'api', method: 'POST', path: '/repos/example/project/issues' };
const invalid = 'coordinator_mutation_deadline_invalid';
const exceeded = 'coordinator_mutation_deadline_exceeded';

function mockClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
}

function coordinator(t, fetchStub) {
  t.mock.method(globalThis, 'fetch', fetchStub);
  return new GitHubCoordinator({ identity: 'default', token: 'test-token' });
}

function assertError(response, status, code) {
  assert.equal(response.ok, false);
  assert.equal(response.status, status);
  assert.deepEqual(response.headers, {});
  assert.equal(response.body, '');
  assert.equal(response.error.status, status);
  assert.equal(response.error.code, code);
  assert.equal(response.error.message, status === 408
    ? 'Coordinator mutation deadline exceeded'
    : 'Invalid coordinator mutation deadline');
}

test('advertises support in both status views', (t) => {
  const service = coordinator(t, () => assert.fail('unexpected fetch'));
  assert.equal(service.status().mutationDeadlineSupported, true);
  assert.equal(service.status({ compact: true }).mutationDeadlineSupported, true);
});

test('validates deadline type, range and mutation scope before admission', async (t) => {
  mockClock(t);
  const service = coordinator(t, () => assert.fail('unexpected fetch'));
  const now = Date.now();
  for (const value of [undefined, null, true, '123', 0, -1, 1.5, Infinity, 2 ** 53, now + 130_000]) {
    assertError(await service.submit({ ...mutation, mutationDeadlineAtMs: value }), 400, invalid);
  }
  const future = now + 10_000;
  for (const request of [
    { ...mutation, method: 'GET' },
    { ...mutation, path: '/graphql', body: { query: 'query { viewer { login } }' } },
    { type: 'exec', args: ['issue', 'create'] },
  ]) {
    assertError(await service.submit({ ...request, mutationDeadlineAtMs: future }), 400, invalid);
  }
  assertError(await service.submit({ ...mutation, mutationDeadlineAtMs: now }), 408, exceeded);
  assert.equal(service.status().queueLength, 0);
});

test('owner policies take precedence over deadline validation', async (t) => {
  const service = coordinator(t, () => assert.fail('unexpected fetch'));
  for (const [method, path, code] of [
    ['POST', '/repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/deploy.yml/dispatches', 'deploy_dispatch_blocked'],
    ['PUT', '/repos/valerielinc-ops/frontaliere-si-o-no/pulls/1/update-branch', 'update_branch_blocked'],
    ['POST', '/repos/example/project/actions/runs/1/cancel', 'owner_confirmation_required'],
    ['PUT', '/repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/send-daily-brief.yml/enable', 'daily_brief_workflow_enable_owner_confirmation_required'],
  ]) {
    const result = await service.submit({ ...mutation, method, path, mutationDeadlineAtMs: null });
    assert.equal(result.error?.code, code);
  }
});

test('expires only the queued mutation while another mutation holds the lane', { timeout: 5_000 }, async (t) => {
  mockClock(t);
  const firstResponse = Promise.withResolvers();
  const firstStarted = Promise.withResolvers();
  const service = coordinator(t, () => {
    if (fetch.mock.callCount() > 0) return new Response(null, { status: 201 });
    firstStarted.resolve();
    return firstResponse.promise;
  });
  const active = service.submit(mutation);
  await firstStarted.promise;
  const expired = service.submit({ ...mutation, mutationDeadlineAtMs: Date.now() + 50 });
  const queued = service.submit(mutation);
  assert.equal(service.status().queueLength, 2);
  try {
    t.mock.timers.tick(50);
    assertError(await expired, 408, exceeded);
    assert.equal(service.status().queueLength, 1);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    firstResponse.resolve(new Response(null, { status: 201 }));
    await active;
  }
  await nextTurn(); // Let the scheduler release the lane and arm its wake timer.
  t.mock.timers.tick(950);
  assert.equal((await queued).status, 201);
  assert.equal(fetch.mock.callCount(), 2);
});

test('checks the absolute deadline after extraction and before dispatch', async (t) => {
  mockClock(t);
  const service = coordinator(t, () => assert.fail('unexpected fetch'));
  const result = service.submit({ ...mutation, mutationDeadlineAtMs: Date.now() + 100 });
  assert.equal(service.status().queueLength, 0);
  t.mock.timers.tick(100);
  assertError(await result, 408, exceeded);
  assert.equal(fetch.mock.callCount(), 0);
});

for (const stage of ['fetch', 'body']) {
  test(`aborts a pending ${stage} at the mutation deadline`, { timeout: 2_000 }, async (t) => {
    mockClock(t);
    const started = Promise.withResolvers();
    let signal;
    const service = coordinator(t, (_url, options) => {
      ({ signal } = options);
      if (stage === 'fetch') {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('synthetic provider detail')), { once: true });
          started.resolve();
        });
      }
      return new Response(new ReadableStream({
        start(stream) {
          signal.addEventListener('abort', () => stream.error(new Error('synthetic provider detail')), { once: true });
        },
        pull() {
          started.resolve();
        },
      }, { highWaterMark: 0 }), { status: 201 }); // Pull only when the consumer reads.
    });
    const result = service.submit({ ...mutation, mutationDeadlineAtMs: Date.now() + 100 });
    await started.promise;
    t.mock.timers.tick(100);
    assertError(await result, 408, exceeded);
    assert.equal(signal.aborted, true);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

for (const stage of ['redirect', 'body', 'provider error']) {
  test(`suppresses a late ${stage} even if the deadline timer has not fired`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const service = coordinator(t, () => {
      if (stage === 'body') {
        return {
          status: 201,
          text() {
            now += 100;
            return 'synthetic provider detail';
          },
        };
      }
      now += 100;
      if (stage === 'provider error') throw new Error('synthetic provider detail');
      return new Response(null, { status: 302, headers: { location: 'https://example.invalid/redir' } });
    });
    assertError(await service.submit({ ...mutation, mutationDeadlineAtMs: now + 100 }), 408, exceeded);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('accepts a future deadline at the maximum horizon and returns the provider response', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const service = coordinator(t, () => new Response('created', { status: 201 }));
  const response = await service.submit({ ...mutation, mutationDeadlineAtMs: now + 120_000 });
  assert.equal(response.status, 201);
  assert.equal(response.body, 'created');
});

test('returns a rate limit without retrying a mutation', async (t) => {
  const service = coordinator(t, () => new Response('slow down', {
    status: 429, headers: { 'retry-after': '1', 'x-ratelimit-remaining': '0' },
  }));
  const response = await service.submit({ ...mutation, mutationDeadlineAtMs: Date.now() + 10_000 });
  assert.equal(response.error?.code, 'github_rate_limited');
  await nextTurn();
  assert.equal(service.status().queueLength, 0);
  assert.equal(fetch.mock.callCount(), 1);
});

test('preserves legacy body handling and deduplication of pending reads', async (t) => {
  let signal;
  const service = coordinator(t, (_url, options) => {
    ({ signal } = options);
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      async text() {
        await nextTurn();
        assert.equal(signal.aborted, false);
        return 'legacy';
      },
    };
  });
  const legacy = await service.submit(mutation);
  assert.equal(legacy.body, 'legacy');
  const read = { ...mutation, method: 'GET' };
  const pending = service.submit(read);
  assert.equal(service.submit(read), pending);
  const inherited = Object.assign(Object.create({ mutationDeadlineAtMs: 1 }), read);
  assert.equal(service.submit(inherited), pending);
  assert.equal((await pending).body, 'legacy');
  assert.equal(fetch.mock.callCount(), 2);
});
