#!/usr/bin/env node

import { parentPort, workerData } from 'node:worker_threads';
import { GitHubEventBroker } from './github-event-broker.mjs';

try {
  // The worker performs validation and legacy-state normalization away from
  // the coordinator's Unix-socket event loop.  Do not load credentials here;
  // the parent attaches the webhook secret after the snapshot is returned.
  const broker = new GitHubEventBroker({
    stateFile: workerData.stateFile,
    legacyStateFile: workerData.legacyStateFile || null,
    webhookSecret: null,
  });
  parentPort.postMessage({ ok: true, state: broker.state });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: error?.code || 'event_state_load_failed',
      message: error?.message || String(error),
    },
  });
}
