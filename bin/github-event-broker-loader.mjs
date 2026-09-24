#!/usr/bin/env node

// Parse and normalize the durable event state away from the coordinator's
// event loop. The parent receives only the validated broker snapshot; no
// credentials or raw webhook bodies are part of this worker protocol.

import { parentPort, workerData } from 'node:worker_threads';
import { GitHubEventBroker } from './github-event-broker.mjs';

try {
  const broker = new GitHubEventBroker({
    stateFile: workerData.stateFile,
    legacyStateFile: workerData.legacyStateFile || null,
    webhookSecret: null,
    // The worker only reads. A legacy migration is persisted by the owner
    // process once it holds the lock, never by this unguarded bootstrap.
    canPersist: () => false,
    deferMigrationPersist: true,
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
