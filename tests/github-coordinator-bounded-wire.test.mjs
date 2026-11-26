import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { requestTimeoutMilliseconds, sendRequest } from '../bin/github-coordinator-client.mjs';

const mutation = {
  type: 'bounded-mutation',
  method: 'POST',
  path: '/repos/example/project/issues',
};
const invalid = 'coordinator_mutation_deadline_invalid';
const exceeded = 'coordinator_mutation_deadline_exceeded';

for (const scenario of ['legacy', 'rollback', 'disconnect', 'current', 'cancellation']) {
  test(`bounded client handles the ${scenario} scenario`, async (t) => {
    const requests = [];
    t.mock.method(net, 'createConnection', () => {
      const socket = new EventEmitter();
      socket.end = () => {};
      socket.destroy = () => {};
      socket.write = (line) => {
        const request = JSON.parse(line);
        requests.push(request);
        queueMicrotask(() => {
          if (request.type === 'bounded-mutation' && scenario === 'disconnect') {
            socket.emit('error', Object.assign(new Error('lost socket'), { code: 'ECONNRESET' }));
            return;
          }
          let response = { ok: true };
          if (request.type === 'ping') {
            response.status = {
              mutationDeadlineSupported: true,
              ...(scenario !== 'legacy' ? { boundedMutationWireSupported: true } : {}),
              protocolVersion: scenario === 'cancellation' ? 1 : 5,
            };
          } else if (scenario === 'rollback') {
            response = { ok: false, error: { code: 'unsupported_request_type' } };
          }
          socket.emit('data', JSON.stringify(response) + '\n');
        });
      };
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const priorClient = process.env.FRONTALIERE_AGENT_ID;
    process.env.FRONTALIERE_AGENT_ID = 'bounded-wire-fixture';
    t.after(() => {
      if (priorClient === undefined) delete process.env.FRONTALIERE_AGENT_ID;
      else process.env.FRONTALIERE_AGENT_ID = priorClient;
    });
    const path = scenario === 'cancellation' ? '/repos/example/project/actions/runs/1/cancel' : mutation.path;
    const request = { ...mutation, path, mutationDeadlineAtMs: Date.now() + 10_000 };
    const errors = {
      legacy: 'bounded_mutation_wire_unsupported',
      rollback: 'unsupported_request_type',
      disconnect: 'ECONNRESET',
      cancellation: 'cancellation_confirmation_protocol_unavailable',
    };
    if (errors[scenario]) {
      await assert.rejects(sendRequest(request, { identity: 'default' }), { code: errors[scenario] });
    } else {
      assert.deepEqual(await sendRequest(request, { identity: 'default' }), { ok: true });
    }
    assert.equal(requestTimeoutMilliseconds(request), requestTimeoutMilliseconds({ type: 'api' }));
    assert.deepEqual(requests, ['legacy', 'cancellation'].includes(scenario)
      ? [{ type: 'ping', compact: true }]
      : [{ type: 'ping', compact: true }, { ...request, identity: 'default', client: 'bounded-wire-fixture' }]);
  });
}

function socketRequest(path, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path, () => socket.write(JSON.stringify(request) + '\n'));
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
    });
  });
}

