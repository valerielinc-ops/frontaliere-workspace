import assert from 'node:assert/strict';
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
    await run({ post, lines });
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
      ['component', 'durationMs', 'error', 'event', 'identity', 'status', 'ts'],
    );
  });
});

test('stamp prefixes a free-text line with a parsable ISO timestamp', () => {
  const fixed = Date.UTC(2026, 9, 3, 12, 34, 56, 789);
  assert.equal(stamp('x', () => fixed), '2026-10-03T12:34:56.789Z x');
  const match = ISO_PREFIX.exec(stamp('github-webhook-receiver: worker 1 ready'));
  assert.ok(match, 'stamp output must start with an ISO timestamp');
  assert.ok(Number.isFinite(Date.parse(match[1])));
});
