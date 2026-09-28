import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyJob,
  GitHubCoordinator,
  graphqlOperationIsMutation,
  LANE_LIMITS,
  latencySummary,
  MAX_IN_FLIGHT,
  repoFromWorkingDirectory,
  SECONDARY_LIMIT_BUDGETS,
  SECONDARY_LIMIT_WINDOW_MS,
} from '../bin/github-coordinator.mjs';

const tick = () => new Promise((resolvePromise) => setImmediate(resolvePromise));
const settle = async (turns = 4) => { for (let turn = 0; turn < turns; turn += 1) await tick(); };

function newCoordinator() {
  return new GitHubCoordinator({
    identity: 'scheduler-test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: '/tmp/frontaliere-github-coordinator-scheduler-test.sock',
  });
}

// Replaces the executor of one request type with gates the test opens.
function gate(coordinator, type) {
  const started = [];
  const pending = new Map();
  const executor = (request) => new Promise((resolvePromise) => {
    const name = request.path || request.args.join(' ');
    started.push({ name, atMs: Date.now(), client: request.client });
    pending.set(name, (response = { ok: true, exitCode: 0, status: 200, headers: {}, body: '{}', stdout: '' }) => {
      resolvePromise(response);
    });
  });
  if (type === 'api') coordinator.executeApi = executor;
  else coordinator.executeCli = executor;
  return {
    started,
    release(name, response) {
      const resolveJob = pending.get(name);
      assert.ok(resolveJob, `job ${name} not started`);
      pending.delete(name);
      resolveJob(response);
    },
    releaseAll() {
      for (const name of [...pending.keys()]) this.release(name);
    },
  };
}

function fetchResponse(status, body, headers = {}) {
  return new Response(status === 304 ? null : body, { status, headers });
}

test('una query GraphQL e una lettura, una mutation no', () => {
  assert.equal(graphqlOperationIsMutation('query { viewer { login } }'), false);
  assert.equal(graphqlOperationIsMutation('{ repository(owner:"o", name:"r") { id } }'), false);
  assert.equal(graphqlOperationIsMutation('# mutation in a comment\nquery Q { viewer { login } }'), false);
  assert.equal(graphqlOperationIsMutation('query { search(query: "mutation testing", type: ISSUE, first: 1) { issueCount } }'), false);
  assert.equal(graphqlOperationIsMutation('mutation { addComment(input: {}) { clientMutationId } }'), true);
  assert.equal(graphqlOperationIsMutation('fragment F on User { login }\nmutation M { x }'), true);
  assert.equal(graphqlOperationIsMutation(''), true, 'un documento illeggibile resta prudente');
  assert.equal(graphqlOperationIsMutation(undefined), true);
});

