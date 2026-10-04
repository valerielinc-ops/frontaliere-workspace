import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_SLEEP_GAP_MS,
  TUNNEL_NOT_READY_GRACE_MS,
  WEBHOOK_PORTS,
  checkIngress,
  ingressEnabled,
  shouldPrintAlertOnly,
} from '../bin/github-coordinator-health.mjs';

// Every probe is injected: no network, no real process, no file write.
function fakeProbes({
  refusedPorts = [],
  running = true,
  ready = { reachable: true, status: 200, readyConnections: 4 },
} = {}) {
  const calls = { tcp: [], cloudflaredRunning: 0, ready: 0 };
  return {
    calls,
    probes: {
      tcp: async (port) => {
        calls.tcp.push(port);
        return !refusedPorts.includes(port);
      },
      cloudflaredRunning: async () => {
        calls.cloudflaredRunning += 1;
        return running;
      },
      ready: async () => {
        calls.ready += 1;
        return ready;
      },
    },
  };
}

const notReady = { reachable: true, status: 503, readyConnections: 0 };
const codes = (findings) => findings.map((finding) => finding.code);

test('healthy tunnel and listening receivers produce no findings', async () => {
  const { probes, calls } = fakeProbes();
  const result = await checkIngress({ now: 1_000, probes, state: null, enabled: true });
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls.tcp.sort(), Object.values(WEBHOOK_PORTS).sort());
  assert.equal(result.ingress.enabled, true);
  assert.equal(result.ingress.tunnel.running, true);
  assert.equal(result.ingress.tunnel.readyConnections, 4);
  assert.equal(result.ingress.receivers.default.listening, true);
  assert.equal(result.ingress.receivers.nanako.listening, true);
  assert.equal(result.nextState.notReadySinceMs, null);
  assert.equal(result.nextState.lastCheckAtMs, 1_000);
});

test('a refused receiver port raises webhook_receiver_down naming identity and port', async () => {
  const { probes } = fakeProbes({ refusedPorts: [WEBHOOK_PORTS.nanako] });
  const result = await checkIngress({ now: 1_000, probes, enabled: true });
  assert.deepEqual(codes(result.alerts), ['webhook_receiver_down']);
  assert.match(result.alerts[0].message, /nanako/);
  assert.match(result.alerts[0].message, /18788/);
  assert.equal(result.ingress.receivers.nanako.listening, false);
  assert.equal(result.ingress.receivers.default.listening, true);
});

test('an unready tunnel is a warning within the reconnect grace', async () => {
  const { probes } = fakeProbes({ ready: notReady });
  const result = await checkIngress({ now: 0, probes, state: null, enabled: true });
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(codes(result.warnings), ['tunnel_reconnecting']);
  assert.equal(result.nextState.notReadySinceMs, 0);
});

test('an unready tunnel past the grace raises tunnel_not_ready', async () => {
  const { probes } = fakeProbes({ ready: notReady });
  const first = await checkIngress({ now: 0, probes, state: null, enabled: true });
  // 121 s later: past the grace, but well below the sleep gap.
  const now = 121_000;
  assert.ok(now >= TUNNEL_NOT_READY_GRACE_MS && now < HOST_SLEEP_GAP_MS);
  const second = await checkIngress({ now, probes, state: first.nextState, enabled: true });
  assert.deepEqual(codes(second.alerts), ['tunnel_not_ready']);
  assert.equal(codes(second.warnings).includes('tunnel_reconnecting'), false);
  assert.equal(second.nextState.notReadySinceMs, 0);
});

test('a missing cloudflared process raises tunnel_process_missing', async () => {
  const { probes, calls } = fakeProbes({ running: false });
  const result = await checkIngress({ now: 1_000, probes, enabled: true });
  assert.deepEqual(codes(result.alerts), ['tunnel_process_missing']);
  assert.equal(calls.ready, 0);
  assert.equal(result.ingress.tunnel.running, false);
});

