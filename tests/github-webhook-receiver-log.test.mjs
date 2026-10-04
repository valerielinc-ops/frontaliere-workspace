import assert from 'node:assert/strict';
import { connect } from 'node:net';
import test from 'node:test';

import { createGitHubWebhookReceiver, stamp } from '../bin/github-webhook-receiver.mjs';

const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) /;
const BODY_SENTINEL = 'payload-sentinel-7f3c';
const SIGNATURE_SENTINEL = 'sha256=signature-sentinel-91ab';
const DELIVERY_SENTINEL = 'delivery-sentinel-55d2';

async function withReceiver({ ingest }, run) {
  const lines = [];
  const receiver = createGitHubWebhookReceiver({
    identity: 'default',
    ingest,
    log: (entry) => lines.push(entry),
  });
  await new Promise((resolvePromise, rejectPromise) => {
    receiver.once('error', rejectPromise);
    receiver.listen(0, '127.0.0.1', resolvePromise);
  });
  try {
    const { port } = receiver.address();
    const post = (path = '/github/webhook') => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': DELIVERY_SENTINEL,
        'x-hub-signature-256': SIGNATURE_SENTINEL,
      },
      body: JSON.stringify({ secret: BODY_SENTINEL }),
    });
    await run({ post, lines, port });
  } finally {
    await new Promise((resolvePromise) => receiver.close(resolvePromise));
  }
}

function rejectWith(fields) {
  return async () => {
    throw Object.assign(new Error(`rejected ${BODY_SENTINEL}`), fields);
  };
}

test('a 503 from an unreachable coordinator leaves one timestamped webhook_response line', async () => {
  await withReceiver({ ingest: rejectWith({ code: 'ECONNREFUSED' }) }, async ({ post, lines }) => {
    const response = await post();
    assert.equal(response.status, 503);
    await response.text();
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(line.event, 'webhook_response');
    assert.equal(line.component, 'github-webhook-receiver');
    assert.equal(line.identity, 'default');
    assert.equal(line.status, 503);
    assert.equal(line.error, 'ECONNREFUSED');
    assert.equal(line.phase, 'ingest');
    assert.equal(typeof line.durationMs, 'number');
    assert.ok(line.durationMs >= 0);
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(line.ts).toISOString(), line.ts);
  });
});

test('a 400 for a payload the coordinator rejected is logged', async () => {
  await withReceiver({ ingest: rejectWith({ code: 'event_webhook_payload_invalid' }) }, async ({ post, lines }) => {
    const response = await post();
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 400);
    assert.equal(lines[0].error, 'event_webhook_payload_invalid');
  });
});

test('an accepted delivery (202) writes no log line', async () => {
  await withReceiver({ ingest: async () => ({ ok: true }) }, async ({ post, lines }) => {
    const response = await post();
    assert.equal(response.status, 202);
    await response.text();
    assert.deepEqual(lines, []);
  });
});

test('public ingress noise (401 bad signature, 404 wrong path) writes no log line', async () => {
  await withReceiver({ ingest: rejectWith({ code: 'event_webhook_signature_invalid' }) }, async ({ post, lines }) => {
    const unauthorized = await post();
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    const notFound = await post('/not-the-webhook');
    assert.equal(notFound.status, 404);
    await notFound.text();
    assert.deepEqual(lines, []);
  });
});

test('the log line carries no payload, signature or delivery id', async () => {
  await withReceiver({ ingest: rejectWith({ code: 'github_coordinator_timeout' }) }, async ({ post, lines }) => {
    const response = await post();
    assert.equal(response.status, 503);
    await response.text();
    assert.equal(lines.length, 1);
    const serialized = JSON.stringify(lines[0]);
    for (const sentinel of [BODY_SENTINEL, SIGNATURE_SENTINEL, DELIVERY_SENTINEL, 'x-hub-signature-256', 'x-github-delivery']) {
      assert.equal(serialized.includes(sentinel), false, `log line leaks ${sentinel}`);
    }
    assert.deepEqual(
      Object.keys(lines[0]).sort(),
      ['component', 'durationMs', 'error', 'event', 'identity', 'phase', 'status', 'ts'],
    );
  });
});

test('an error without a code is logged by class name, never by its message', async () => {
  const ingest = async () => {
    throw new Error(`github coordinator unavailable near ${BODY_SENTINEL}`);
  };
  await withReceiver({ ingest }, async ({ post, lines }) => {
    const response = await post();
    assert.equal(response.status, 503);
    await response.text();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].error, 'uncoded:Error');
    assert.equal(JSON.stringify(lines[0]).includes(BODY_SENTINEL), false);
  });
});

test('a client abort while the body is read is logged with phase read_body', async () => {
  let ingested = false;
  const ingest = async () => {
    ingested = true;
    return { ok: true };
  };
  await withReceiver({ ingest }, async ({ lines, port }) => {
    await new Promise((resolvePromise, rejectPromise) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write([
          'POST /github/webhook HTTP/1.1',
          'host: 127.0.0.1',
          'content-type: application/json',
          'content-length: 1000',
          '',
          '{"partial":',
        ].join('\r\n'));
        setTimeout(() => socket.destroy(), 50);
      });
      socket.on('error', () => {});
      socket.on('close', resolvePromise);
      socket.setTimeout(5_000, () => rejectPromise(new Error('socket timeout')));
    });
    const deadline = Date.now() + 5_000;
    while (lines.length === 0 && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.equal(ingested, false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 503);
    assert.equal(lines[0].phase, 'read_body');
    assert.equal(lines[0].error, 'ECONNRESET');
  });
});

test('stamp prefixes a free-text line with a parsable ISO timestamp', () => {
  const fixed = Date.UTC(2026, 9, 3, 12, 34, 56, 789);
  assert.equal(stamp('x', () => fixed), '2026-10-03T12:34:56.789Z x');
  const match = ISO_PREFIX.exec(stamp('github-webhook-receiver: worker 1 ready'));
  assert.ok(match, 'stamp output must start with an ISO timestamp');
  assert.ok(Number.isFinite(Date.parse(match[1])));
});
