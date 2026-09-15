#!/usr/bin/env node

/**
 * Small HTTP ingress for GitHub webhooks.
 *
 * Keep this listener behind a TLS reverse proxy or an authenticated tunnel.
 * The coordinator still verifies X-Hub-Signature-256 before accepting data.
 */

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestGitHubWebhook } from './github-coordinator-client.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_PATH = '/github/webhook';

function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('webhook_body_too_large'), { code: 'webhook_body_too_large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createGitHubWebhookReceiver({ identity, path = DEFAULT_PATH } = {}) {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url?.split('?')[0] !== path) {
      jsonResponse(response, 404, { ok: false, error: 'not_found' });
      return;
    }
    try {
      const rawBody = await readBody(request);
      const result = await ingestGitHubWebhook({
        eventName: header(request, 'x-github-event'),
        deliveryId: header(request, 'x-github-delivery'),
        signature: header(request, 'x-hub-signature-256'),
        rawBody,
      }, { identity });
      jsonResponse(response, 202, result);
    } catch (error) {
      const status = error.code === 'event_webhook_signature_invalid' ? 401
        : error.code === 'event_webhook_secret_unconfigured' ? 503
          : error.code === 'webhook_body_too_large' ? 413 : 400;
      jsonResponse(response, status, { ok: false, error: error.code || error.message });
    }
  });
}

function optionValue(args, name, fallback) {
  const index = args.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return fallback;
  return args[index].startsWith(`${name}=`) ? args[index].slice(name.length + 1) : args[index + 1] || fallback;
}

function main() {
  const args = process.argv.slice(2);
  const identity = optionValue(args, '--identity', process.env.FRONTALIERE_GH_IDENTITY);
  const host = optionValue(args, '--host', process.env.FRONTALIERE_WEBHOOK_HOST || DEFAULT_HOST);
  const port = Number(optionValue(args, '--port', process.env.FRONTALIERE_WEBHOOK_PORT || DEFAULT_PORT));
  const path = optionValue(args, '--path', process.env.FRONTALIERE_WEBHOOK_PATH || DEFAULT_PATH);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('webhook_port_invalid');
  const server = createGitHubWebhookReceiver({ identity, path });
  server.on('error', (error) => {
    process.stderr.write(`github-webhook-receiver: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    process.stdout.write(`github-webhook-receiver listening on http://${host}:${port}${path}\n`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`github-webhook-receiver: ${error.message}\n`);
    process.exitCode = 1;
  }
}
