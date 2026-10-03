import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubEventBroker, normalizeReconciliationEvent, normalizeWebhookEvent } from '../bin/github-event-broker.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'follow-latest-activity-'));
  const clock = { now: Date.now() };
  const stateFile = join(directory, 'events.json');
  const broker = new GitHubEventBroker({ stateFile, now: () => clock.now, webhookSecret: 'fixture-secret' });
  t.after(() => { broker.flush(); rmSync(directory, { recursive: true, force: true }); });
  const sub = broker.subscribe({ repo: 'owner/repo', resource: 'workflow_run', workflow: 'Deploy', branch: 'main', followLatest: true, waitFor: ['completed', 'failed'], stalledAfterMs: 1000 });
  return { broker, sub, clock, stateFile };
}
function runEvent(sub, clock, id, status = 'pending', source = 'reconciliation') {
  const data = { id, name: 'Deploy', head_branch: 'main', status: status === 'pending' ? 'pending' : 'completed', conclusion: status === 'pending' ? null : status, created_at: new Date(clock.now - (id === 200 ? 1000 : 2000)).toISOString() };
  return source === 'reconciliation'
    ? normalizeReconciliationEvent({ subscription: { ...sub, runId: String(id) }, data, checkedAt: new Date(clock.now).toISOString() })
    : normalizeWebhookEvent({ eventName: 'workflow_run', deliveryId: `webhook-${id}-${status}`, receivedAt: new Date(clock.now).toISOString(), payload: { action: data.status, repository: { full_name: 'owner/repo' }, workflow_run: data } });
}

test('followLatest does not regress to an older exact-run reconciliation or deliver its success', (t) => {
  const { broker, sub, clock } = fixture(t);
  broker.recordEvent(runEvent(sub, clock, 200));
  clock.now += 100;
  broker.recordEvent(runEvent(sub, clock, 100, 'cancelled'));
  assert.equal(broker.getSubscription(sub.id).lastActivityRunId, '200');
  assert.deepEqual(broker.recordEvent(runEvent(sub, clock, 100, 'success')).matchedSubscriptionIds, []);
  assert.equal(broker.getSubscription(sub.id).pendingEvents, 0);
  assert.deepEqual(broker.recordEvent(runEvent(sub, clock, 200, 'success')).matchedSubscriptionIds, [sub.id]);
});

test('followLatest ignores out-of-order webhooks but exact-run observers still receive theirs', (t) => {
  const { broker, sub, clock } = fixture(t);
  const exact = broker.subscribe({ repo: 'owner/repo', resource: 'workflow_run', runId: '100', waitFor: ['completed'] });
  broker.recordEvent(runEvent(sub, clock, 200, 'pending', 'webhook'));
  clock.now += 100;
  const result = broker.recordEvent(runEvent(sub, clock, 100, 'success', 'webhook'));
  assert.deepEqual(result.matchedSubscriptionIds, [exact.id]);
  assert.equal(broker.getSubscription(sub.id).lastActivityRunId, '200');
});

test('an ignored cancellation does not permanently suppress the stalled recovery signal', (t) => {
  const { broker, sub, clock } = fixture(t);
  broker.recordEvent(runEvent(sub, clock, 200, 'cancelled'));
  assert.equal(broker.getSubscription(sub.id).pendingEvents, 0);
  clock.now += 1001;
  assert.equal(broker.getSubscription(sub.id).nextAction, 'reconcile_once_or_escalate');
});

test('source run creation time beats receipt order and survives broker reload', (t) => {
  const { broker, sub, clock, stateFile } = fixture(t);
  const current = runEvent(sub, clock, 200);
  broker.recordEvent(current);
  broker.flush();
  const restored = new GitHubEventBroker({ stateFile, now: () => clock.now, webhookSecret: 'fixture-secret' });
  clock.now += 100;
  const older = runEvent(sub, clock, 999, 'success');
  older.runCreatedAt = new Date(Date.parse(current.runCreatedAt) - 1000).toISOString();
  assert.deepEqual(restored.recordEvent(older).matchedSubscriptionIds, []);
  assert.equal(restored.getSubscription(sub.id).lastActivityRunId, '200');
  assert.equal(restored.getSubscription(sub.id).lastActivityRunCreatedAt, current.runCreatedAt);
  restored.flush();
});

test('legacy snapshots without creation time keep their numeric run high-water mark', (t) => {
  const { broker, sub, clock } = fixture(t);
  broker.recordEvent(runEvent(sub, clock, 200));
  delete broker.getSubscriptionRecord(sub.id).lastActivityRunCreatedAt;
  clock.now += 100;
  const older = runEvent(sub, clock, 100, 'success');
  delete older.runCreatedAt;
  assert.deepEqual(broker.recordEvent(older).matchedSubscriptionIds, []);
  assert.equal(broker.getSubscription(sub.id).lastActivityRunId, '200');
  const newer = runEvent(sub, clock, 300, 'success');
  delete newer.runCreatedAt;
  assert.deepEqual(broker.recordEvent(newer).matchedSubscriptionIds, [sub.id]);
});


test('legacy import cannot regress a newer workflow or import its stale completion', (t) => {
  const { broker, sub, clock, stateFile } = fixture(t);
  const current = runEvent(sub, clock, 200);
  broker.recordEvent(current);
  broker.flush();
  const legacyFile = stateFile + '.legacy';
  const legacy = JSON.parse(readFileSync(stateFile, 'utf8'));
  clock.now += 100;
  const older = runEvent(sub, clock, 100, 'success');
  Object.assign(legacy.subscriptions[0], {
    id: 'legacy-observer', lastActivityAt: new Date(clock.now).toISOString(),
    lastActivityRunId: '100', lastActivityRunCreatedAt: older.runCreatedAt,
    lastActivityState: 'success', pending: [older],
  });
  writeFileSync(legacyFile, JSON.stringify(legacy));
  const migrated = new GitHubEventBroker({ stateFile, legacyStateFile: legacyFile, now: () => clock.now, webhookSecret: 'fixture-secret' });
  assert.equal(migrated.getSubscription(sub.id).lastActivityRunId, '200');
  assert.equal(migrated.getSubscription(sub.id).pendingEvents, 0);
  assert.deepEqual(migrated.recordEvent(runEvent(sub, clock, 200, 'success')).matchedSubscriptionIds, [sub.id]);
  migrated.flush();
});