test('ingressEnabled guard and a disabled ingress that probes nothing', async () => {
  const home = '/nonexistent-home';
  assert.equal(ingressEnabled({ env: {}, exists: () => false, home }), false);
  assert.equal(ingressEnabled({ env: {}, exists: () => true, home }), true);
  assert.equal(ingressEnabled({ env: { FRONTALIERE_WEBHOOK_INGRESS: '1' }, exists: () => false, home }), true);
  assert.equal(ingressEnabled({ env: { FRONTALIERE_WEBHOOK_INGRESS: '0' }, exists: () => true, home }), false);
  const seen = [];
  ingressEnabled({ env: {}, exists: (path) => { seen.push(path); return false; }, home });
  assert.deepEqual(seen, ['/nonexistent-home/Library/LaunchAgents/com.cloudflare.cloudflared.plist']);

  const { probes, calls } = fakeProbes({
    running: false,
    refusedPorts: Object.values(WEBHOOK_PORTS),
    ready: notReady,
  });
  const result = await checkIngress({ now: 1_000, probes, state: null, enabled: false });
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls.tcp, []);
  assert.equal(calls.ready, 0);
  assert.equal(calls.cloudflaredRunning, 0);
  assert.equal(result.ingress.enabled, false);
});

test('a 4 hour gap between checks records host_slept and restarts the grace', async () => {
  const { probes } = fakeProbes({ ready: notReady });
  const before = Date.UTC(2026, 9, 2, 11, 6, 0);
  const after = before + 4 * 60 * 60 * 1_000;
  const result = await checkIngress({
    now: after,
    probes,
    state: { lastCheckAtMs: before, notReadySinceMs: before - 600_000 },
    enabled: true,
  });
  const slept = result.warnings.find((warning) => warning.code === 'host_slept');
  assert.ok(slept, 'host_slept warning expected');
  assert.equal(slept.gapMs, 14_400_000);
  assert.equal(slept.from, new Date(before).toISOString());
  assert.equal(slept.to, new Date(after).toISOString());
  assert.deepEqual(result.ingress.lastSleepGap, { gapMs: 14_400_000, from: slept.from, to: slept.to });
  // The pre-sleep unready start would be far past the grace: it must not alert.
  assert.equal(codes(result.alerts).includes('tunnel_not_ready'), false);
  assert.equal(result.nextState.notReadySinceMs, null);
  assert.equal(result.nextState.lastCheckAtMs, after);

  // Sleep is recorded even where this host has no ingress.
  const disabled = await checkIngress({
    now: after,
    probes,
    state: { lastCheckAtMs: before },
    enabled: false,
  });
  assert.deepEqual(codes(disabled.warnings), ['host_slept']);
  // Only a host with an ingress can attribute the window to Cloudflare 530.
  assert.match(slept.message, /Cloudflare 530/);
  assert.doesNotMatch(disabled.warnings[0].message, /530/);
});

test('receivers are probed only for the requested identities', async () => {
  const single = fakeProbes();
  const result = await checkIngress({ now: 1_000, probes: single.probes, enabled: true, identities: ['default'] });
  assert.deepEqual(single.calls.tcp, [WEBHOOK_PORTS.default]);
  assert.deepEqual(Object.keys(result.ingress.receivers), ['default']);

  const unknown = fakeProbes();
  const other = await checkIngress({ now: 1_000, probes: unknown.probes, enabled: true, identities: ['test-x'] });
  assert.deepEqual(unknown.calls.tcp, []);
  assert.deepEqual(other.ingress.receivers, {});
  // The tunnel is shared and still checked.
  assert.equal(unknown.calls.cloudflaredRunning, 1);
});

test('a regular 40 s gap is not a sleep', async () => {
  const { probes } = fakeProbes();
  const result = await checkIngress({
    now: 1_000_000 + 40_000,
    probes,
    state: { lastCheckAtMs: 1_000_000, notReadySinceMs: null },
    enabled: true,
  });
  assert.ok(40_000 < HOST_SLEEP_GAP_MS);
  assert.equal(codes(result.warnings).includes('host_slept'), false);
  assert.equal(result.ingress.lastSleepGap, undefined);
});

test('shouldPrintAlertOnly prints unhealthy reports and the healthy sleep report', () => {
  const sleptWarning = { code: 'host_slept', gapMs: 14_400_000, message: 'host slept' };
  assert.equal(shouldPrintAlertOnly({ ok: true, alerts: [], warnings: [sleptWarning] }), true);
  assert.equal(shouldPrintAlertOnly({ ok: true, alerts: [], warnings: [] }), false);
  assert.equal(shouldPrintAlertOnly({
    ok: false,
    alerts: [{ code: 'tunnel_not_ready', message: 'x' }],
    warnings: [],
  }), true);
});
