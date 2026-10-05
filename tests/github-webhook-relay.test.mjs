import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  RELAY_HEADER,
  createGitHubWebhookReceiver,
  createWebhookRelay,
  parseRelayTargets,
  receiverOptions,
  shouldRelayStatus,
} from '../bin/github-webhook-receiver.mjs';

const BODY = JSON.stringify({ action: 'closed', number: 42 });
const DELIVERY = { eventName: 'pull_request', deliveryId: 'relay-delivery-1', signature: 'sha256=abc', rawBody: BODY };

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

// A peer receiver: records what it got and answers with the given statuses in turn.
async function withPeer(statuses, run) {
  const received = [];
  let call = 0;
  const peer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const port = await listen(peer);
  try {
    await run({ url: `http://127.0.0.1:${port}/github/webhook`, received });
  } finally {
    await close(peer);
  }
}

test('parseRelayTargets accepts repeated and comma-separated http(s) URLs and drops duplicates', () => {
  assert.deepEqual(
    parseRelayTargets(['http://100.1.2.3:18787/github/webhook,https://peer.example/github/webhook', '', 'http://100.1.2.3:18787/github/webhook']),
    ['http://100.1.2.3:18787/github/webhook', 'https://peer.example/github/webhook'],
  );
  assert.throws(() => parseRelayTargets(['not a url']), { code: 'webhook_relay_url_invalid' });
  assert.throws(() => parseRelayTargets(['file:///etc/passwd']), { code: 'webhook_relay_url_invalid' });
});

test('receiverOptions reads relays and extra hosts from flags and environment', () => {
  const options = receiverOptions(
    ['--identity', 'default', '--port', '18787', '--relay', 'http://100.1.2.3:18787/github/webhook', '--extra-host', '100.9.9.9', '--extra-host=127.0.0.1'],
    { FRONTALIERE_WEBHOOK_RELAYS: 'http://100.4.5.6:18787/github/webhook', FRONTALIERE_WEBHOOK_EXTRA_HOSTS: '100.9.9.9' },
  );
  assert.equal(options.host, '127.0.0.1');
  assert.deepEqual(options.extraHosts, ['100.9.9.9']);
  assert.deepEqual(options.relays, ['http://100.1.2.3:18787/github/webhook', 'http://100.4.5.6:18787/github/webhook']);
  assert.deepEqual(receiverOptions(['--port', '18787'], {}).relays, []);
});

test('only accepted deliveries and coordinator failures are relayed', () => {
  assert.equal(shouldRelayStatus(202), true);
  assert.equal(shouldRelayStatus(503), true);
  for (const status of [null, 400, 401, 404, 413]) assert.equal(shouldRelayStatus(status), false);
});

test('the relay forwards body, GitHub headers and signature unchanged, marked as relayed', async () => {
  await withPeer([202], async ({ url, received }) => {
    const relay = createWebhookRelay({ targets: [url], log: () => assert.fail('no failure expected') });
    assert.deepEqual(await relay.forward(DELIVERY, { identity: 'default' }), [true]);
    assert.equal(received.length, 1);
    const [{ headers, body }] = received;
    assert.equal(body, BODY);
    assert.equal(headers['x-github-event'], 'pull_request');
    assert.equal(headers['x-github-delivery'], 'relay-delivery-1');
    assert.equal(headers['x-hub-signature-256'], 'sha256=abc');
    assert.equal(headers[RELAY_HEADER], '1');
  });
});

test('a 5xx from the peer is retried, a 4xx is not, and a final failure is logged without the delivery', async () => {
  await withPeer([503, 503, 202], async ({ url, received }) => {
    const relay = createWebhookRelay({ targets: [url], sleep: async () => {}, log: () => assert.fail('no failure expected') });
    assert.deepEqual(await relay.forward(DELIVERY), [true]);
    assert.equal(received.length, 3);
  });
  await withPeer([401], async ({ url, received }) => {
    const lines = [];
    const relay = createWebhookRelay({ targets: [url], sleep: async () => {}, log: (entry) => lines.push(entry) });
    assert.deepEqual(await relay.forward(DELIVERY, { identity: 'nanako' }), [false]);
    assert.equal(received.length, 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'webhook_relay_failed');
    assert.equal(lines[0].identity, 'nanako');
    assert.equal(lines[0].error, 'http_401');
    assert.equal(lines[0].attempts, 1);
    assert.equal(lines[0].target, new URL(url).origin);
    const serialized = JSON.stringify(lines[0]);
    assert.doesNotMatch(serialized, /relay-delivery-1|sha256=abc|closed/);
  });
});

test('an unreachable peer is retried and then logged', async () => {
  const lines = [];
  const relay = createWebhookRelay({
    targets: ['http://127.0.0.1:9/github/webhook'],
    sleep: async () => {},
    retryDelaysMs: [1, 1],
    log: (entry) => lines.push(entry),
  });
  assert.deepEqual(await relay.forward(DELIVERY), [false]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].attempts, 3);
});

async function withRelayingReceiver({ ingest }, run) {
  const forwarded = [];
  const relay = { forward: async (delivery, context) => { forwarded.push({ delivery, context }); return [true]; } };
  const receiver = createGitHubWebhookReceiver({ identity: 'default', ingest, relay, log: () => {} });
  const port = await listen(receiver);
  const post = (extraHeaders = {}) => fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: 'POST',
    headers: {
      'x-github-event': DELIVERY.eventName,
      'x-github-delivery': DELIVERY.deliveryId,
      'x-hub-signature-256': DELIVERY.signature,
      ...extraHeaders,
    },
    body: BODY,
  });
  try {
    await run({ post, forwarded });
  } finally {
    await close(receiver);
  }
}

const settle = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

test('the receiver relays an accepted delivery after answering 202', async () => {
  await withRelayingReceiver({ ingest: async () => ({ ok: true }) }, async ({ post, forwarded }) => {
    const response = await post();
    assert.equal(response.status, 202);
    await response.text();
    await settle();
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0].delivery, DELIVERY);
    assert.equal(forwarded[0].context.identity, 'default');
  });
});

test('the receiver relays when its own coordinator is unavailable', async () => {
  const ingest = async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
  await withRelayingReceiver({ ingest }, async ({ post, forwarded }) => {
    const response = await post();
    assert.equal(response.status, 503);
    await response.text();
    await settle();
    assert.equal(forwarded.length, 1);
  });
});

test('the receiver does not relay a rejected signature or an already relayed delivery', async () => {
  const ingest = async () => { throw Object.assign(new Error('bad'), { code: 'event_webhook_signature_invalid' }); };
  await withRelayingReceiver({ ingest }, async ({ post, forwarded }) => {
    const response = await post();
    assert.equal(response.status, 401);
    await response.text();
    await settle();
    assert.equal(forwarded.length, 0);
  });
  await withRelayingReceiver({ ingest: async () => ({ ok: true }) }, async ({ post, forwarded }) => {
    const response = await post({ [RELAY_HEADER]: '1' });
    assert.equal(response.status, 202);
    await response.text();
    await settle();
    assert.equal(forwarded.length, 0);
  });
});
