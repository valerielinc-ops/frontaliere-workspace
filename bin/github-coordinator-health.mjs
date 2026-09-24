#!/usr/bin/env node

/**
 * Read-only local health probe for the persistent GitHub coordinators.
 * It never starts a daemon and never calls GitHub.
 */

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  normalizeIdentity,
  probeCoordinator,
  socketPath,
  stateDirectory,
} from './github-coordinator-client.mjs';

export const REQUIRED_COORDINATOR_PROTOCOL = 5;
export const WEBHOOK_SIGNATURE_ALERT_THRESHOLD = 10;
export const LAUNCHD_SPAWN_SCHEDULED_STATE = 'spawn scheduled';
// The compact status serializes the durable event summary. Keep the ordinary
// client connect timeout strict, but give the periodic health probe enough
// room for one transient event-loop/status burst before raising an alert.
export const HEALTH_PROBE_TIMEOUT_MS = 10_000;
export const ALERT_ONLY_REPEAT_MS = 60 * 60 * 1_000;
const DEFAULT_IDENTITIES = ['default', 'nanako'];
const ALERT_ONLY_STATE_FILE = 'github-coordinator-health-alert-only.json';

export function launchdHealthFindings(
  identity,
  launchd,
  { processHealthy = false, socketHealthy = false, probeHealthy = false } = {},
) {
  const state = String(launchd?.state || '').trim().toLowerCase();
  if (!launchd?.supported || state === 'running') {
    return { alerts: [], warnings: [] };
  }
  if (state === LAUNCHD_SPAWN_SCHEDULED_STATE
    && processHealthy
    && socketHealthy
    && probeHealthy) {
    return {
      alerts: [],
      warnings: [{
        code: 'launchd_spawn_scheduled',
        message: `${identity}: launchd spawn is scheduled while the coordinator is healthy`,
      }],
    };
  }
  return {
    alerts: [{
      code: 'launchd_not_running',
      message: `${identity}: launchd state is ${launchd.state}`,
    }],
    warnings: [],
  };
}

export function eventLifecycleHealth(eventSummary, identity) {
  const alerts = [];
  const warnings = [];
  const checks = [
    {
      code: 'orphaned_subscriptions',
      count: Number(eventSummary?.orphanedSubscriptions || 0),
      message: `${identity}: ${eventSummary?.orphanedSubscriptions || 0} subscriptions have no attached listener`,
    },
    {
      code: 'stalled_subscriptions',
      count: Number(eventSummary?.stalledSubscriptions || 0),
      message: `${identity}: ${eventSummary?.stalledSubscriptions || 0} subscriptions have no recent target update`,
    },
  ];
  for (const check of checks) {
    if (check.count <= 0) continue;
    // A listener disappearing is expected when an agent finishes, times out,
    // or is restarted. Likewise a target may remain quiet while no listener
    // is attached. These counters are useful for cleanup/retention, but must
    // not make the coordinator unhealthy or trigger another agent cycle.
    warnings.push(check);
  }
  // The daemon's hourly dry-run GC: pending events without a listener for over
  // an hour mean an agent died waiting.  Keep this high-signal alert separate
  // from the generic orphan/stalled warnings, but expose counts only: the full
  // subscription list belongs to an explicit `status --full` inspection.
  const scheduledGc = eventSummary?.scheduledGc || {};
  const orphanedWithPending = Array.isArray(scheduledGc.orphanedWithPending)
    ? scheduledGc.orphanedWithPending
    : [];
  const orphanedPendingSubscriptionCount = Number(
    scheduledGc.orphanedWithPendingSubscriptionCount ?? orphanedWithPending.length,
  );
  const orphanedPendingEventCount = Number(
    scheduledGc.orphanedWithPendingEventCount
      ?? orphanedWithPending.reduce((total, subscription) => total + Number(subscription.pendingCount || 1), 0),
  );
  if (orphanedPendingSubscriptionCount > 0 || orphanedPendingEventCount > 0) {
    const oldestPendingAt = scheduledGc.orphanedWithPendingOldestAt
      || eventSummary?.oldestPendingAt
      || orphanedWithPending.map(({ pendingSince }) => pendingSince).filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0]
      || null;
    alerts.push({
      code: 'orphaned_pending_events',
      count: orphanedPendingEventCount,
      subscriptionCount: orphanedPendingSubscriptionCount,
      eventCount: orphanedPendingEventCount,
      oldestPendingAt,
      nextAction: 'reattach_or_explicit_ack',
      message: `${identity}: ${orphanedPendingEventCount} pending events across ${orphanedPendingSubscriptionCount} subscriptions have had no listener for over an hour`,
    });
  }
  return { alerts, warnings };
}

