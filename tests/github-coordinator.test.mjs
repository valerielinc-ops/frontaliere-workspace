import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import {
  classifyBucket,
  cancellationRequestDetails,
  createDebouncedReloadScheduler,
  GitHubCoordinator,
  isSafeRead,
  parseGhApiArguments,
  RESPONSE_TRUNCATED_CODE,
  RESPONSE_TRUNCATED_EXIT_CODE,
  retryDelayMilliseconds,
  WATCHED_SOURCE_NAMES,
} from '../bin/github-coordinator.mjs';
import {
  ensureCoordinator,
  eventAudit,
  eventSubscriptions,
  ingestGitHubWebhook,
  listenForEvent,
  normalizeIdentity,
  requestTimeoutMilliseconds,
  sendRequest,
  socketPath,
  subscribeToEvents,
  unsubscribeFromEvents,
  waitForCoordinatorStop,
} from '../bin/github-coordinator-client.mjs';
import {
  LAUNCHD_SPAWN_SCHEDULED_STATE,
  eventLifecycleHealth,
  launchdHealthFindings,
} from '../bin/github-coordinator-health.mjs';
import {
  GitHubEventBroker,
  DEFAULT_STALLED_AFTER_MS,
  DEFAULT_ORPHAN_GRACE_MS,
  eventMatchesSubscription,
  MAX_SUBSCRIPTION_TTL_MS,
  normalizeWebhookEvent,
  normalizeReconciliationEvent,
  verifyWebhookSignature,
} from '../bin/github-event-broker.mjs';
import {
  createGitHubWebhookReceiver,
  createWorkerRotationController,
  webhookErrorStatus,
} from '../bin/github-webhook-receiver.mjs';

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

function fakeStreamingResponse(status, chunks, headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  let index = 0;
  let cancelled = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return normalized[String(name).toLowerCase()] ?? null; } },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: Buffer.from(chunks[index++]) };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
    get cancelled() { return cancelled; },
  };
}