test('daemon enforces the bounded mutation contract at the socket', { timeout: 12_000 }, async (t) => {
  // A short path fits the Unix socket address limit on macOS.
  const directory = await mkdtemp('/tmp/gh-bw-');
  const path = join(directory, 'github-coordinator-default.sock');
  let now = Date.now();
  const preload = `
    import { mock } from 'node:test';

    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: ${now} });
    let releaseFetch;
    process.on('message', (message) => {
      if (message === 'release') {
        releaseFetch(new Response(null, { status: 201 }));
      } else {
        mock.timers.tick(message.advanceMs);
        process.send({ now: Date.now() });
      }
    });

    globalThis.fetch = (_url, options) => {
      const body = JSON.parse(options.body ?? '{}');
      process.send({ method: options.method, body, signal: options.signal instanceof AbortSignal });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        if (body.hold) {
          releaseFetch = resolve;
        } else if (!body.abort) {
          resolve(new Response(null, { status: 201 }));
        }
      });
    };
  `;
  const child = spawn(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(preload),
    fileURLToPath(new URL('../bin/github-coordinator.mjs', import.meta.url)), 'serve', '--identity', 'default',
  ], {
    env: {
      PATH: process.env.PATH,
      FRONTALIERE_GH_STATE_DIR: directory,
      FRONTALIERE_GH_TOKEN: 'fixture-token',
      FRONTALIERE_REAL_GH: process.execPath,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const calls = [];
  child.on('message', (message) => {
    if (Object.hasOwn(message, 'method')) calls.push(message);
  });

  async function advanceClock(advanceMs) {
    const advanced = once(child, 'message');
    child.send({ advanceMs });
    const [message] = await advanced;
    now += advanceMs;
    assert.deepEqual(message, { now });
  }

  const send = (request) => socketRequest(path, request);
  let ping;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      ping = await send({ type: 'ping' });
      break;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED', 'EPERM'].includes(error.code)) throw error;
      if (child.exitCode !== null) break;
      if (error.code === 'EPERM') throw error;
      await delay(25);
    }
  }
  assert.equal(ping?.status?.boundedMutationWireSupported, true, stderr);
  for (const compact of [false, true]) {
    assert.equal((await send({ type: 'status', compact })).status.boundedMutationWireSupported, true);
  }

  const bounded = { ...mutation, mutationDeadlineAtMs: now + 10_000 };
  for (const request of [
    mutation,
    { ...bounded, mutationDeadlineAtMs: null },
    { ...bounded, method: 'GET' },
    { ...bounded, method: 'invalid' },
    { ...bounded, path: '/graphql', body: { query: 'query { viewer { login } }' } },
  ]) {
    assert.deepEqual(await send(request), {
      ok: false, status: 400, headers: {}, body: '',
      error: { code: invalid, message: 'Invalid coordinator mutation deadline', status: 400 },
    });
  }
  assert.equal((await send({ ...bounded, mutationDeadlineAtMs: now - 1 })).error.code, exceeded);
  for (const [method, path, error] of [
    ['POST', '/repos/example/project/actions/runs/1/cancel', 'owner_confirmation_required'],
    ['PUT', '/repos/valerielinc-ops/frontaliere-si-o-no/pulls/1/update-branch', 'update_branch_blocked'],
  ]) {
    assert.equal((await send({ ...bounded, method, path })).error.code, error);
  }
  assert.equal(calls.length, 0);

  const started = once(child, 'message');
  const active = send({ ...bounded, body: { hold: true } });
  const [heldFetch] = await started;
  assert.deepEqual(heldFetch, { method: 'POST', body: { hold: true }, signal: true });
  const queued = send({ ...bounded, mutationDeadlineAtMs: now + 500 });
  // The daemon clock stays frozen while the request travels to the queue.
  let queueLength;
  do {
    queueLength = (await send({ type: 'status', compact: true })).status.queueLength;
    if (queueLength === 0) await delay(10, undefined, { signal: t.signal });
  } while (queueLength === 0);
  assert.equal(queueLength, 1);
  await advanceClock(500);
  assert.equal((await queued).error.code, exceeded);
  assert.equal(calls.length, 1);
  child.send('release');
  assert.equal((await active).status, 201);

  // Move past the mutation scheduler's one-second gap before sending.
  await advanceClock(500);
  const fetching = once(child, 'message');
  const inflight = send({ ...bounded, body: { abort: true }, mutationDeadlineAtMs: now + 2_000 });
  const [inflightFetch] = await fetching;
  assert.deepEqual(inflightFetch, { method: 'POST', body: { abort: true }, signal: true });
  await advanceClock(2_000);
  const uncertain = await inflight;
  assert.equal(uncertain.status, 408);
  assert.equal(uncertain.error.code, exceeded);
  assert.equal(calls.length, 2);
});
