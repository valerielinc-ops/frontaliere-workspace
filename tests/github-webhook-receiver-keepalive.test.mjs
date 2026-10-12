import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGitHubWebhookReceiver,
  WEBHOOK_ORIGIN_KEEP_ALIVE_TIMEOUT_MS,
} from '../bin/github-webhook-receiver.mjs';

test('origin keep-alive outlives Cloudflare Tunnel idle connection expiry', () => {
  const receiver = createGitHubWebhookReceiver({ identity: 'default' });

  assert.equal(receiver.keepAliveTimeout, WEBHOOK_ORIGIN_KEEP_ALIVE_TIMEOUT_MS);
  assert.ok(receiver.keepAliveTimeout > 90_000);
});