test('classifica ogni job nella sua corsia una volta sola', () => {
  const lane = (request) => classifyJob(request).lane;
  const mutation = (request) => classifyJob(request).mutation;

  assert.equal(lane({ type: 'api', method: 'GET', path: '/repos/o/r/pulls/1' }), 'api');
  assert.equal(lane({ type: 'api', method: 'GET', path: '/repos/o/r/actions/jobs/1/logs' }), 'bulk');
  assert.equal(lane({ type: 'api', method: 'POST', path: '/repos/o/r/issues' }), 'mutation');
  const graphqlRead = { type: 'api', method: 'POST', path: '/graphql', body: { query: 'query { viewer { login } }' } };
  assert.equal(lane(graphqlRead), 'api');
  assert.equal(classifyJob(graphqlRead).family, 'graphql');
  assert.equal(mutation({ type: 'api', method: 'POST', path: '/graphql', body: '{"query":"mutation { x }"}' }), true);

  assert.equal(lane({ type: 'exec', args: ['api', 'graphql', '-f', 'query=query { viewer { login } }'] }), 'api');
  assert.equal(mutation({ type: 'exec', args: ['api', 'graphql', '-f', 'query=mutation { x }'] }), true);
  // Not parsed natively (template) but still a POST because it sends fields.
  assert.equal(mutation({ type: 'exec', args: ['api', 'repos/o/r/issues', '-f', 'title=x', '--template', '{{.}}'] }), true);
  assert.equal(mutation({ type: 'exec', args: ['api', 'graphql', '-f', 'query=@q.graphql', '--template', '{{.}}'] }), true);
  assert.equal(lane({ type: 'exec', args: ['api', 'repos/o/r/pulls', '--paginate'] }), 'bulk');

  assert.equal(lane({ type: 'exec', args: ['pr', 'view', '1', '--repo', 'o/r'] }), 'cli');
  assert.equal(lane({ type: 'exec', args: ['run', 'view', '1', '--log-failed'] }), 'bulk');
  assert.equal(lane({ type: 'exec', args: ['run', 'download', '1', '--dir', 'out'] }), 'bulk');
  assert.equal(lane({ type: 'exec', args: ['repo', 'clone', 'o/r'] }), 'bulk');
  assert.equal(lane({ type: 'exec', args: ['search', 'prs', '--author', '@me'] }), 'cli');
  assert.equal(lane({ type: 'exec', args: ['variable', 'get', 'X', '--repo', 'o/r'] }), 'cli');
  assert.equal(lane({ type: 'exec', args: ['pr', 'comment', '1', '--body', 'x'] }), 'mutation');

  assert.equal(classifyJob({ type: 'exec', args: ['pr', 'view', '1', '-R', 'Owner/Repo'] }).scope, 'owner/repo');
  assert.equal(classifyJob({ type: 'api', method: 'GET', path: '/repos/Owner/Repo/pulls' }).scope, 'owner/repo');
  assert.equal(classifyJob({ type: 'api', method: 'GET', path: '/user' }).scope, null);
  assert.equal(classifyJob({ type: 'exec', args: ['api', 'repos/{owner}/{repo}/pulls'], cwd: '/nonexistent' }).scope, null);
  assert.equal(classifyJob({ type: 'exec', args: ['pr', 'view'], client: 'session-a', cwd: '/x' }).client, 'session-a');
  assert.equal(classifyJob({ type: 'exec', args: ['pr', 'view'], cwd: '/x' }).client, '/x');
  assert.equal(classifyJob({ type: 'exec', args: ['pr', 'view', '--json', 'x'] }).kind, 'gh pr view');
});