function serviceLabel(identity) {
  return `ch.frontaliere.github-coordinator-${normalizeIdentity(identity)}`;
}

function launchdState(identity) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    return { supported: false, state: 'unsupported', pid: null };
  }
  const result = spawnSync('/bin/launchctl', [
    'print',
    `gui/${process.getuid()}/${serviceLabel(identity)}`,
  ], { encoding: 'utf8' });
  if (result.status !== 0) return { supported: true, state: 'not_loaded', pid: null };
  const output = String(result.stdout || '');
  const state = output.match(/^\s*state = ([^\n]+)$/m)?.[1]?.trim() || 'unknown';
  const pid = Number(output.match(/^\s*pid = (\d+)$/m)?.[1] || 0) || null;
  return { supported: true, state, pid };
}

function coordinatorPids(identity) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  const normalized = normalizeIdentity(identity);
  const suffix = new RegExp(`\\bgithub-coordinator\\.mjs serve --identity ${normalized}(?:\\s|$)`);
  return String(result.stdout || '').split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((processInfo) => processInfo && suffix.test(processInfo.command))
    .map(({ pid }) => pid);
}

function socketPresent(identity) {
  try {
    accessSync(socketPath(identity), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkCoordinatorHealth(identity) {
  const normalized = normalizeIdentity(identity);
  const launchd = launchdState(normalized);
  const pids = coordinatorPids(normalized);
  const hasSocket = socketPresent(normalized);
  const alerts = [];
  const warnings = [];
  if (pids.length !== 1) {
    alerts.push({
      code: 'coordinator_process_count',
      message: `${normalized}: expected exactly one coordinator process, found ${pids.length}`,
      pids,
    });
  }
  if (!hasSocket) {
    alerts.push({ code: 'coordinator_socket_missing', message: `${normalized}: coordinator socket is missing` });
  }

  let status = null;
  try {
    const response = await probeCoordinator(normalized, HEALTH_PROBE_TIMEOUT_MS);
    status = response?.status || response;
  } catch (error) {
    alerts.push({ code: 'coordinator_probe_failed', message: `${normalized}: ${error.message}` });
  }
  const launchdHealth = launchdHealthFindings(normalized, launchd, {
    processHealthy: pids.length === 1,
    socketHealthy: hasSocket,
    probeHealthy: status !== null && status !== undefined,
  });
  alerts.push(...launchdHealth.alerts);
  warnings.push(...launchdHealth.warnings);
  if (status) {
    if (Number(status.protocolVersion) < REQUIRED_COORDINATOR_PROTOCOL) {
      alerts.push({
        code: 'coordinator_protocol_outdated',
        message: `${normalized}: protocol ${status.protocolVersion} is below ${REQUIRED_COORDINATOR_PROTOCOL}`,
      });
    }
    if (status.events?.webhookSecretConfigured !== true) {
      alerts.push({ code: 'webhook_secret_unconfigured', message: `${normalized}: webhook secret is not configured` });
    }
    const eventSummary = status.events || {};
    const signatureFailures = Number(eventSummary.webhookSignatureFailures || 0);
    if (signatureFailures > 0) {
      // The ingress is reachable from the public internet, so stray unsigned POSTs
      // are expected background noise and must not paint the daemon red. A real
      // secret mismatch rejects every delivery, so the count climbs past the
      // threshold quickly instead of sitting at one or two.
      const entry = {
        code: 'webhook_signature_rejected',
        count: signatureFailures,
        lastWebhookSignatureFailureAt: eventSummary.lastWebhookSignatureFailureAt || null,
        message: `${normalized}: ${signatureFailures} webhook deliveries were rejected for invalid signatures`,
      };
      (signatureFailures >= WEBHOOK_SIGNATURE_ALERT_THRESHOLD ? alerts : warnings).push(entry);
    }
    const lifecycleHealth = eventLifecycleHealth(eventSummary, normalized);
    alerts.push(...lifecycleHealth.alerts);
    warnings.push(...lifecycleHealth.warnings);
    if (Number(eventSummary.duplicateSubscriptions || 0) > 0) {
      warnings.push({
        code: 'duplicate_subscriptions',
        count: Number(eventSummary.duplicateSubscriptions),
        message: `${normalized}: ${eventSummary.duplicateSubscriptions} duplicate observers are active`,
      });
    }
    if (Number(eventSummary.pendingEvents || 0) > 0) {
      warnings.push({
        code: 'pending_events',
        count: Number(eventSummary.pendingEvents),
        message: `${normalized}: ${eventSummary.pendingEvents} webhook events await acknowledgement`,
      });
    }
    if (Number(status.metrics?.socketErrors || 0) > 0) {
      warnings.push({
        code: 'socket_errors_seen',
        count: Number(status.metrics.socketErrors),
        message: `${normalized}: ${status.metrics.socketErrors} socket errors since process start`,
      });
    }
  }
  return {
    identity: normalized,
    ok: alerts.length === 0,
    alerts,
    warnings,
    launchd,
    pids,
    socketPresent: hasSocket,
    status: status ? {
      protocolVersion: status.protocolVersion,
      webhookSecretConfigured: status.events?.webhookSecretConfigured === true,
      queueLength: status.queueLength,
      active: status.active,
      metrics: status.metrics,
      events: {
        subscriptionCount: status.events?.subscriptionCount,
        pendingEvents: status.events?.pendingEvents,
        pendingSubscriptionCount: status.events?.pendingSubscriptionCount,
        oldestPendingAt: status.events?.oldestPendingAt || null,
        activeListeners: status.events?.activeListeners,
        listenerHeartbeatMetrics: status.events?.listenerHeartbeatMetrics,
        listenerCount: status.events?.listenerCount,
        orphanedSubscriptions: status.events?.orphanedSubscriptions,
        duplicateSubscriptions: status.events?.duplicateSubscriptions,
        stalledSubscriptions: status.events?.stalledSubscriptions,
        ...(status.events?.scheduledGc ? {
          scheduledGc: {
            at: status.events.scheduledGc.at || null,
            olderThanMs: status.events.scheduledGc.olderThanMs,
            orphanCandidateCount: status.events.scheduledGc.orphanCandidateCount,
            orphanedWithPendingSubscriptionCount: Number(
              status.events.scheduledGc.orphanedWithPendingSubscriptionCount || 0,
            ),
            orphanedWithPendingEventCount: Number(
              status.events.scheduledGc.orphanedWithPendingEventCount || 0,
            ),
            orphanedWithPendingOldestAt: status.events.scheduledGc.orphanedWithPendingOldestAt || null,
            nextAction: status.events.scheduledGc.nextAction || 'reattach_or_explicit_ack',
          },
        } : {}),
        ...(Number(status.events?.webhookSignatureFailures || 0) > 0 ? {
          webhookSignatureFailures: Number(status.events.webhookSignatureFailures),
          lastWebhookSignatureFailureAt: status.events.lastWebhookSignatureFailureAt || null,
        } : {}),
      },
    } : null,
  };
}

export async function checkHealth(identities = DEFAULT_IDENTITIES) {
  const normalizedIdentities = identities.map(normalizeIdentity);
  const results = await Promise.all(normalizedIdentities.map(checkCoordinatorHealth));
  return {
    ok: results.every((result) => result.ok),
    checkedAt: new Date().toISOString(),
    alerts: results.flatMap((result) => result.alerts),
    warnings: results.flatMap((result) => result.warnings),
    identities: results,
  };
}

export function alertOnlyHealthReport(result) {
  return {
    ok: result?.ok === true,
    checkedAt: result?.checkedAt || null,
    alerts: Array.isArray(result?.alerts) ? result.alerts : [],
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    ...(result?.strict ? { strict: result.strict } : {}),
  };
}

function normalizedFinding(finding) {
  return {
    code: String(finding?.code || ''),
    // Counts and timestamps are useful in the emitted report but should not
    // turn a persistent incident into a new log line every 30 seconds.
    message: String(finding?.message || '').replace(/\b\d+(?:\.\d+)?\b/g, '#'),
    nextAction: String(finding?.nextAction || ''),
  };
}

export function alertOnlyFingerprint(report) {
  return JSON.stringify({
    ok: report?.ok === true,
    alerts: Array.isArray(report?.alerts) ? report.alerts.map(normalizedFinding) : [],
    warnings: Array.isArray(report?.warnings) ? report.warnings.map(normalizedFinding) : [],
  });
}

function alertOnlyStatePath() {
  return join(stateDirectory(), ALERT_ONLY_STATE_FILE);
}

function readAlertOnlyState(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const emittedAtMs = Number(value?.emittedAtMs);
    return typeof value?.fingerprint === 'string' && Number.isFinite(emittedAtMs)
      ? { fingerprint: value.fingerprint, emittedAtMs }
      : null;
  } catch {
    return null;
  }
}

function writeAlertOnlyState(path, state) {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch { /* best effort: the report remains useful */ }
  }
}

export function clearAlertOnlyState({ statePath = alertOnlyStatePath() } = {}) {
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  return true;
}

/**
 * Return whether an alert-only report should be written by a periodic probe.
 *
 * The health check remains read-only with respect to coordinator state. This
 * tiny local marker only suppresses duplicate log lines from a launchd timer;
 * it contains finding codes/messages, never credentials or event payloads.
 */
export function shouldEmitAlertOnly(
  report,
  {
    nowMs = Date.now(),
    repeatMs = ALERT_ONLY_REPEAT_MS,
    statePath = alertOnlyStatePath(),
  } = {},
) {
  const fingerprint = alertOnlyFingerprint(report);
  const previous = readAlertOnlyState(statePath);
  if (previous
    && previous.fingerprint === fingerprint
    && nowMs - previous.emittedAtMs < repeatMs) return false;
  writeAlertOnlyState(statePath, { fingerprint, emittedAtMs: nowMs });
  return true;
}

function optionValue(args, name) {
  const index = args.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return null;
  return args[index].startsWith(`${name}=`) ? args[index].slice(name.length + 1) : args[index + 1] || null;
}

if (process.argv[1] && process.argv[1].endsWith('/github-coordinator-health.mjs')) {
  const args = process.argv.slice(2);
  const identityOption = optionValue(args, '--identity');
  const identities = identityOption ? [identityOption] : DEFAULT_IDENTITIES;
  const result = await checkHealth(identities);
  const alertOnly = args.includes('--alert-only');
  const dedupe = alertOnly && ['1', 'true', 'yes'].includes(
    String(process.env.FRONTALIERE_GH_HEALTH_DEDUPE || '').toLowerCase(),
  );
  if (alertOnly && dedupe && result.ok) clearAlertOnlyState();
  if (!alertOnly || !result.ok) {
    const output = alertOnly ? alertOnlyHealthReport(result) : result;
    if (!dedupe || shouldEmitAlertOnly(output)) process.stdout.write(`${JSON.stringify(output)}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
