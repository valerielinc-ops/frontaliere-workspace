#!/usr/bin/env node

/**
 * Read-only local health probe for the persistent GitHub coordinators.
 * It never starts a daemon and never calls GitHub.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';

import { normalizeIdentity, probeCoordinator, socketPath } from './github-coordinator-client.mjs';

export const REQUIRED_COORDINATOR_PROTOCOL = 5;
export const EVENT_HEALTH_ALERT_THRESHOLD = 2;
const DEFAULT_IDENTITIES = ['default', 'nanako'];

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
    (check.count >= EVENT_HEALTH_ALERT_THRESHOLD ? alerts : warnings).push(check);
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
  const alerts = [];
  const warnings = [];
  if (launchd.supported && launchd.state !== 'running') {
    alerts.push({ code: 'launchd_not_running', message: `${normalized}: launchd state is ${launchd.state}` });
  }
  if (pids.length !== 1) {
    alerts.push({
      code: 'coordinator_process_count',
      message: `${normalized}: expected exactly one coordinator process, found ${pids.length}`,
      pids,
    });
  }
  if (!socketPresent(normalized)) {
    alerts.push({ code: 'coordinator_socket_missing', message: `${normalized}: coordinator socket is missing` });
  }

  let status = null;
  try {
    const response = await probeCoordinator(normalized);
    status = response?.status || response;
  } catch (error) {
    alerts.push({ code: 'coordinator_probe_failed', message: `${normalized}: ${error.message}` });
  }
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
    if (Number(eventSummary.webhookSignatureFailures || 0) > 0) {
      alerts.push({
        code: 'webhook_signature_rejected',
        count: Number(eventSummary.webhookSignatureFailures),
        lastWebhookSignatureFailureAt: eventSummary.lastWebhookSignatureFailureAt || null,
        message: `${normalized}: ${eventSummary.webhookSignatureFailures} webhook deliveries were rejected for invalid signatures`,
      });
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
    socketPresent: socketPresent(normalized),
    status: status ? {
      protocolVersion: status.protocolVersion,
      webhookSecretConfigured: status.events?.webhookSecretConfigured === true,
      queueLength: status.queueLength,
      active: status.active,
      metrics: status.metrics,
      events: {
        subscriptionCount: status.events?.subscriptionCount,
        pendingEvents: status.events?.pendingEvents,
        activeListeners: status.events?.activeListeners,
        listenerHeartbeatMetrics: status.events?.listenerHeartbeatMetrics,
        listenerCount: status.events?.listenerCount,
        orphanedSubscriptions: status.events?.orphanedSubscriptions,
        duplicateSubscriptions: status.events?.duplicateSubscriptions,
        stalledSubscriptions: status.events?.stalledSubscriptions,
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
  if (!args.includes('--alert-only') || !result.ok) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