test('risolve il repo del worktree solo quando e univoco', () => {
  const root = mkdtempSync(join(tmpdir(), 'frontaliere-scheduler-repo-'));
  const repo = (name, config) => {
    const directory = join(root, name);
    mkdirSync(join(directory, '.git'), { recursive: true });
    mkdirSync(join(directory, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(directory, '.git', 'config'), config);
    return directory;
  };
  try {
    const single = repo('single', '[remote "origin"]\n\turl = git@github.com:Owner/Repo.git\n');
    assert.equal(repoFromWorkingDirectory(single), 'owner/repo');
    assert.equal(repoFromWorkingDirectory(join(single, 'nested', 'deeper')), 'owner/repo');
    const https = repo('https', '[remote "origin"]\n\turl = https://github.com/o/site.git\n');
    assert.equal(repoFromWorkingDirectory(https), 'o/site');
    const two = repo('two', '[remote "origin"]\n\turl = https://github.com/me/fork\n[remote "upstream"]\n\turl = https://github.com/them/repo\n');
    assert.equal(repoFromWorkingDirectory(two), null);
    const resolved = repo('resolved', '[remote "origin"]\n\turl = https://github.com/o/r\n\tgh-resolved = base\n');
    assert.equal(repoFromWorkingDirectory(resolved), null);

    // Linked worktree: `.git` is a file and the config lives in commondir.
    const main = repo('main', '[remote "origin"]\n\turl = git@github.com:o/linked.git\n');
    const worktreeGitDirectory = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(worktreeGitDirectory, { recursive: true });
    writeFileSync(join(worktreeGitDirectory, 'commondir'), '../..\n');
    const worktree = join(root, 'wt');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDirectory}\n`);
    assert.equal(repoFromWorkingDirectory(worktree), 'o/linked');
    assert.equal(repoFromWorkingDirectory(join(root, 'no-repo-here')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('un client con molti job in volo non scavalca un client in attesa', async () => {
  const coordinator = newCoordinator();
  const api = gate(coordinator, 'api');
  const capacity = Math.min(MAX_IN_FLIGHT, LANE_LIMITS.api);
  const read = (path, client) => coordinator.submit({ type: 'api', method: 'GET', path, client, cacheTtlMs: 0 });
  const promises = [];
  for (let index = 0; index < capacity + 3; index += 1) promises.push(read(`/repos/o/r/x${index}`, 'busy'));
  promises.push(read('/repos/o/r/y0', 'quiet'));
  await settle();
  assert.equal(api.started.length, capacity);
  assert.equal(coordinator.status({ compact: true }).scheduler.queuedClients, 2);

  api.release('/repos/o/r/x0');
  await settle();
  // FIFO would have started x<capacity> first.
  assert.equal(api.started.at(-1).name, '/repos/o/r/y0');

  api.releaseAll();
  await settle();
  api.releaseAll();
  await Promise.all(promises);
});

test('le corsie sono indipendenti: gh lenti non bloccano le letture API', async () => {
  const coordinator = newCoordinator();
  const cli = gate(coordinator, 'cli');
  const api = gate(coordinator, 'api');
  const promises = [];
  for (let index = 0; index <= LANE_LIMITS.cli; index += 1) {
    promises.push(coordinator.submit({
      type: 'exec',
      args: ['pr', 'view', String(index), '--repo', 'o/r'],
      client: `agent-${index}`,
    }));
  }
  await settle();
  assert.equal(cli.started.length, LANE_LIMITS.cli);

  promises.push(coordinator.submit({ type: 'api', method: 'GET', path: '/repos/o/r/pulls/9', cacheTtlMs: 0 }));
  await settle();
  assert.equal(api.started.length, 1, 'la lettura API parte con la corsia CLI piena');
  const { lanes } = coordinator.status({ compact: true }).scheduler;
  assert.deepEqual(lanes.cli, { limit: LANE_LIMITS.cli, active: LANE_LIMITS.cli, queued: 1 });
  assert.equal(lanes.api.active, 1);

  api.releaseAll();
  cli.releaseAll();
  await settle();
  cli.releaseAll();
  await Promise.all(promises);
  await settle();
  const detailed = coordinator.status().scheduler;
  assert.equal(detailed.latency.cli.runMs.samples, LANE_LIMITS.cli + 1);
  assert.ok(detailed.requestKinds.some(({ kind, count }) => kind === 'gh pr view' && count === LANE_LIMITS.cli + 1));
});

test('le mutation restano serializzate a un secondo di distanza fra gli avvii', async () => {
  const coordinator = newCoordinator();
  const starts = [];
  let overlapping = false;
  let active = 0;
  coordinator.executeCli = async () => {
    starts.push(Date.now());
    active += 1;
    if (active > 1) overlapping = true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    active -= 1;
    return { ok: true, exitCode: 0, stdout: '', stderr: '' };
  };
  const comment = (number) => coordinator.submit({
    type: 'exec',
    args: ['pr', 'comment', String(number), '--body', 'x', '--repo', 'o/r'],
  });
  await Promise.all([comment(1), comment(2)]);
  assert.equal(overlapping, false);
  const gap = starts[1] - starts[0];
  assert.ok(gap >= 995, `gap ${gap}`);
  // Counting from the completion would have waited 800 + 1000 ms.
  assert.ok(gap < 1_700, `gap ${gap}`);
});

test('una mutation pronta prima della sveglia pendente non aspetta il bucket in pausa', async () => {
  const coordinator = newCoordinator();
  coordinator.executeApi = async () => ({ ok: true, status: 200, headers: {}, body: '{}' });
  coordinator.bucketPausedUntil.set('core', Date.now() + 60_000);
  const pausedRead = coordinator.submit({ type: 'api', method: 'GET', path: '/repos/o/r/pulls/1', cacheTtlMs: 0 });
  await settle();
  assert.ok(coordinator.wakeTimer, 'sveglia sulla pausa del bucket');
  coordinator.lastMutationStartedAt = Date.now();
  const startedAt = Date.now();
  await coordinator.submit({ type: 'api', method: 'POST', path: '/repos/o/r/issues', body: {} });
  assert.ok(Date.now() - startedAt < 5_000);

  coordinator.bucketPausedUntil.clear();
  coordinator.pump();
  await pausedRead;
  if (coordinator.wakeTimer) clearTimeout(coordinator.wakeTimer);
});

test('rimanda i job oltre il budget dei limiti secondari', async () => {
  const coordinator = newCoordinator();
  const api = gate(coordinator, 'api');
  coordinator.recordSecondaryUsage('rest', SECONDARY_LIMIT_BUDGETS.rest);
  const read = coordinator.submit({ type: 'api', method: 'GET', path: '/repos/o/r/pulls/1', cacheTtlMs: 0 });
  await settle();
  assert.equal(api.started.length, 0);
  assert.ok(coordinator.metrics.secondaryLimitDeferrals >= 1);
  assert.equal(coordinator.status({ compact: true }).scheduler.secondaryLimit.rest.used, SECONDARY_LIMIT_BUDGETS.rest);
  assert.ok(coordinator.wakeAt > Date.now() + SECONDARY_LIMIT_WINDOW_MS / 2);

  // The window slides: once the old usage leaves it, the job runs.
  coordinator.secondaryWindow.rest[0].atMs -= SECONDARY_LIMIT_WINDOW_MS + 1;
  coordinator.pump();
  await settle();
  assert.equal(api.started.length, 1);
  api.releaseAll();
  await read;
  if (coordinator.wakeTimer) clearTimeout(coordinator.wakeTimer);
});

test('il daemon interrompe un gh appeso invece di tenere lo slot per sempre', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-scheduler-hang-'));
  const hangingGh = join(directory, 'hanging-gh.mjs');
  writeFileSync(hangingGh, '#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n');
  chmodSync(hangingGh, 0o700);
  const coordinator = new GitHubCoordinator({
    identity: 'scheduler-test',
    token: 'secret-for-test',
    realGh: hangingGh,
    socket: join(directory, 'coordinator.sock'),
  });
  try {
    const request = { type: 'exec', args: ['pr', 'view', '1', '--repo', 'o/r'], cwd: directory };
    const startedAt = Date.now();
    const response = await coordinator.executeCli(request, { ...classifyJob(request), timeoutMs: 200 });
    assert.equal(response.ok, false);
    assert.equal(response.exitCode, 124);
    assert.match(response.stderr, /interrotto dal daemon/);
    assert.equal(coordinator.metrics.cliTimeouts, 1);
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('una mutation invalida solo il suo repo e le letture tornano con un 304', async () => {
  const coordinator = newCoordinator();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const { pathname } = new URL(url);
    calls.push({ pathname, method: options.method, ifNoneMatch: options.headers['if-none-match'] });
    if (options.method === 'POST') return fetchResponse(201, '{}');
    const etag = pathname.includes('/o/a/') ? '"A1"' : '"B1"';
    if (options.headers['if-none-match'] === etag) return fetchResponse(304, null, { etag });
    return fetchResponse(200, JSON.stringify({ pathname }), { etag });
  };
  const read = (path) => coordinator.submit({ type: 'api', method: 'GET', path, cacheTtlMs: 60_000 });
  try {
    await read('/repos/o/a/pulls/1');
    await read('/repos/o/b/pulls/1');
    assert.equal((await read('/repos/o/a/pulls/1')).headers['x-frontaliere-cache'], 'hit');
    assert.equal(calls.length, 2);

    await coordinator.submit({ type: 'api', method: 'POST', path: '/repos/o/a/issues', body: { title: 'x' } });
    assert.equal(calls.length, 3);
    assert.equal((await read('/repos/o/b/pulls/1')).headers['x-frontaliere-cache'], 'hit', 'altro repo: resta in cache');
    assert.equal(calls.length, 3);

    const revalidated = await read('/repos/o/a/pulls/1');
    assert.equal(calls.length, 4);
    assert.equal(calls[3].ifNoneMatch, '"A1"');
    assert.equal(revalidated.headers['x-frontaliere-cache'], 'revalidated');
    assert.deepEqual(JSON.parse(revalidated.body), { pathname: '/repos/o/a/pulls/1' });
    assert.equal(coordinator.metrics.cacheRevalidations, 1);
    assert.equal(coordinator.metrics.cacheScopedInvalidations >= 1, true);

    // A mutation of unknown scope (GraphQL) invalidates every repo.
    await coordinator.submit({ type: 'api', method: 'POST', path: '/graphql', body: { query: 'mutation { x }' } });
    await read('/repos/o/b/pulls/1');
    assert.equal(calls.at(-1).pathname, '/repos/o/b/pulls/1');
    assert.equal(calls.at(-1).ifNoneMatch, '"B1"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('una lettura con ttl 0 usa comunque l ETag salvato', async () => {
  const coordinator = newCoordinator();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(options.headers['if-none-match'] || null);
    if (options.headers['if-none-match'] === '"R1"') return fetchResponse(304, null, { etag: '"R1"' });
    return fetchResponse(200, '{"state":"open"}', { etag: '"R1"' });
  };
  try {
    const request = { type: 'api', method: 'GET', path: '/repos/o/r/actions/runs/1', cacheTtlMs: 0 };
    const first = await coordinator.submit(request);
    const second = await coordinator.submit(request);
    assert.deepEqual(calls, [null, '"R1"']);
    assert.equal(first.body, '{"state":"open"}');
    assert.equal(second.body, '{"state":"open"}');
    assert.equal(second.headers['x-frontaliere-cache'], 'revalidated');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('una lettura partita prima di una mutation non resta in cache come fresca', async () => {
  const coordinator = newCoordinator();
  let releaseRead;
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetches += 1;
    if (options.method === 'POST') return fetchResponse(201, '{}');
    if (fetches === 1) {
      await new Promise((resolvePromise) => { releaseRead = resolvePromise; });
      return fetchResponse(200, '{"labels":[]}', { etag: '"L1"' });
    }
    return fetchResponse(200, '{"labels":["x"]}', { etag: '"L2"' });
  };
  try {
    const path = '/repos/o/r/issues/1';
    const inFlight = coordinator.submit({ type: 'api', method: 'GET', path, cacheTtlMs: 60_000 });
    while (!releaseRead) await tick();
    await coordinator.submit({ type: 'api', method: 'POST', path: '/repos/o/r/issues/1/labels', body: { labels: ['x'] } });
    releaseRead();
    await inFlight;
    const after = await coordinator.submit({ type: 'api', method: 'GET', path, cacheTtlMs: 60_000 });
    assert.equal(after.body, '{"labels":["x"]}');
    assert.equal(fetches, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('le query GraphQL identiche si deduplicano e restano in cache, con header distinti no', async () => {
  const coordinator = newCoordinator();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ body: options.body, accept: options.headers.accept });
    await tick();
    return fetchResponse(200, '{"data":{}}');
  };
  try {
    const query = { type: 'api', method: 'POST', path: '/graphql', body: { query: 'query { viewer { login } }' } };
    await Promise.all([coordinator.submit(query), coordinator.submit(query)]);
    assert.equal(calls.length, 1);
    assert.equal((await coordinator.submit(query)).headers['x-frontaliere-cache'], 'hit');
    await coordinator.submit({ ...query, body: { query: 'query { viewer { id } }' } });
    assert.equal(calls.length, 2, 'un altro documento non collide piu su [object Object]');

    const path = '/repos/o/r/readme';
    await coordinator.submit({ type: 'api', method: 'GET', path });
    await coordinator.submit({ type: 'api', method: 'GET', path, headers: { accept: 'application/vnd.github.raw' } });
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('la cache API resta limitata', async () => {
  const coordinator = newCoordinator();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => fetchResponse(200, '{}', { etag: '"E"' });
  try {
    for (let index = 0; index < 600; index += 1) {
      await coordinator.submit({ type: 'api', method: 'GET', path: `/repos/o/r/issues/${index}`, cacheTtlMs: 60_000 });
    }
    assert.equal(coordinator.cache.size, 512);
    assert.equal(coordinator.metrics.cacheEvictions, 600 - 512);
    assert.equal(coordinator.cache.has('scheduler-test|authenticated|GET|/repos/o/r/issues/0||'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('riassume le latenze con percentili', () => {
  assert.deepEqual(latencySummary([]), { samples: 0, p50: null, p95: null, max: null });
  const summary = latencySummary(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(summary.p50, 51);
  assert.equal(summary.p95, 96);
  assert.equal(summary.max, 100);
});
