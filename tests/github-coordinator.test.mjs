import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  classifyBucket,
  GitHubCoordinator,
  isSafeRead,
  parseGhApiArguments,
  retryDelayMilliseconds,
} from '../bin/github-coordinator.mjs';
import {
  normalizeIdentity,
  socketPath,
} from '../bin/github-coordinator-client.mjs';

const ROOT = join(import.meta.dirname, '..');
const POLICY = join(ROOT, 'bin', 'github-api-policy.mjs');

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