function createFakeGh(directory) {
  const script = join(directory, 'fake-gh.mjs');
  writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const mode = args[0] === 'pr' && args[1] === 'review' ? 'review'
  : args.includes('large') ? 'large'
    : args.includes('stdin-eof') ? 'stdin-eof'
      : 'read';
const logFile = join(process.cwd(), 'invocations.jsonl');
let record = { args };
let lockFile;
if (mode === 'review') {
  lockFile = join(process.cwd(), 'review.lock');
  try {
    const fd = openSync(lockFile, 'wx');
    closeSync(fd);
    record = { ...record, overlapping: false };
  } catch {
    record = { ...record, overlapping: true };
  }
}
appendFileSync(logFile, JSON.stringify(record) + '\\n');
if (mode === 'large') {
  process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
} else if (mode === 'review') {
  setTimeout(() => {
    try { unlinkSync(lockFile); } catch {}
    process.stdout.write('reviewed\\n');
  }, 20);
} else if (mode === 'stdin-eof') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => process.stdout.write('stdin-eof:' + input.length + '\\n'));
} else {
  process.stdout.write('read\\n');
}
`);
  chmodSync(script, 0o700);
  return script;
}

function sendRawCoordinatorLine(identity, line) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath(identity));
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      rejectOnce(new Error(`raw_coordinator_request_timeout: ${identity}`));
    }, 5_000);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        resolveOnce(JSON.parse(buffer.slice(0, newline)));
        socket.end();
      } catch (error) {
        socket.destroy();
        rejectOnce(error);
      }
    });
    socket.on('error', rejectOnce);
    socket.on('close', () => {
      if (!settled) rejectOnce(new Error(`raw_coordinator_connection_closed: ${identity}`));
    });
  });
}

test('accorpa gli eventi source ravvicinati e aspetta la quiescenza', async () => {
  assert.equal(WATCHED_SOURCE_NAMES.has('github-event-routing.mjs'), true);
  let activeRequests = 1;
  let reloads = 0;
  const scheduler = createDebouncedReloadScheduler({
    onReload: () => { reloads += 1; },
    getActiveRequests: () => activeRequests,
    debounceMs: 15,
    quiescenceMs: 5,
  });

  try {
    assert.equal(scheduler.request(), true);
    assert.equal(scheduler.request(), false);
    assert.equal(scheduler.request(), false);
    setTimeout(() => { activeRequests = 0; }, 30);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    assert.equal(reloads, 1);
  } finally {
    scheduler.stop();
  }
});

test('promuove il worker sostitutivo solo dopo che il listener condiviso è pronto', () => {
  const workers = [];
  const disconnected = [];
  const rotation = createWorkerRotationController({
    forkWorker: () => {
      const worker = { id: workers.length + 1 };
      workers.push(worker);
      return worker;
    },
    disconnectWorker: (worker) => disconnected.push(worker.id),
  });

  const first = rotation.start();
  assert.equal(first.id, 1);
  assert.equal(rotation.reload(), false);
  assert.equal(rotation.markListening(first), true);

  assert.equal(rotation.reload(), true);
  const second = workers[1];
  assert.deepEqual(disconnected, []);
  assert.equal(rotation.markListening(second), true);
  assert.deepEqual(disconnected, [1]);
  assert.equal(rotation.snapshot().activeWorker, second);
  rotation.stop();
  assert.deepEqual(disconnected, [1, 2]);
});

test('mantiene i listener SIGTERM e SIGINT del coordinator su un exit code numerico', () => {
  const coordinatorSource = readFileSync(join(ROOT, 'bin', 'github-coordinator.mjs'), 'utf8');
  const receiverSource = readFileSync(join(ROOT, 'bin', 'github-webhook-receiver.mjs'), 'utf8');

  assert.match(coordinatorSource, /process\.on\('SIGTERM', \(\) => terminate\(0\)\);/);
  assert.match(coordinatorSource, /process\.on\('SIGINT', \(\) => terminate\(0\)\);/);
  assert.doesNotMatch(coordinatorSource, /process\.on\(['"]SIG(?:TERM|INT)['"],\s*terminate\)/);
  assert.doesNotMatch(receiverSource, /process\.on\(['"]SIG(?:TERM|INT)['"]/);
});

test('usa il timeout lungo solo per le richieste che possono fare I/O GitHub', () => {
  const shortRequestTypes = [
    'ping',
    'status',
    'shutdown',
    'cancellation-details',
    'events-status',
    'events-summary',
    'events-audit',
    'events-gc',
    'events-subscription',
    'events-subscription-target',
    'events-unsubscribe',
    'events-renew',
    'events-webhook',
    'event-listen',
    'event-heartbeat',
    'event-ack',
  ];
  for (const type of shortRequestTypes) assert.equal(requestTimeoutMilliseconds({ type }), 3_000, type);
  for (const type of ['api', 'exec', 'events-subscribe', 'events-reconcile', 'confirm-cancellation']) {
    assert.equal(requestTimeoutMilliseconds({ type }), 15 * 60 * 1_000, type);
  }
});

test('health classifica residui lifecycle come warning indipendentemente dal volume', () => {
  const findings = eventLifecycleHealth({
    orphanedSubscriptions: 69,
    stalledSubscriptions: 6,
  }, 'default');
  assert.deepEqual(findings.alerts, []);
  assert.deepEqual(findings.warnings.map(({ code }) => code), [
    'orphaned_subscriptions',
    'stalled_subscriptions',
  ]);
});

test('health mantiene alert solo per eventi pending senza listener oltre la grace period', () => {
  const findings = eventLifecycleHealth({
    orphanedSubscriptions: 69,
    stalledSubscriptions: 6,
    scheduledGc: {
      orphanedWithPending: [{ id: 'sub-old', pendingState: 'merged' }],
    },
  }, 'default');
  assert.deepEqual(findings.alerts.map(({ code }) => code), ['orphaned_pending_events']);
  assert.deepEqual(findings.warnings.map(({ code }) => code), [
    'orphaned_subscriptions',
    'stalled_subscriptions',
  ]);
});

test('health usa i contatori pending compatti e non restituisce la lista degli orfani', () => {
  const findings = eventLifecycleHealth({
    pendingEvents: 111,
    pendingSubscriptionCount: 70,
    oldestPendingAt: '2026-09-20T02:06:39.944Z',
    scheduledGc: {
      orphanedWithPendingSubscriptionCount: 70,
      orphanedWithPendingEventCount: 111,
      orphanedWithPendingOldestAt: '2026-09-20T02:06:39.944Z',
      nextAction: 'reattach_or_explicit_ack',
    },
  }, 'default');
  assert.equal(findings.alerts.length, 1);
  assert.deepEqual(findings.alerts[0], {
    code: 'orphaned_pending_events',
    count: 111,
    subscriptionCount: 70,
    eventCount: 111,
    oldestPendingAt: '2026-09-20T02:06:39.944Z',
    nextAction: 'reattach_or_explicit_ack',
    message: 'default: 111 pending events across 70 subscriptions have had no listener for over an hour',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(findings.alerts[0], 'subscriptions'), false);
});

test('health classifica launchd spawn scheduled come warning solo con processo socket e probe sani', () => {
  const launchd = { supported: true, state: LAUNCHD_SPAWN_SCHEDULED_STATE };
  const healthy = launchdHealthFindings('default', launchd, {
    processHealthy: true,
    socketHealthy: true,
    probeHealthy: true,
  });
  assert.deepEqual(healthy.alerts, []);
  assert.deepEqual(healthy.warnings.map(({ code }) => code), ['launchd_spawn_scheduled']);

  for (const missing of ['processHealthy', 'socketHealthy', 'probeHealthy']) {
    const findings = launchdHealthFindings('default', launchd, {
      processHealthy: true,
      socketHealthy: true,
      probeHealthy: true,
      [missing]: false,
    });
    assert.deepEqual(findings.warnings, [], missing);
    assert.deepEqual(findings.alerts.map(({ code }) => code), ['launchd_not_running'], missing);
  }
});

test('invalida i check di protocollo quando cambia il daemon', async () => {
  const stateDirectory = mkdtempSync('/tmp/pm-');
  const identity = `pm-${process.pid}`;
  const previousStateDirectory = process.env.FRONTALIERE_GH_STATE_DIR;
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  let protocolVersion = 5;
  let startedAt = 'daemon-start-1';
  let server;
  let requests = 0;

  const startFakeCoordinator = async () => {
    server = createServer((connection) => {
      let buffer = '';
      connection.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        requests += 1;
        const status = {
          protocolVersion,
          metrics: { startedAt },
          events: { webhookSecretConfigured: true },
        };
        const response = request.type === 'ping' || request.type === 'status'
          ? { ok: true, status }
          : { ok: true, subscriptions: [], pendingEvents: 0 };
        connection.end(`${JSON.stringify(response)}\n`);
      });
    });
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(socketPath(identity), resolvePromise);
    });
  };

  try {
    await startFakeCoordinator();
    const first = await eventSubscriptions({}, { identity });
    assert.equal(first.ok, true);
    const requestsAfterFirst = requests;
    const second = await eventSubscriptions({}, { identity });
    assert.equal(second.ok, true);
    assert.equal(requests - requestsAfterFirst, 2, 'la seconda chiamata usa il ping e la richiesta, senza probe status');

    await new Promise((resolvePromise) => server.close(resolvePromise));
    try { unlinkSync(socketPath(identity)); } catch { /* socket già rimosso */ }
    protocolVersion = 4;
    startedAt = 'daemon-start-2';
    await startFakeCoordinator();

    await assert.rejects(
      eventSubscriptions({}, { identity }),
      (error) => error.code === 'event_protocol_unavailable',
    );
  } finally {
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    try { unlinkSync(socketPath(identity)); } catch { /* socket già rimosso */ }
    if (previousStateDirectory === undefined) delete process.env.FRONTALIERE_GH_STATE_DIR;
    else process.env.FRONTALIERE_GH_STATE_DIR = previousStateDirectory;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('il ping del coordinator resta leggero e non serializza il backlog eventi', () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-coordinator-ping-');
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret: 'ping-secret',
  });
  let summaryCalls = 0;
  const originalSummary = broker.summary.bind(broker);
  broker.summary = (...args) => {
    summaryCalls += 1;
    return originalSummary(...args);
  };
  const coordinator = new GitHubCoordinator({
    identity: 'ping-test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });

  try {
    const status = coordinator.ping();
    assert.equal(status.protocolVersion >= 5, true);
    assert.equal(status.identity, 'ping-test');
    assert.equal(status.events.webhookSecretConfigured, true);
    assert.equal(summaryCalls, 0);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

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

test('classifica le letture CLI note e tratta i verbi sconosciuti come mutation', () => {
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: process.execPath,
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });
  const isMutation = (args) => coordinator.jobIsMutation({ request: { type: 'exec', args } });

  for (const [noun, verb] of [
    ['pr', 'list'],
    ['pr', 'view'],
    ['pr', 'checks'],
    ['run', 'list'],
    ['run', 'view'],
    ['workflow', 'list'],
    ['workflow', 'view'],
    ['issue', 'list'],
    ['issue', 'view'],
  ]) {
    assert.equal(isMutation([noun, verb]), false, `gh ${noun} ${verb}`);
  }
  assert.equal(isMutation(['run', 'download', '123', '--dir', 'out']), false, 'gh run download');
  assert.equal(isMutation(['release', 'download', 'v1']), false, 'gh release download');
  assert.equal(isMutation(['pr', 'review']), true);
  assert.equal(isMutation(['workflow', 'run']), true);
  assert.equal(isMutation(['future', 'download']), true);
  assert.equal(isMutation(['future', 'verb']), true);
});

test('esegue due gh pr review identici, li serializza e invalida la cache CLI', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-cli-review-'));
  const realGh = createFakeGh(directory);
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh,
    socket: join(directory, 'coordinator.sock'),
  });
  coordinator.cliCache.set('stale-entry', { response: { ok: true }, expiresAt: Date.now() + 10_000 });
  const request = {
    type: 'exec',
    identity: 'test',
    args: ['pr', 'review', '42', '--approve', '--repo', 'owner/repo'],
    cwd: directory,
  };

  try {
    const [first, second] = await Promise.all([coordinator.submit(request), coordinator.submit(request)]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(coordinator.metrics.cliCacheHits, 0);
    assert.equal(coordinator.cliCache.size, 0);
    const invocations = readFileSync(join(directory, 'invocations.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations.map(({ args }) => args), [request.args, request.args]);
    assert.equal(invocations.every(({ overlapping }) => overlapping === false), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chiude stdin per le CLI che lo usano come input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-cli-stdin-'));
  const realGh = createFakeGh(directory);
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh,
    socket: join(directory, 'coordinator.sock'),
  });
  const response = await coordinator.submit({
    type: 'exec',
    identity: 'test',
    args: ['pr', 'comment', '42', '--body-file', '-', 'stdin-eof'],
    cwd: directory,
  });

  try {
    assert.equal(response.ok, true);
    assert.match(response.stdout, /^stdin-eof:0\n$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('blocca gh run watch prima di avviare un subprocess', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-run-watch-'));
  const realGh = createFakeGh(directory);
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh,
    socket: join(directory, 'coordinator.sock'),
  });
  const response = await coordinator.submit({
    type: 'exec',
    identity: 'test',
    args: ['run', 'watch', '123', '--exit-status'],
    cwd: directory,
  });

  try {
    assert.equal(response.ok, false);
    assert.equal(response.exitCode, 2);
    assert.match(response.stderr, /gh run watch è vietato/);
    assert.equal(existsSync(join(directory, 'invocations.jsonl')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gh run download non entra in cache: ogni richiesta riesegue il download', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-cli-download-'));
  const realGh = createFakeGh(directory);
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh,
    socket: join(directory, 'coordinator.sock'),
  });
  const request = {
    type: 'exec',
    identity: 'test',
    args: ['run', 'download', '42', '--repo', 'owner/repo', '--dir', 'out'],
    cwd: directory,
  };

  try {
    const first = await coordinator.submit(request);
    const second = await coordinator.submit(request);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(second.fromCache, true);
    assert.equal(coordinator.metrics.cliCacheHits, 0);
    assert.equal(coordinator.cliCache.size, 0);
    const invocations = readFileSync(join(directory, 'invocations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(invocations.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mantiene la cache per le letture CLI piccole e deduplica gh pr view', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-cli-read-'));
  const realGh = createFakeGh(directory);
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh,
    socket: join(directory, 'coordinator.sock'),
  });
  const request = {
    type: 'exec',
    identity: 'test',
    args: ['pr', 'view', '42', '--repo', 'owner/repo'],
    cwd: directory,
  };

  try {
    const first = await coordinator.submit(request);
    const second = await coordinator.submit(request);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.fromCache, true);
    assert.equal(coordinator.metrics.cliCacheHits, 1);
    const invocations = readFileSync(join(directory, 'invocations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(invocations.length, 1);
    assert.equal(coordinator.cliCache.size, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('condivide la cache di una lettura --repo fra worktree diversi', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-cli-worktree-'));
  const realGh = createFakeGh(directory);
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh,
    socket: join(directory, 'coordinator.sock'),
  });
  const worktreeA = join(directory, 'wt-a');
  const worktreeB = join(directory, 'wt-b');
  mkdirSync(worktreeA);
  mkdirSync(worktreeB);
  const args = ['run', 'view', '123', '--repo', 'owner/repo'];

  try {
    // Two agents polling the same run from their own worktrees must collapse onto
    // one invocation; keying by cwd made every fleet member miss the cache. The
    // fake gh logs into its cwd, so an untouched wt-b proves the second was served
    // from the cache rather than re-executed.
    const first = await coordinator.submit({ type: 'exec', identity: 'test', args, cwd: worktreeA });
    const second = await coordinator.submit({ type: 'exec', identity: 'test', args, cwd: worktreeB });
    assert.equal(first.ok, true);
    assert.equal(second.fromCache, true);
    assert.equal(coordinator.metrics.cliCacheHits, 1);
    assert.equal(existsSync(join(worktreeA, 'invocations.jsonl')), true);
    assert.equal(existsSync(join(worktreeB, 'invocations.jsonl')), false);

    // Without --repo the command resolves the repo from the working directory,
    // so two worktrees must stay on separate entries and both really run.
    const bare = ['pr', 'list'];
    await coordinator.submit({ type: 'exec', identity: 'test', args: bare, cwd: worktreeA });
    const bareSecond = await coordinator.submit({ type: 'exec', identity: 'test', args: bare, cwd: worktreeB });
    assert.notEqual(bareSecond.fromCache, true);
    assert.equal(coordinator.metrics.cliCacheHits, 1);
    assert.equal(existsSync(join(worktreeB, 'invocations.jsonl')), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('non mette in cache l output CLI spillato e non riusa il file del primo consumer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-cli-spill-'));
  const realGh = createFakeGh(directory);
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh,
    socket: join(directory, 'coordinator.sock'),
  });
  const request = {
    type: 'exec',
    identity: 'test',
    args: ['run', 'view', 'large'],
    cwd: directory,
  };

  try {
    const first = await coordinator.submit(request);
    assert.equal(first.ok, true);
    assert.ok(first.stdoutFile);
    assert.equal(coordinator.cliCache.size, 0);
    assert.equal(existsSync(first.stdoutFile), true);
    unlinkSync(first.stdoutFile);

    const second = await coordinator.submit(request);
    assert.equal(second.ok, true);
    assert.ok(second.stdoutFile);
    assert.notEqual(second.stdoutFile, first.stdoutFile);
    assert.equal(existsSync(second.stdoutFile), true);
    assert.equal(second.fromCache, undefined);
    assert.equal(coordinator.cliCache.size, 0);
    unlinkSync(second.stdoutFile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('segue i redirect esterni dei log senza inoltrare il token del coordinator', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return fakeResponse(302, '', { location: 'https://blob.example.test/job-log?sig=signed' });
    }
    return fakeResponse(200, 'log del job in corso\n');
  };
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });

  try {
    const response = await coordinator.submit({
      type: 'api',
      identity: 'test',
      method: 'GET',
      path: '/repos/owner/repo/actions/jobs/123/logs',
      cacheTtlMs: 0,
    });
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.body, 'log del job in corso\n');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.authorization, 'Bearer secret-for-test');
    assert.equal(calls[1].url, 'https://blob.example.test/job-log?sig=signed');
    assert.equal(calls[1].options.method, 'GET');
    assert.equal(calls[1].options.redirect, 'manual');
    assert.equal(Object.keys(calls[1].options.headers)
      .some((name) => name.toLowerCase() === 'authorization'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non segue i redirect che restano su github.com o api.github.com', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return fakeResponse(302, 'redirect GitHub', { location: 'https://github.com/owner/repo' });
  };
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });

  try {
    const response = await coordinator.submit({
      type: 'api',
      identity: 'test',
      method: 'GET',
      path: '/repos/owner/repo/actions/jobs/123/logs',
      cacheTtlMs: 0,
    });
    assert.equal(response.status, 302);
    assert.equal(response.body, 'redirect GitHub');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('segnala invece di consegnare la risposta API tagliata a MAX_BODY_BYTES', async () => {
  const maxBodyBytes = 8 * 1024 * 1024;
  const responseBody = fakeStreamingResponse(200, ['x'.repeat(maxBodyBytes), 'oltre il cap']);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseBody;
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });

  try {
    const response = await coordinator.submit({
      type: 'api',
      identity: 'test',
      method: 'GET',
      path: '/repos/owner/repo/actions/jobs/123/logs',
      cacheTtlMs: 0,
    });
    // Il body mutilato non viene consegnato: uscirebbe come successo e
    // farebbe esplodere il JSON.parse del chiamante.
    assert.equal(response.ok, false);
    assert.equal(response.truncated, true);
    assert.equal(response.body, '');
    assert.equal(response.error.code, RESPONSE_TRUNCATED_CODE);
    assert.ok(response.error.message.includes(String(maxBodyBytes)), response.error.message);
    // Senza `content-length` la dimensione reale si misura contando lo stream
    // oltre il cap: 8 MiB + 'oltre il cap'. Non deve dire «0 byte».
    assert.equal(response.bodyBytes, maxBodyBytes + 'oltre il cap'.length);
    assert.equal(response.bodyBytesAtLeast, false);
    assert.ok(response.error.message.includes(String(maxBodyBytes + 'oltre il cap'.length)));
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('riconcilia subito una subscription per una PR già mergiata senza aspettare il webhook', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-initial-reconcile-'));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return fakeResponse(200, JSON.stringify({
      number: 42,
      state: 'closed',
      merged: true,
      merged_at: '2026-09-17T01:43:19Z',
      updated_at: '2026-09-17T01:43:19Z',
      head: { sha: 'merged-before-subscribe' },
    }), { 'x-ratelimit-remaining': '100' });
  };
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret: 'initial-reconcile-secret',
  });
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });

  try {
    const result = await coordinator.eventSubscription({
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 42,
      waitFor: ['merged'],
      ttlSeconds: 60,
    });
    assert.deepEqual(calls, ['https://api.github.com/repos/owner/repo/pulls/42']);
    assert.equal(result.reconciliation.source, 'reconciliation');
    assert.equal(result.subscription.pendingEvents, 1);
    assert.equal(broker.pendingEvent(result.subscription.id).state, 'merged');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('recupera un fallimento Actions dopo un webhook mancato della PR', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-pr-failure-reconcile-'));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return fakeResponse(200, JSON.stringify({
        number: 1559,
        state: 'open',
        head: { sha: 'current-head-1559', ref: 'feature-1559' },
        html_url: 'https://github.com/owner/repo/pull/1559',
      }), { 'x-ratelimit-remaining': '100' });
    }
    return fakeResponse(200, JSON.stringify({
      workflow_runs: [
        {
          id: 35321692570,
          name: 'Generator CI',
          status: 'completed',
          conclusion: 'failure',
          head_sha: 'old-head-1559',
          head_branch: 'feature-1559',
          pull_requests: [{ number: 1559 }],
          updated_at: '2026-09-18T07:58:00Z',
        },
        {
          id: 35321692674,
          name: 'tests',
          status: 'completed',
          conclusion: 'failure',
          head_sha: 'old-head-1559',
          head_branch: 'feature-1559',
          pull_requests: [{ number: 1559 }],
          updated_at: '2026-09-18T07:58:17Z',
        },
      ],
    }), { 'x-ratelimit-remaining': '100' });
  };
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret: 'pr-failure-reconcile-secret',
    now: () => Date.parse('2026-09-18T07:56:47Z'),
  });
  const subscription = broker.subscribe({
    repo: 'owner/repo',
    resource: 'pull_request',
    number: 1559,
    waitFor: ['merged', 'failed'],
    ttlSeconds: 60,
  });
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });
  const notified = [];
  coordinator.setEventNotifier((subscriptionId) => notified.push(subscriptionId));

  try {
    const result = await coordinator.reconcileEvents(subscription.id);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /\/actions\/runs\?branch=feature-1559&per_page=100$/);
    assert.equal(result.event.state, 'failed');
    assert.deepEqual(result.matchedSubscriptionIds, [subscription.id]);
    assert.deepEqual(notified, [subscription.id]);
    assert.equal(broker.pendingEvent(subscription.id).runId, '35321692674');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('audita una delivery PR distinguendo target, stato logico e waitFor', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-audit-'));
  const stateFile = join(stateDirectory, 'events.json');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'audit-secret' });

  try {
    const subscription = broker.subscribe({
      agentId: 'audit-agent',
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      resource: 'pull_request',
      number: 8818,
      waitFor: ['merged', 'failed'],
      ttlSeconds: 300,
    });
    const merged = normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'audit-merge-8818',
      receivedAt: '2026-09-16T07:17:24.463Z',
      payload: {
        action: 'closed',
        number: 8818,
        repository: { full_name: 'valerielinc-ops/frontaliere-si-o-no' },
        pull_request: {
          number: 8818,
          merged: true,
          head: { sha: '5fde425359a79a9b3dcbe179f0314a71be97870a' },
        },
      },
    });
    const result = broker.recordEvent(merged);
    assert.equal(merged.state, 'merged');
    assert.deepEqual(result.targetMatchedSubscriptionIds, [subscription.id]);
    assert.deepEqual(result.matchedSubscriptionIds, [subscription.id]);
    const reconciled = normalizeReconciliationEvent({
      subscription,
      data: {
        number: 8818,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-16T07:17:22Z',
        head: { sha: '5fde425359a79a9b3dcbe179f0314a71be97870a' },
      },
      checkedAt: '2026-09-16T07:25:44.000Z',
    });
    assert.deepEqual(
      { action: reconciled.action, state: reconciled.state, states: reconciled.states, number: reconciled.number },
      { action: 'closed', state: 'merged', states: ['merged', 'closed'], number: 8818 },
    );
    assert.equal(eventMatchesSubscription(reconciled, subscription), true);

    const unmatchedState = normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'audit-open-8818',
      receivedAt: '2026-09-16T07:18:24.463Z',
      payload: {
        action: 'opened',
        repository: { full_name: 'valerielinc-ops/frontaliere-si-o-no' },
        pull_request: { number: 8818, merged: false },
      },
    });
    assert.deepEqual(broker.recordEvent(unmatchedState).matchedSubscriptionIds, []);

    const audit = broker.audit({ repo: 'valerielinc-ops/frontaliere-si-o-no', number: 8818, limit: 2 });
    assert.equal(audit.eventCount, 2);
    assert.equal(audit.events[0].deliveryId, 'audit-open-8818');
    assert.equal(audit.events[0].classification, 'target_matched_wait_unmatched');
    assert.equal(audit.events[1].classification, 'matched');
    assert.equal(audit.events[1].state, 'merged');
    assert.deepEqual(audit.events[1].matchedSubscriptionIds, [subscription.id]);

    const restored = new GitHubEventBroker({ stateFile, webhookSecret: 'audit-secret' });
    assert.equal(restored.audit({ number: 8818 }).events.length, 2);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('normalizza e abbina lo stato di conflitto della PR da webhook e riconciliazione', () => {
  const webhook = normalizeWebhookEvent({
    eventName: 'pull_request',
    deliveryId: 'conflict-webhook-1520',
    payload: {
      action: 'synchronize',
      repository: { full_name: 'owner/repo' },
      pull_request: {
        number: 1520,
        mergeable: false,
        mergeable_state: 'dirty',
        head: { sha: 'conflict-head' },
      },
    },
  });
  const subscription = {
    repo: 'owner/repo',
    resource: 'pull_request',
    number: 1520,
    runId: null,
    sha: null,
    branch: null,
    environment: null,
    workflow: null,
    deploymentId: null,
    waitFor: ['conflict'],
  };

  assert.equal(webhook.state, 'conflict');
  assert.deepEqual(webhook.states, ['conflict']);
  assert.equal(webhook.mergeable, false);
  assert.equal(webhook.mergeableState, 'dirty');
  assert.equal(eventMatchesSubscription(webhook, subscription), true);

  const reconciled = normalizeReconciliationEvent({
    subscription,
    checkedAt: '2026-09-16T18:00:00.000Z',
    data: {
      number: 1520,
      state: 'open',
      mergeable: false,
      mergeable_state: 'dirty',
      head: { sha: 'conflict-head' },
    },
  });
  assert.equal(reconciled.state, 'conflict');
  assert.equal(reconciled.action, 'open');
  assert.equal(reconciled.mergeableState, 'dirty');
  assert.equal(eventMatchesSubscription(reconciled, subscription), true);

  const graphqlShape = normalizeWebhookEvent({
    eventName: 'pull_request',
    deliveryId: 'conflict-graphql-shape',
    payload: {
      action: 'opened',
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 1520, mergeable: 'CONFLICTING' },
    },
  });
  assert.equal(graphqlShape.state, 'conflict');
  assert.equal(graphqlShape.mergeable, false);
});

test('normalizza e dispaccia i nuovi commenti conversazionali e inline della PR', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-comments-'));
  const stateFile = join(stateDirectory, 'events.json');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'comment-secret' });

  try {
    const subscription = broker.subscribe({
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 1520,
      waitFor: ['comment'],
      ttlSeconds: 300,
    });
    const issueComment = normalizeWebhookEvent({
      eventName: 'issue_comment',
      deliveryId: 'comment-issue-1520',
      payload: {
        action: 'created',
        repository: { full_name: 'owner/repo' },
        issue: {
          number: 1520,
          html_url: 'https://github.com/owner/repo/pull/1520',
          pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1520' },
        },
        comment: { id: 7001, html_url: 'https://github.com/owner/repo/pull/1520#issuecomment-7001' },
      },
    });
    assert.equal(issueComment.state, 'commented');
    assert.deepEqual(issueComment.states, ['commented']);
    assert.equal(issueComment.number, 1520);
    assert.equal(issueComment.commentId, '7001');
    assert.equal(eventMatchesSubscription(issueComment, subscription), true);
    assert.deepEqual(broker.recordEvent(issueComment).matchedSubscriptionIds, [subscription.id]);

    const reviewComment = normalizeWebhookEvent({
      eventName: 'pull_request_review_comment',
      deliveryId: 'comment-review-1520',
      payload: {
        action: 'created',
        repository: { full_name: 'owner/repo' },
        pull_request: {
          number: 1520,
          html_url: 'https://github.com/owner/repo/pull/1520',
          head: { sha: 'comment-head' },
        },
        comment: { id: 7002, html_url: 'https://github.com/owner/repo/pull/1520#discussion_r7002' },
      },
    });
    assert.equal(reviewComment.state, 'commented');
    assert.equal(reviewComment.commentId, '7002');
    assert.equal(reviewComment.sha, 'comment-head');
    assert.deepEqual(broker.recordEvent(reviewComment).matchedSubscriptionIds, [subscription.id]);

    const submittedReview = normalizeWebhookEvent({
      eventName: 'pull_request_review',
      deliveryId: 'comment-review-submitted-1520',
      payload: {
        action: 'submitted',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 1520 },
        review: { id: 7004, state: 'commented' },
      },
    });
    assert.equal(submittedReview.state, 'commented');
    assert.equal(eventMatchesSubscription(submittedReview, subscription), true);

    const ordinaryIssueComment = normalizeWebhookEvent({
      eventName: 'issue_comment',
      deliveryId: 'comment-issue-ordinary',
      payload: {
        action: 'created',
        repository: { full_name: 'owner/repo' },
        issue: { number: 99 },
        comment: { id: 7003 },
      },
    });
    assert.equal(ordinaryIssueComment, null);
    assert.equal(broker.getSubscription(subscription.id).pendingEvents, 2);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('espone deadline, ETA storica e duplicati senza richiedere polling', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-eta-'));
  const stateFile = join(stateDirectory, 'events.json');
  let nowMs = Date.parse('2026-09-15T12:00:00Z');
  const secret = 'webhook-secret-for-eta-test';
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: secret, now: () => nowMs });

  try {
    for (const [number, waitMs] of [[101, 10_000], [102, 20_000], [103, 30_000]]) {
      const subscription = broker.subscribe({
        agentId: `agent-${number}`,
        repo: 'owner/repo',
        resource: 'pull_request',
        number,
        waitFor: ['merged'],
        ttlSeconds: 300,
      });
      nowMs += waitMs;
      const event = normalizeWebhookEvent({
        eventName: 'pull_request',
        deliveryId: `eta-delivery-${number}`,
        receivedAt: new Date(nowMs).toISOString(),
        payload: {
          action: 'closed',
          repository: { full_name: 'owner/repo' },
          pull_request: { number, merged: true },
        },
      });
      assert.deepEqual(broker.recordEvent(event).matchedSubscriptionIds, [subscription.id]);
      assert.equal(broker.acknowledge(subscription.id, event.id).ok, true);
    }

    const subscription = broker.subscribe({
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 104,
      waitFor: ['merged'],
      ttlSeconds: 300,
    });
    assert.equal(subscription.estimatedWaitMs, 20_000);
    assert.equal(subscription.estimatedWaitP50Ms, 20_000);
    assert.equal(subscription.estimatedWaitP90Ms, 28_000);
    assert.equal(subscription.estimatedWaitSamples, 3);
    assert.equal(subscription.estimateConfidence, 'low');
    assert.equal(subscription.waitState, 'waiting_external');
    assert.equal(subscription.remainingMs, 300_000);

    const joined = broker.subscribe({
      agentId: 'second-agent',
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 104,
      waitFor: ['merged'],
      ttlSeconds: 300,
    });
    assert.equal(joined.id, subscription.id);
    assert.equal(joined.sharedJoin, true);
    assert.equal(joined.sharedObserverCount, 2);
    assert.equal(
      broker.status().subscriptions.filter(({ number }) => number === 104).length,
      1,
    );

    const duplicate = broker.subscribe({
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 104,
      waitFor: ['merged'],
      ttlSeconds: 300,
      allowDuplicate: true,
    });
    assert.equal(duplicate.duplicateTargetCount, 2);
    assert.equal(duplicate.sharedObserverRecommended, true);
    assert.equal(broker.summary().duplicateGroups.length, 1);

    const restored = new GitHubEventBroker({ stateFile, webhookSecret: secret, now: () => nowMs });
    assert.equal(restored.getSubscription(subscription.id).estimatedWaitMs, 20_000);

    nowMs += 301_000;
    assert.ok(restored.expireSubscriptions().includes(subscription.id));
    assert.equal(restored.getSubscription(subscription.id), null);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('conserva una subscription scaduta finché contiene un evento pending', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-pending-expiry-'));
  const stateFile = join(stateDirectory, 'events.json');
  let nowMs = Date.parse('2026-09-15T12:00:00Z');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'pending-expiry-secret', now: () => nowMs });

  try {
    const subscription = broker.subscribe({
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 105,
      waitFor: ['merged'],
      ttlSeconds: 1,
      allowDuplicate: true,
    });
    const event = normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'pending-expiry-105',
      receivedAt: new Date(nowMs).toISOString(),
      payload: {
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 105, merged: true },
      },
    });
    assert.deepEqual(broker.recordEvent(event).matchedSubscriptionIds, [subscription.id]);

    nowMs += 2_000;
    assert.deepEqual(broker.expireSubscriptions(), []);
    assert.equal(broker.metrics.subscriptionsExpired, 0);
    assert.equal(broker.pendingEvent(subscription.id).id, event.id);
    assert.equal(broker.getSubscription(subscription.id).pendingEvents, 1);

    const acknowledgement = broker.acknowledge(subscription.id, event.id);
    assert.equal(acknowledgement.ok, true);
    assert.equal(acknowledgement.subscriptionRemoved, true);
    assert.equal(broker.getSubscription(subscription.id), null);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('normalizza il filename del workflow nel nome visualizzato e mette in cache il lookup', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-workflow-name-'));
  const stateFile = join(stateDirectory, 'events.json');
  let nowMs = Date.parse('2026-09-15T12:00:00Z');
  const broker = new GitHubEventBroker({
    stateFile,
    webhookSecret: 'workflow-name-secret',
    now: () => nowMs,
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    if (requestUrl !== 'https://api.github.com/repos/owner/repo/actions/workflows?per_page=100') {
      assert.match(requestUrl, /\/repos\/owner\/repo\/actions\/runs\?/);
      return fakeResponse(200, JSON.stringify({ workflow_runs: [] }), { 'x-ratelimit-remaining': '100' });
    }
    return fakeResponse(200, JSON.stringify({
      workflows: [{ name: 'Deploy production', path: '.github/workflows/deploy.yml' }],
    }), { 'x-ratelimit-remaining': '100' });
  };

  try {
    for (const [runId, waitMs] of [['9101', 10_000], ['9102', 20_000], ['9103', 30_000]]) {
      const historical = broker.subscribe({
        repo: 'owner/repo',
        resource: 'workflow_run',
        workflow: 'Deploy production',
        branch: 'main',
        runId,
        waitFor: ['success'],
        ttlSeconds: 300,
      });
      nowMs += waitMs;
      const event = normalizeWebhookEvent({
        eventName: 'workflow_run',
        deliveryId: `workflow-name-${runId}`,
        receivedAt: new Date(nowMs).toISOString(),
        payload: {
          action: 'completed',
          repository: { full_name: 'owner/repo' },
          workflow_run: {
            id: runId,
            name: 'Deploy production',
            status: 'completed',
            conclusion: 'success',
            head_branch: 'main',
          },
        },
      });
      assert.deepEqual(broker.recordEvent(event).matchedSubscriptionIds, [historical.id]);
      assert.equal(broker.acknowledge(historical.id, event.id).ok, true);
    }

    const coordinator = new GitHubCoordinator({
      identity: 'test',
      token: 'secret-for-test',
      realGh: '/bin/echo',
      socket: join(stateDirectory, 'coordinator.sock'),
      eventBroker: broker,
    });
    const spec = {
      repo: 'owner/repo',
      resource: 'workflow_run',
      workflow: 'deploy.yml',
      branch: 'main',
      waitFor: ['completed'],
      ttlSeconds: 300,
    };
    const first = await coordinator.eventSubscription(spec);
    assert.equal(first.subscription.workflow, 'Deploy production');
    assert.equal(first.subscription.estimateSource, 'same_repo_workflow');
    assert.equal(first.subscription.estimatedWaitMs, 20_000);

    const second = await coordinator.eventSubscription(spec);
    assert.equal(second.subscription.id, first.subscription.id);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('i comandi help delle subscription non avviano il coordinatore', () => {
  const listenHelp = spawnSync(process.execPath, [join(ROOT, 'bin', 'gh-frontaliere'), 'events', 'listen', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(listenHelp.status, 0);
  assert.match(listenHelp.stdout, /evento o alla scadenza/);

  const subscribeHelp = spawnSync(process.execPath, [join(ROOT, 'bin', 'gh-frontaliere'), 'events', 'subscribe', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(subscribeHelp.status, 0);
  assert.match(subscribeHelp.stdout, /--wait-for/);
  assert.match(subscribeHelp.stdout, /--follow-latest/);
  const waitHelp = spawnSync(process.execPath, [join(ROOT, 'bin', 'gh-frontaliere'), 'events', 'wait', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(waitHelp.status, 0);
  assert.match(waitHelp.stdout, /--run-id/);
  const eventsHelp = spawnSync(process.execPath, [join(ROOT, 'bin', 'gh-frontaliere'), 'events', '--help'], {
    cwd: ROOT,
    env: { ...process.env, FRONTALIERE_GH_STATE_DIR: join(tmpdir(), 'frontaliere-events-help-state') },
    encoding: 'utf8',
  });
  assert.equal(eventsHelp.status, 0);
  assert.match(eventsHelp.stdout, /audit/);
  assert.match(eventsHelp.stdout, /result/);
});

test('mantiene l ultima attività, segnala stalled e rinnova una subscription senza alterare gli interessi', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-liveness-'));
  const stateFile = join(stateDirectory, 'events.json');
  let nowMs = Date.parse('2026-09-15T12:00:00Z');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'liveness-secret', now: () => nowMs });

  try {
    const subscription = broker.subscribe({
      agentId: 'liveness-agent',
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: '9010',
      waitFor: ['success'],
      ttlSeconds: 60,
      stalledAfterMs: 30_000,
    });
    nowMs += 31_000;
    const stalled = broker.getSubscription(subscription.id);
    assert.equal(stalled.stalled, true);
    assert.equal(stalled.waitState, 'stalled');
    assert.equal(stalled.nextAction, 'reconcile_once_or_escalate');

    nowMs += 1_000;
    const running = normalizeWebhookEvent({
      eventName: 'workflow_run',
      deliveryId: 'liveness-running',
      receivedAt: new Date(nowMs).toISOString(),
      payload: {
        action: 'in_progress',
        repository: { full_name: 'owner/repo' },
        workflow_run: { id: 9010, name: 'CI', status: 'in_progress', head_branch: 'main' },
      },
    });
    assert.deepEqual(broker.recordEvent(running).matchedSubscriptionIds, []);
    assert.equal(broker.getSubscription(subscription.id).lastActivityState, 'in_progress');
    assert.equal(broker.getSubscription(subscription.id).stalled, false);

    const oldExpiresAt = Date.parse(broker.getSubscription(subscription.id).expiresAt);
    const renewed = broker.renew(subscription.id, { ttlSeconds: 120, agentId: 'liveness-agent' });
    assert.equal(renewed.ok, true);
    assert.ok(Date.parse(renewed.subscription.expiresAt) > oldExpiresAt);
    assert.equal(renewed.subscription.lastActivityState, 'in_progress');
    assert.equal(broker.metrics.subscriptionsRenewed, 1);
    assert.equal(DEFAULT_STALLED_AFTER_MS > 0, true);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('separa target stalled e listener vivo con heartbeat recente', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-listener-liveness-'));
  const stateFile = join(stateDirectory, 'events.json');
  let nowMs = Date.parse('2026-09-17T12:00:00Z');
  const broker = new GitHubEventBroker({
    stateFile,
    webhookSecret: 'listener-liveness-secret',
    now: () => nowMs,
  });

  try {
    const subscription = broker.subscribe({
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: '9013',
      waitFor: ['success'],
      ttlSeconds: 300,
      stalledAfterMs: 30_000,
    });
    nowMs += 31_000;
    const status = broker.status({
      listenerAttached: new Set([subscription.id]),
      listenerInfo: () => [{ lastHeartbeatAt: new Date(nowMs - 1_000).toISOString() }],
    });
    const current = status.subscriptions[0];
    assert.equal(current.stalled, true);
    assert.equal(current.targetStalled, true);
    assert.equal(current.listenerAlive, true);
    assert.equal(current.listenerHeartbeatRecent, true);
    assert.equal(current.listenerDead, false);
    assert.equal(status.summary.stalledTargetSubscriptions, 1);
    assert.equal(status.summary.listenerAliveSubscriptions, 1);
    assert.equal(status.summary.listenerDeadSubscriptions, 0);
    assert.match(current.compactLine, /listener vivo/);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('rimuove una subscription once dopo l ack di un evento terminale e conserva il result audit', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-once-terminal-'));
  const stateFile = join(stateDirectory, 'events.json');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'once-terminal-secret' });

  try {
    const subscription = broker.subscribe({
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 44,
      waitFor: ['merged'],
      ttlSeconds: 300,
      once: true,
      allowDuplicate: true,
    });
    const event = normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'once-terminal-44',
      payload: {
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 44, merged: true },
      },
    });
    assert.deepEqual(broker.recordEvent(event).matchedSubscriptionIds, [subscription.id]);
    const acknowledgement = broker.acknowledge(subscription.id, event.id);
    assert.equal(acknowledgement.ok, true);
    assert.equal(acknowledgement.subscriptionRemoved, true);
    assert.equal(broker.getSubscription(subscription.id), null);
    assert.equal(broker.status().subscriptions.length, 0);
    const result = broker.audit({ subscriptionId: subscription.id, limit: 1 });
    assert.equal(result.eventCount, 1);
    assert.equal(result.events[0].id, event.id);
    assert.deepEqual(result.events[0].matchedSubscriptionIds, [subscription.id]);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('una subscription one-shot unica non resta shared e viene rimossa dopo l ack', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-single-once-'));
  const stateFile = join(stateDirectory, 'events.json');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'single-once-secret' });
  const coordinator = new GitHubCoordinator({
    identity: 'single-once',
    token: 'test-token',
    realGh: '/bin/echo',
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });

  try {
    const subscription = broker.subscribe({
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 45,
      waitFor: ['merged'],
      ttlSeconds: 300,
    });
    assert.equal(subscription.shared, false);

    const event = normalizeWebhookEvent({
      eventName: 'pull_request',
      deliveryId: 'single-once-45',
      payload: {
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 45, merged: true },
      },
    });
    broker.recordEvent(event);
    const acknowledgement = coordinator.acknowledgeEvent(subscription.id, event.id);

    assert.equal(acknowledgement.ok, true);
    assert.equal(acknowledgement.subscriptionRemoved, true);
    assert.equal(broker.getSubscription(subscription.id), null);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('segue il run successivo quando il run precedente viene cancellato', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-follow-latest-'));
  const stateFile = join(stateDirectory, 'events.json');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'follow-secret' });

  try {
    const subscription = broker.subscribe({
      repo: 'owner/repo',
      resource: 'workflow_run',
      workflow: 'Deploy',
      branch: 'main',
      sha: 'initial-sha',
      waitFor: ['completed'],
      followLatest: true,
      ttlSeconds: 300,
    });
    const cancelled = normalizeWebhookEvent({
      eventName: 'workflow_run',
      deliveryId: 'follow-cancelled',
      payload: {
        action: 'completed',
        repository: { full_name: 'owner/repo' },
        workflow_run: {
          id: 9011,
          name: 'Deploy',
          conclusion: 'cancelled',
          head_branch: 'main',
          head_sha: 'next-sha',
        },
      },
    });
    assert.deepEqual(broker.recordEvent(cancelled).matchedSubscriptionIds, []);
    assert.equal(broker.pendingEvent(subscription.id), null);
    assert.equal(broker.getSubscription(subscription.id).lastActivityState, 'cancelled');

    const success = normalizeWebhookEvent({
      eventName: 'workflow_run',
      deliveryId: 'follow-success',
      payload: {
        action: 'completed',
        repository: { full_name: 'owner/repo' },
        workflow_run: {
          id: 9012,
          name: 'Deploy',
          conclusion: 'success',
          head_branch: 'main',
          head_sha: 'latest-sha',
        },
      },
    });
    assert.deepEqual(broker.recordEvent(success).matchedSubscriptionIds, [subscription.id]);
    assert.equal(broker.pendingEvent(subscription.id).runId, '9012');
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('il garbage collector rimuove solo duplicati orfani dopo una grace period esplicita', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-gc-'));
  const stateFile = join(stateDirectory, 'events.json');
  let nowMs = Date.parse('2026-09-15T12:00:00Z');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'gc-secret', now: () => nowMs });

  try {
    const primary = broker.subscribe({
      agentId: 'primary', repo: 'owner/repo', resource: 'workflow_run', runId: '9001',
      waitFor: ['success'], ttlSeconds: 21_600,
    });
    nowMs += 10_000;
    const duplicate = broker.subscribe({
      agentId: 'stale', repo: 'owner/repo', resource: 'workflow_run', runId: '9001',
      waitFor: ['success'], ttlSeconds: 21_600, allowDuplicate: true,
    });
    const differentInterest = broker.subscribe({
      agentId: 'different-interest', repo: 'owner/repo', resource: 'workflow_run', runId: '9001',
      waitFor: ['failed'], ttlSeconds: 21_600,
    });
    nowMs += 3_600_000;

    const dryRun = broker.garbageCollect({
      listenerAttached: new Set([primary.id]),
      olderThanMs: 3_600_000,
    });
    assert.equal(dryRun.dryRun, true);
    assert.deepEqual(dryRun.removedIds, []);
    assert.deepEqual(dryRun.candidates.map(({ id }) => id), [duplicate.id]);
    assert.equal(dryRun.candidates.some(({ id }) => id === differentInterest.id), false);

    const applied = broker.garbageCollect({
      listenerAttached: new Set([primary.id]),
      olderThanMs: 3_600_000,
      apply: true,
    });
    assert.deepEqual(applied.removedIds, [duplicate.id]);
    assert.equal(broker.getSubscription(duplicate.id), null);
    assert.equal(broker.metrics.subscriptionsGarbageCollected, 1);

    const orphanPrimary = broker.subscribe({
      agentId: 'orphan-primary', repo: 'owner/repo', resource: 'deployment', deploymentId: '77',
      waitFor: ['success'], ttlSeconds: 21_600,
    });
    const orphanDuplicate = broker.subscribe({
      agentId: 'orphan-duplicate', repo: 'owner/repo', resource: 'deployment', deploymentId: '77',
      waitFor: ['success'], ttlSeconds: 21_600, allowDuplicate: true,
    });
    nowMs += 3_600_000;
    const orphanDryRun = broker.garbageCollect({
      listenerAttached: new Set([primary.id]),
      olderThanMs: 3_600_000,
    });
    assert.deepEqual(orphanDryRun.candidates.map(({ id }) => id), [orphanDuplicate.id]);
    const orphanApplied = broker.garbageCollect({
      listenerAttached: new Set([primary.id]),
      olderThanMs: 3_600_000,
      apply: true,
    });
    assert.deepEqual(orphanApplied.removedIds, [orphanDuplicate.id]);
    assert.ok(broker.getSubscription(orphanPrimary.id));
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('il ciclo di expiry raccoglie i duplicati sicuri e protegge l unico pending', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-auto-gc-'));
  const stateFile = join(stateDirectory, 'events.json');
  let nowMs = Date.parse('2026-09-15T12:00:00Z');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'auto-gc-secret', now: () => nowMs });
  const coordinator = new GitHubCoordinator({
    identity: 'auto-gc',
    token: 'test-token',
    realGh: process.execPath,
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });
  coordinator.setEventListenerInspector(() => false);

  try {
    const primary = broker.subscribe({
      repo: 'owner/repo', resource: 'workflow_run', runId: '9001', waitFor: ['success'], ttlSeconds: 21_600,
    });
    const duplicate = broker.subscribe({
      repo: 'owner/repo', resource: 'workflow_run', runId: '9001', waitFor: ['success'],
      ttlSeconds: 21_600, allowDuplicate: true,
    });
    const protectedUnique = broker.subscribe({
      repo: 'owner/repo', resource: 'workflow_run', runId: '9002', waitFor: ['success'], ttlSeconds: 21_600,
    });
    const event = normalizeWebhookEvent({
      eventName: 'workflow_run',
      deliveryId: 'auto-gc-protected',
      receivedAt: new Date(nowMs).toISOString(),
      payload: {
        action: 'completed',
        repository: { full_name: 'owner/repo' },
        workflow_run: { id: 9002, name: 'CI', conclusion: 'success', head_branch: 'main' },
      },
    });
    broker.recordEvent(event);
    nowMs += DEFAULT_ORPHAN_GRACE_MS + 1_000;

    coordinator.expireEventSubscriptions();

    assert.equal(broker.getSubscription(duplicate.id), null);
    assert.ok(broker.getSubscription(primary.id));
    assert.ok(broker.getSubscription(protectedUnique.id));
    assert.equal(broker.pendingEvent(protectedUnique.id).id, event.id);
    assert.equal(broker.metrics.subscriptionsGarbageCollected, 1);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('fan-out shared riusa una subscription canonica', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-events-shared-'));
  const stateFile = join(stateDirectory, 'events.json');
  const broker = new GitHubEventBroker({ stateFile, webhookSecret: 'shared-secret' });

  try {
    const primary = broker.subscribe({
      agentId: 'shared-primary', repo: 'owner/repo', resource: 'pull_request', number: 42,
      waitFor: ['merged'], ttlSeconds: 300, shared: true,
    });
    const joined = broker.subscribe({
      agentId: 'shared-secondary', repo: 'owner/repo', resource: 'pull_request', number: 42,
      waitFor: ['merged'], ttlSeconds: 300, shared: true,
    });
    assert.equal(joined.id, primary.id);
    assert.equal(joined.sharedJoin, true);
    assert.equal(joined.sharedObserverCount, 2);
    assert.equal(broker.status().subscriptions.length, 1);
    assert.deepEqual(
      new GitHubEventBroker({ stateFile, webhookSecret: 'shared-secret' }).getSubscription(primary.id).shared,
      true,
    );
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('classifica il timeout del coordinatore webhook come errore transitorio 503', () => {
  assert.equal(webhookErrorStatus({ code: 'GITHUB_COORDINATOR_TIMEOUT' }), 503);
  assert.equal(webhookErrorStatus({ code: 'ENOSPC' }), 503);
  assert.equal(webhookErrorStatus({ code: 'event_webhook_signature_invalid' }), 401);
  assert.equal(webhookErrorStatus({ code: 'event_webhook_payload_invalid' }), 400);
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
  const notified = [];
  coordinator.setEventNotifier((subscriptionId) => notified.push(subscriptionId));

  try {
    const result = await coordinator.reconcileEvents(subscription.id);
    assert.deepEqual(result.matchedSubscriptionIds, [subscription.id]);
    assert.deepEqual(notified, [subscription.id]);
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

test('la riconciliazione workflow non confonde il titolo display del run con il workflow', () => {
  const subscription = {
    repo: 'owner/repo',
    resource: 'workflow_run',
    runId: '9001',
    sha: 'deadbeef',
    branch: 'transport/fix',
    workflow: 'tests',
    waitFor: ['success'],
  };
  const event = normalizeReconciliationEvent({
    subscription,
    data: {
      id: 9001,
      name: 'Code checks and review · PR #1694 · synchronize',
      path: '.github/workflows/tests.yml',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'transport/fix',
      head_sha: 'deadbeef',
    },
  });

  assert.equal(event.workflow, 'tests');
  assert.equal(eventMatchesSubscription(event, subscription), true);

  const otherWorkflow = normalizeReconciliationEvent({
    subscription,
    data: {
      id: 9002,
      name: 'Code checks and review · PR #1694 · synchronize',
      path: '.github/workflows/other.yml',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'transport/fix',
      head_sha: 'deadbeef',
    },
  });
  assert.equal(eventMatchesSubscription(otherWorkflow, subscription), false);
});

test('un webhook workflow conserva path e workflow_id per il matching della subscription', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-workflow-identifiers-'));
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret: 'workflow-identifiers-secret',
  });
  const subscription = broker.subscribe({
    repo: 'owner/repo',
    resource: 'workflow_run',
    workflow: '12345',
    branch: 'main',
    waitFor: ['success'],
    ttlSeconds: 60,
  });

  try {
    const webhook = normalizeWebhookEvent({
      eventName: 'workflow_run',
      deliveryId: 'workflow-id-12345',
      payload: {
        action: 'completed',
        repository: { full_name: 'owner/repo' },
        workflow_run: {
          id: 9003,
          name: 'Code checks and review · PR #1694 · synchronize',
          workflow_id: 12345,
          path: '.github/workflows/tests.yml',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
        },
      },
    });

    assert.equal(webhook.workflowId, '12345');
    assert.equal(webhook.workflowPath, '.github/workflows/tests.yml');
    assert.deepEqual(broker.recordEvent(webhook).matchedSubscriptionIds, [subscription.id]);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('la riconciliazione per workflow accetta il path REST del workflow', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'frontaliere-workflow-path-reconcile-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.pathname, '/repos/owner/repo/actions/runs');
    assert.equal(requestUrl.searchParams.get('branch'), 'main');
    return fakeResponse(200, JSON.stringify({
      workflow_runs: [{
        id: 9002,
        name: 'Code checks and review · PR #1694 · synchronize',
        path: '.github/workflows/tests.yml',
        status: 'completed',
        conclusion: 'success',
        head_branch: 'main',
        head_sha: 'deadbeef',
        updated_at: '2026-09-15T12:00:00Z',
      }],
    }), { 'x-ratelimit-remaining': '100' });
  };
  const broker = new GitHubEventBroker({
    stateFile: join(stateDirectory, 'events.json'),
    webhookSecret: 'workflow-path-secret',
  });
  const subscription = broker.subscribe({
    repo: 'owner/repo',
    resource: 'workflow_run',
    workflow: 'tests.yml',
    branch: 'main',
    waitFor: ['success'],
    ttlSeconds: 60,
  });
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: '/bin/echo',
    socket: join(stateDirectory, 'coordinator.sock'),
    eventBroker: broker,
  });

  try {
    const result = await coordinator.reconcileEvents(subscription.id);
    assert.deepEqual(result.matchedSubscriptionIds, [subscription.id]);
    assert.equal(broker.pendingEvent(subscription.id).state, 'success');
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

test('ignora un remaining azzerato solo dopo la scadenza del reset', () => {
  const coordinator = new GitHubCoordinator({
    identity: 'test',
    token: 'secret-for-test',
    realGh: process.execPath,
    socket: '/tmp/frontaliere-github-coordinator-test.sock',
  });
  const nowSeconds = Math.floor(Date.now() / 1_000);

  coordinator.buckets.set('core', {
    remaining: '0',
    limit: '5000',
    reset: String(nowSeconds - 60),
  });
  assert.equal(coordinator.effectiveMaxInFlight(), 8);

  coordinator.buckets.set('core', {
    remaining: '0',
    limit: '5000',
    reset: String(nowSeconds + 60),
  });
  assert.equal(coordinator.effectiveMaxInFlight(), 1);

  coordinator.buckets.set('core', {
    remaining: '0',
    limit: '5000',
    reset: 'not-a-number',
  });
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

test('isola un errore di elaborazione su una connessione e mantiene vivo il coordinator', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-coordinator-isolation-');
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  const identity = `connection-isolation-${process.pid}`;
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = 'connection-isolation-secret';

  try {
    await ensureCoordinator(identity);
    const containedFailure = await sendRawCoordinatorLine(identity, 'null');
    assert.equal(containedFailure.ok, false);
    assert.equal(containedFailure.error.code, 'coordinator_error');

    const healthyResponse = await sendRequest({ type: 'ping', compact: true }, { identity });
    assert.equal(healthyResponse.ok, true);
  } finally {
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity, 5_000);
    } catch {
      // Il daemon puo' non avere raggiunto l'avvio; il cleanup resta sicuro.
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('recupera un endpoint Unix residuo prima di riavviare il coordinator', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-coordinator-stale-endpoint-');
  const identity = `stale-endpoint-${process.pid}`;
  const socket = join(stateDirectory, `github-coordinator-${identity}.sock`);
  const previousStateDirectory = process.env.FRONTALIERE_GH_STATE_DIR;
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  writeFileSync(socket, 'stale endpoint');
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'github-coordinator.mjs'), 'serve', '--identity', identity], {
    cwd: ROOT,
    env: {
      ...process.env,
      FRONTALIERE_GH_STATE_DIR: stateDirectory,
      FRONTALIERE_GH_IDENTITY: identity,
      FRONTALIERE_GH_TOKEN: 'test-token-not-real',
      FRONTALIERE_REAL_GH: '/bin/echo',
      FRONTALIERE_GH_WEBHOOK_SECRET: 'stale-endpoint-secret',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const waitForSocket = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if (statSync(socket).isSocket()) return;
      } catch {
        // The stale file is removed before the replacement socket is bound.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error(`coordinator socket did not start: ${stderr}`);
  };

  try {
    await waitForSocket();
    const ping = await sendRequest({ type: 'ping' }, { identity });
    assert.equal(ping.ok, true);
    assert.equal(statSync(socket).isSocket(), true);

    const childExit = new Promise((resolvePromise) => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    });
    await sendRequest({ type: 'shutdown' }, { identity });
    const exit = child.exitCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : await Promise.race([
        childExit,
        new Promise((_, rejectPromise) => setTimeout(
          () => rejectPromise(new Error(`coordinator did not stop: ${stderr}`)),
          3_000,
        )),
      ]);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(existsSync(socket), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { await waitForCoordinatorStop(identity, 3_000); } catch { /* child may already be gone */ }
    if (previousStateDirectory === undefined) delete process.env.FRONTALIERE_GH_STATE_DIR;
    else process.env.FRONTALIERE_GH_STATE_DIR = previousStateDirectory;
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('non lascia il socket quando una connessione resta aperta durante lo shutdown', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-coordinator-shutdown-');
  const identity = `shutdown-idle-${process.pid}`;
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  Object.assign(process.env, {
    FRONTALIERE_GH_STATE_DIR: stateDirectory,
    FRONTALIERE_GH_IDENTITY: identity,
    FRONTALIERE_GH_TOKEN: 'test-token-not-real',
    FRONTALIERE_REAL_GH: '/bin/echo',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'shutdown-secret',
  });
  let idleConnection;

  try {
    await ensureCoordinator(identity);
    idleConnection = createConnection(socketPath(identity));
    await new Promise((resolvePromise, rejectPromise) => {
      idleConnection.once('error', rejectPromise);
      idleConnection.once('connect', resolvePromise);
    });
    await sendRequest({ type: 'shutdown' }, { identity });
    assert.equal(await waitForCoordinatorStop(identity, 5_000), true);
    assert.equal(existsSync(socketPath(identity)), false);
  } finally {
    idleConnection?.destroy();
    try { await waitForCoordinatorStop(identity, 3_000); } catch { /* child may already be gone */ }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
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
      shared: true,
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
    const cleanStatus = await sendRequest({ type: 'status', compact: true }, { identity });
    assert.equal(Object.prototype.hasOwnProperty.call(cleanStatus.status.events, 'webhookSignatureFailures'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(cleanStatus.status.events.metrics, 'webhookSignatureFailures'), false);
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
    const rejectedStatus = await sendRequest({ type: 'status', compact: true }, { identity });
    assert.equal(rejectedStatus.status.events.webhookSignatureFailures, 1);
    assert.ok(rejectedStatus.status.events.lastWebhookSignatureFailureAt);
    const fullStatus = await sendRequest({ type: 'status' }, { identity });
    assert.equal(fullStatus.status.events.webhookSignatureFailures, 1);
    const health = spawnSync(process.execPath, [join(ROOT, 'bin', 'github-coordinator-health.mjs'), '--identity', identity, '--alert-only'], {
      cwd: ROOT,
      env: { ...process.env },
      encoding: 'utf8',
    });
    assert.match(health.stdout, /webhook_signature_rejected/);
    // A public ingress collects stray unsigned POSTs, so a single rejection is a
    // warning and must not turn the daemon red; only a sustained run of them,
    // which is what a real secret mismatch produces, is an alert.
    const healthReport = JSON.parse(health.stdout);
    const rejectionEntry = healthReport.warnings.find((entry) => entry.code === 'webhook_signature_rejected');
    assert.ok(rejectionEntry, 'a single invalid signature is reported as a warning');
    assert.equal(rejectionEntry.count, 1);
    assert.equal(healthReport.alerts.some((entry) => entry.code === 'webhook_signature_rejected'), false);
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
    assert.equal(status.subscriptions.length, 1, 'la shared subscription resta dopo l ack');
    assert.equal((await unsubscribeFromEvents(subscriptionId, { identity })).removed, true);
    const audit = await eventAudit({ repo: 'owner/repo', number: 42, limit: 1 }, { identity });
    assert.equal(audit.events[0].classification, 'matched');
    assert.deepEqual(audit.events[0].matchedSubscriptionIds, [subscriptionId]);
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

test('fan-out shared consegna lo stesso webhook a due agenti senza duplicare la subscription', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-event-shared-');
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  const identity = 'event-shared-integration';
  const secret = 'event-shared-integration-secret';
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = secret;

  try {
    await ensureCoordinator(identity);
    const primary = await subscribeToEvents({
      agentId: 'shared-primary',
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 43,
      waitFor: ['merged'],
      ttlSeconds: 60,
      shared: true,
    }, { identity });
    const joined = await subscribeToEvents({
      agentId: 'shared-secondary',
      repo: 'owner/repo',
      resource: 'pull_request',
      number: 43,
      waitFor: ['merged'],
      ttlSeconds: 60,
      shared: true,
    }, { identity });
    const subscriptionId = primary.subscription.id;
    assert.equal(joined.subscription.id, subscriptionId);
    assert.equal(joined.subscription.sharedJoin, true);
    assert.equal(joined.subscription.sharedObserverCount, 2);

    const firstEvent = listenForEvent(subscriptionId, {
      identity,
      agentId: 'shared-primary',
      timeoutMs: 5_000,
    });
    const secondEvent = listenForEvent(subscriptionId, {
      identity,
      agentId: 'shared-secondary',
      timeoutMs: 5_000,
    });
    let listenerCount = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      listenerCount = (await eventSubscriptions({ identity })).activeListeners;
      if (listenerCount === 2) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.equal(listenerCount, 2);

    const payload = {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 43, merged: true, head: { sha: 'shared-abc123' } },
    };
    const body = JSON.stringify(payload);
    const webhook = await ingestGitHubWebhook({
      eventName: 'pull_request',
      deliveryId: 'shared-delivery-43',
      signature: signedWebhook(body, secret),
      rawBody: body,
    }, { identity });
    assert.deepEqual(webhook.matchedSubscriptionIds, [subscriptionId]);

    const [first, second] = await Promise.all([firstEvent, secondEvent]);
    assert.equal(first.state, 'merged');
    assert.equal(second.state, 'merged');
    const status = await eventSubscriptions({ identity });
    assert.equal(status.pendingEvents, 0);
    assert.equal(status.subscriptions.length, 1, 'l ack dell ultimo listener non disiscrive una shared subscription');
    const unsubscribed = await unsubscribeFromEvents(subscriptionId, { identity });
    assert.equal(unsubscribed.removed, true);
    assert.equal((await eventSubscriptions({ identity })).subscriptions.length, 0);
  } finally {
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity, 5_000);
    } catch {
      // Il daemon puo' non essere partito se il setup fallisce; il cleanup resta sicuro.
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('scollega un listener caduto senza terminare il coordinatore e segnala la scadenza', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-event-resilience-');
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  const identity = 'event-resilience';
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = 'event-resilience-secret';

  try {
    await ensureCoordinator(identity);
    const subscription = (await subscribeToEvents({
      agentId: 'agent-resilience',
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: '9001',
      waitFor: ['success'],
      ttlSeconds: 60,
    }, { identity })).subscription;
    const dropped = createConnection(socketPath(identity));
    await new Promise((resolvePromise, rejectPromise) => {
      dropped.once('error', rejectPromise);
      dropped.once('connect', () => {
        dropped.write(`${JSON.stringify({
          type: 'event-listen',
          identity,
          subscriptionId: subscription.id,
        })}\n`);
      });
      dropped.once('data', () => dropped.destroy());
      dropped.once('close', resolvePromise);
    });

    const status = await sendRequest({ type: 'status', compact: true }, { identity });
    assert.equal(status.status.events.listenerCount, 0);
    assert.equal(status.status.events.orphanedSubscriptions, 1);
    assert.equal(status.status.metrics.socketErrors, 0, 'un reset del listener non è un errore del coordinatore');

    const expiring = (await subscribeToEvents({
      agentId: 'agent-resilience',
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: '9002',
      waitFor: ['success'],
      ttlSeconds: 0.1,
    }, { identity })).subscription;
    await assert.rejects(
      listenForEvent(expiring.id, { identity, timeoutMs: 3_000 }),
      (error) => error.code === 'event_subscription_expired'
        && error.waitState === 'timed_out'
        && error.nextAction === 'reconcile_once_or_escalate'
        && error.subscriptionId === expiring.id,
    );
    const afterExpiry = await eventSubscriptions({ identity });
    assert.equal(afterExpiry.subscriptions.some(({ id }) => id === expiring.id), false);
  } finally {
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

test('riattacca e rinnova una subscription scaduta quando conserva un evento pending', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-event-pending-reconnect-');
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  const identity = 'event-pending-reconnect';
  const secret = 'event-pending-reconnect-secret';
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = secret;

  try {
    await ensureCoordinator(identity);
    const subscription = (await subscribeToEvents({
      agentId: 'agent-pending-reconnect',
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: '9004',
      waitFor: ['success'],
      ttlSeconds: 0.1,
      shared: true,
    }, { identity })).subscription;
    const payload = {
      action: 'completed',
      repository: { full_name: 'owner/repo' },
      workflow_run: {
        id: 9004,
        name: 'CI',
        conclusion: 'success',
        head_sha: 'pending-reconnect-abc123',
      },
    };
    const body = JSON.stringify(payload);
    await ingestGitHubWebhook({
      eventName: 'workflow_run',
      deliveryId: 'pending-reconnect-9004',
      signature: signedWebhook(body, secret),
      rawBody: body,
    }, { identity });
    assert.equal((await eventSubscriptions({ identity })).pendingEvents, 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const expired = await eventSubscriptions({ identity });
    assert.equal(expired.subscriptions.find(({ id }) => id === subscription.id).remainingMs, 0);

    const event = await listenForEvent(subscription.id, {
      identity,
      agentId: 'agent-pending-reconnect',
      timeoutMs: 3_000,
      heartbeatIntervalMs: 20,
      reconcileAfterMs: 0,
    });
    assert.equal(event.state, 'success');
    assert.equal(event.runId, '9004');
    const afterAck = await eventSubscriptions({ identity });
    assert.equal(afterAck.pendingEvents, 0);
    const retained = afterAck.subscriptions.find(({ id }) => id === subscription.id);
    assert.ok(retained);
    assert.ok(retained.lastRenewedAt, 'la lease pending scaduta deve essere rinnovata prima del reattach');
    assert.ok(retained.remainingMs > 0);
    assert.equal((await unsubscribeFromEvents(subscription.id, { identity })).removed, true);
  } finally {
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity, 5_000);
    } catch {
      // Il coordinatore puo' non essere partito se il setup fallisce.
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('riaggancia il listener dopo il riavvio, rinnova la lease e recupera il replay', async () => {
  const stateDirectory = mkdtempSync('/tmp/frontaliere-event-reconnect-');
  const previousEnvironment = {
    FRONTALIERE_GH_STATE_DIR: process.env.FRONTALIERE_GH_STATE_DIR,
    FRONTALIERE_GH_IDENTITY: process.env.FRONTALIERE_GH_IDENTITY,
    FRONTALIERE_GH_TOKEN: process.env.FRONTALIERE_GH_TOKEN,
    FRONTALIERE_REAL_GH: process.env.FRONTALIERE_REAL_GH,
    FRONTALIERE_GH_WEBHOOK_SECRET: process.env.FRONTALIERE_GH_WEBHOOK_SECRET,
  };
  const identity = 'event-reconnect';
  const secret = 'event-reconnect-secret';
  process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
  process.env.FRONTALIERE_GH_IDENTITY = identity;
  process.env.FRONTALIERE_GH_TOKEN = 'test-token-not-real';
  process.env.FRONTALIERE_REAL_GH = '/bin/echo';
  process.env.FRONTALIERE_GH_WEBHOOK_SECRET = secret;

  try {
    await ensureCoordinator(identity);
    const subscription = (await subscribeToEvents({
      agentId: 'agent-reconnect',
      repo: 'owner/repo',
      resource: 'workflow_run',
      runId: '9003',
      waitFor: ['success'],
      ttlSeconds: 60,
    }, { identity })).subscription;
    const eventPromise = listenForEvent(subscription.id, {
      identity,
      agentId: 'agent-reconnect',
      timeoutMs: 5_000,
      heartbeatIntervalMs: 20,
      reconcileAfterMs: 0,
    });
    eventPromise.catch(() => {});
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await eventSubscriptions({ identity });
      if (status.activeListeners === 1) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    let beforeRestart;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      beforeRestart = await eventSubscriptions({ identity });
      if (beforeRestart.metrics.eventListenerHeartbeats > 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.ok(beforeRestart.listenerHeartbeatMetrics.heartbeats > 0);

    await sendRequest({ type: 'shutdown' }, { identity });
    assert.equal(await waitForCoordinatorStop(identity, 5_000), true);

    await ensureCoordinator(identity);
    const payload = {
      action: 'completed',
      repository: { full_name: 'owner/repo' },
      workflow_run: {
        id: 9003,
        name: 'CI',
        conclusion: 'success',
        head_sha: 'reconnect-abc123',
      },
    };
    const body = JSON.stringify(payload);
    await ingestGitHubWebhook({
      eventName: 'workflow_run',
      deliveryId: 'reconnect-delivery-9003',
      signature: signedWebhook(body, secret),
      rawBody: body,
    }, { identity });

    const event = await eventPromise;
    assert.equal(event.state, 'success');
    assert.equal(event.runId, '9003');
    const recoveredStatus = await sendRequest({ type: 'status', compact: true }, { identity });
    assert.equal(recoveredStatus.status.metrics.socketErrors, 0, 'il reconnect dopo il riavvio non deve lasciare errori socket');
  } finally {
    try {
      await sendRequest({ type: 'shutdown' }, { identity });
      await waitForCoordinatorStop(identity, 5_000);
    } catch {
      // Il daemon puo' non avere raggiunto l'avvio; il cleanup resta sicuro.
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('un body oltre il cap locale non esce piu 0 con JSON mutilato', async () => {
  const oversized = `{"sha":"deadbeef","truncated":false,"tree":[{"path":"${'a'.repeat(9 * 1024 * 1024)}"}]}`;
  const bytes = Buffer.byteLength(oversized, 'utf8');
  assert.ok(bytes > 8 * 1024 * 1024, 'il body sintetico deve superare il cap');

  const coordinator = {
    identity: 'default',
    token: 'test-token',
    cache: new Map(),
    metrics: {
      requests: 0,
      cacheHits: 0,
      cacheRevalidations: 0,
      networkRequests: 0,
      anonymousRequests: 0,
    },
    observeBucket() {},
    executeApi: GitHubCoordinator.prototype.executeApi,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(oversized, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(bytes) },
  });

  let result;
  try {
    result = await GitHubCoordinator.prototype.executeParsedApi.call(
      coordinator,
      parseGhApiArguments(['api', 'repos/valerielinc-ops/frontaliere-si-o-no/git/trees/deadbeef?recursive=1']),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Prima della fix: exitCode 0 e stdout con il JSON tagliato a meta' stringa.
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.exitCode, RESPONSE_TRUNCATED_EXIT_CODE);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(RESPONSE_TRUNCATED_CODE), result.stderr);
  assert.ok(result.stderr.includes(String(bytes)), result.stderr);
  assert.ok(result.stderr.includes(String(8 * 1024 * 1024)), result.stderr);
  assert.equal(coordinator.cache.size, 0, 'un body troncato non va messo in cache');
});
