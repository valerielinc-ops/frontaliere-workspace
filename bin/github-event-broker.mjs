#!/usr/bin/env node

/**
 * Durable, local event broker for GitHub webhooks.
 *
 * GitHub delivers at-least-once.  A subscription therefore keeps a compact
 * normalized event until its listener acknowledges it.  Raw webhook bodies
 * and credentials are never written to the state file.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const EVENT_BROKER_STATE_VERSION = 1;
export const DEFAULT_SUBSCRIPTION_TTL_MS = 6 * 60 * 60 * 1_000;
export const MAX_SUBSCRIPTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1_000;
export const DEFAULT_STALLED_AFTER_MS = 4 * 60 * 60 * 1_000;

const MAX_PENDING_EVENTS = 32;
const MAX_SEEN_DELIVERIES = 5_000;
const MAX_EVENT_AUDIT = 256;
const SEEN_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_LATENCY_SAMPLES = 200;
const MIN_ESTIMATE_SAMPLES = 3;
const TERMINAL_STATES = new Set([
  'cancelled', 'completed', 'failed', 'merged', 'neutral', 'skipped', 'success',
]);

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedState(value) {
  const state = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  const aliases = {
    changes_requested: 'needs_review',
    comment: 'commented',
    new_comment: 'commented',
    conflicting: 'conflict',
    dirty: 'conflict',
    merge_conflict: 'conflict',
    mergeable_conflict: 'conflict',
    error: 'failed',
    failure: 'failed',
    timed_out: 'failed',
    startup_failure: 'failed',
  };
  return aliases[state] || state;
}

function normalizedCommentId(value) {
  return value === null || value === undefined ? null : String(value);
}

const MERGE_CONFLICT_STATES = new Set([
  'dirty',
  'conflicting',
  'merge_conflict',
  'mergeable_conflict',
]);

function normalizedMergeableState(value) {
  const state = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return state || null;
}

function normalizedMergeable(value) {
  if (value === true || value === false) return value;
  const state = normalizedMergeableState(value);
  if (state === 'mergeable') return true;
  if (state === 'conflicting') return false;
  return null;
}

function pullRequestMergeability(pullRequest) {
  const mergeableState = normalizedMergeableState(
    pullRequest?.mergeable_state ?? pullRequest?.mergeableState,
  );
  const mergeable = normalizedMergeable(pullRequest?.mergeable);
  const conflict = MERGE_CONFLICT_STATES.has(mergeableState)
    || normalizedMergeableState(pullRequest?.mergeable) === 'conflicting';
  return { mergeable, mergeableState, conflict };
}

function canonicalResource(value) {
  const resource = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  const aliases = {
    pr: 'pull_request',
    pull_request_review: 'pull_request',
    workflow: 'workflow_run',
    ci: 'workflow_run',
    deploy: 'deployment',
    deployment_status: 'deployment',
  };
  return aliases[resource] || resource;
}

function validRepo(value) {
  const repo = normalizedString(value);
  return repo && /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : null;
}

function subscriptionStates(spec) {
  const raw = spec.waitFor ?? spec.wait_for ?? spec.states;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw brokerError('event_wait_for_required', 'event subscription requires waitFor states');
  }
  const states = unique(raw.map(normalizedState));
  if (states.length === 0) {
    throw brokerError('event_wait_for_required', 'event subscription requires waitFor states');
  }
  return states;
}

function parseExpiration(spec, nowMs) {
  const requestedTtl = Number(spec.expiresInMs ?? spec.ttlMs ?? (
    spec.ttlSeconds === undefined ? DEFAULT_SUBSCRIPTION_TTL_MS : Number(spec.ttlSeconds) * 1_000
  ));
  if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) {
    throw brokerError('event_ttl_invalid', 'event subscription TTL must be positive');
  }
  const ttl = Math.min(MAX_SUBSCRIPTION_TTL_MS, requestedTtl);
  const explicit = spec.expiresAt ? Date.parse(String(spec.expiresAt)) : NaN;
  const expiresAtMs = Number.isFinite(explicit)
    ? Math.min(explicit, nowMs + MAX_SUBSCRIPTION_TTL_MS)
    : nowMs + ttl;
  if (expiresAtMs <= nowMs) {
    throw brokerError('event_ttl_expired', 'event subscription expiration must be in the future');
  }
  return expiresAtMs;
}

function parseStalledAfter(spec) {
  const requested = Number(spec.stalledAfterMs ?? (
    spec.stalledAfterSeconds === undefined
      ? DEFAULT_STALLED_AFTER_MS
      : Number(spec.stalledAfterSeconds) * 1_000
  ));
  if (!Number.isFinite(requested) || requested <= 0) {
    throw brokerError('event_stalled_after_invalid', 'event stalled threshold must be positive');
  }
  return Math.min(MAX_SUBSCRIPTION_TTL_MS, requested);
}

function subscriptionTargetKey(subscription) {
  const selectors = [
    ['number', subscription.number],
    ['run', subscription.runId],
    ['sha', subscription.sha],
    ['branch', subscription.branch],
    ['environment', subscription.environment],
    ['workflow', subscription.workflow],
    ['deployment', subscription.deploymentId],
  ].map(([name, value]) => `${name}=${value === null || value === undefined ? '*' : value}`);
  return `${subscription.repo}|${subscription.resource}|${selectors.join('|')}|followLatest=${subscription.followLatest === true}`;
}

function subscriptionDedupKey(subscription) {
  return `${subscriptionTargetKey(subscription)}|wait=${[...subscription.waitFor].sort().join(',')}`;
}

function latencySampleKey(subscription) {
  return [
    subscription.repo,
    subscription.resource,
    subscription.workflow || '*',
    subscription.branch || '*',
    [...subscription.waitFor].sort().join(','),
  ].join(':');
}

function listenerAttachedValue(listenerAttached, subscriptionId) {
  if (typeof listenerAttached === 'function') {
    const value = listenerAttached(subscriptionId);
    return typeof value === 'boolean' ? value : null;
  }
  if (listenerAttached instanceof Set) return listenerAttached.has(subscriptionId);
  if (Array.isArray(listenerAttached)) return listenerAttached.includes(subscriptionId);
  return null;
}

function listenerInfoValue(listenerInfo, subscriptionId) {
  if (typeof listenerInfo === 'function') {
    const value = listenerInfo(subscriptionId);
    return Array.isArray(value) ? value : value ? [value] : [];
  }
  return [];
}

function targetMatchesFilter(subscription, filters = {}) {
  if (filters.repo && subscription.repo !== filters.repo) return false;
  if (filters.resource && subscription.resource !== canonicalResource(filters.resource)) return false;
  if (filters.runId && String(subscription.runId) !== String(filters.runId)) return false;
  if (filters.number !== undefined && filters.number !== null && subscription.number !== Number(filters.number)) return false;
  for (const key of ['sha', 'branch', 'environment', 'workflow', 'deploymentId']) {
    if (filters[key] && subscription[key] !== String(filters[key])) return false;
  }
  if (filters.agentId) {
    const agents = subscription.shared
      ? subscription.sharedAgentIds
      : [subscription.agentId];
    if (!agents.includes(String(filters.agentId))) return false;
  }
  return true;
}

function formatAge(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'n/d';
  if (milliseconds < 60_000) return `${Math.max(0, Math.round(milliseconds / 1_000))}s fa`;
  if (milliseconds < 60 * 60_000) return `${Math.round(milliseconds / 60_000)}m fa`;
  return `${Math.round(milliseconds / (60 * 60_000))}h fa`;
}

function compactSubscriptionLine(subscription) {
  const target = subscription.runId
    ? `run ${subscription.runId}`
    : subscription.number
      ? `PR #${subscription.number}`
      : subscription.repo;
  const state = subscription.stalled ? 'stalled' : subscription.waitState;
  const latestHeartbeat = (subscription.listenerInfo || [])
    .map((listenerInfo) => Date.parse(listenerInfo.lastHeartbeatAt || ''))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  const listener = subscription.listenerAttached === true
    ? `listener OK · heartbeat ${latestHeartbeat ? formatAge(Date.now() - latestHeartbeat) : 'n/d'}`
    : subscription.listenerAttached === false
      ? 'listener assente'
      : 'listener n/d';
  const last = Number.isFinite(subscription.staleSinceMs)
    ? formatAge(subscription.staleSinceMs)
    : subscription.lastActivityAt || subscription.observedAt || subscription.createdAt;
  return `${target}: ${state} · ultimo aggiornamento ${last || 'n/d'} · ${listener}`;
}

function subscriptionIsStalled(subscription, nowMs) {
  const lastActivityMs = Date.parse(subscription.lastActivityAt || '');
  const staleSinceMs = Number.isFinite(lastActivityMs)
    ? Math.max(0, nowMs - lastActivityMs)
    : null;
  return subscription.pending.length === 0
    && staleSinceMs !== null
    && staleSinceMs >= subscription.stalledAfterMs
    && !TERMINAL_STATES.has(subscription.lastActivityState);
}

function selectedSubscription(subscription, filters, listenerAttached, nowMs) {
  if (!targetMatchesFilter(subscription, filters)) return false;
  if (filters.active === true && listenerAttachedValue(listenerAttached, subscription.id) !== true) return false;
  if (filters.pendingOnly === true && subscription.pending.length === 0) return false;
  if (filters.stalledOnly === true && !subscriptionIsStalled(subscription, nowMs)) return false;
  return true;
}

function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function summarizeWaitEstimate(samples, source = 'none') {
  const values = samples.map((sample) => Number(sample.waitMs)).filter((value) => Number.isFinite(value));
  if (values.length < MIN_ESTIMATE_SAMPLES) {
    return {
      estimatedWaitMs: null,
      estimatedWaitP50Ms: null,
      estimatedWaitP90Ms: null,
      estimatedWaitSamples: values.length,
      estimateConfidence: values.length ? 'insufficient' : 'none',
      estimateSource: values.length ? source : 'none',
    };
  }
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const confidence = values.length >= 20 ? 'high' : values.length >= 10 ? 'medium' : 'low';
  return {
    estimatedWaitMs: Math.round(mean),
    estimatedWaitP50Ms: Math.round(quantile(values, 0.5)),
    estimatedWaitP90Ms: Math.round(quantile(values, 0.9)),
    estimatedWaitSamples: values.length,
    estimateConfidence: confidence,
    estimateSource: source,
  };
}

function normalizeSubscriptionSpec(spec, nowMs) {
  if (!spec || typeof spec !== 'object') {
    throw brokerError('event_subscription_invalid', 'event subscription must be an object');
  }
  const repo = validRepo(spec.repo);
  if (!repo) throw brokerError('event_repo_invalid', 'event subscription requires owner/repo');
  const resource = canonicalResource(spec.resource);
  if (!['pull_request', 'workflow_run', 'deployment'].includes(resource)) {
    throw brokerError('event_resource_invalid', `unsupported event resource: ${spec.resource}`);
  }
  const expiresAtMs = parseExpiration(spec, nowMs);
  const stalledAfterMs = parseStalledAfter(spec);
  const number = spec.number === undefined || spec.number === null ? null : Number(spec.number);
  if (number !== null && (!Number.isInteger(number) || number <= 0)) {
    throw brokerError('event_number_invalid', 'event subscription number must be a positive integer');
  }
  const allowDuplicate = spec.allowDuplicate === true || spec.allow_duplicate === true;
  return {
    agentId: normalizedString(spec.agentId ?? spec.agent_id ?? spec.sessionId ?? spec.session_id) || 'anonymous-agent',
    resource,
    repo,
    number,
    runId: spec.runId === undefined || spec.runId === null ? null : String(spec.runId),
    sha: normalizedString(spec.sha),
    branch: normalizedString(spec.branch),
    environment: normalizedString(spec.environment),
    workflow: normalizedString(spec.workflow),
    deploymentId: spec.deploymentId === undefined || spec.deploymentId === null ? null : String(spec.deploymentId),
    waitFor: subscriptionStates(spec),
    allowDuplicate,
    shared: spec.shared === true || spec.sharedObserver === true || !allowDuplicate,
    followLatest: spec.followLatest === true || spec.follow_latest === true,
    once: spec.once !== false,
    stalledAfterMs,
    createdAt: new Date(nowMs).toISOString(),
    lastActivityAt: new Date(nowMs).toISOString(),
    lastActivityState: null,
    lastActivityAction: null,
    lastActivityRunId: null,
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    pending: [],
  };
}

function subscriptionPublic(
  subscription,
  {
    nowMs = Date.now(),
    waitEstimate: estimate = summarizeWaitEstimate([]),
    duplicateTargetCount = 1,
    listenerAttached = null,
    listenerInfo = [],
    sharedJoin = false,
  } = {},
) {
  const createdAtMs = Date.parse(subscription.createdAt);
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null;
  const remainingMs = Math.max(0, subscription.expiresAtMs - nowMs);
  const waitBudgetMs = Number.isFinite(createdAtMs)
    ? Math.max(0, subscription.expiresAtMs - createdAtMs)
    : null;
  const estimatedDecisionAt = estimate.estimatedWaitP90Ms === null
    ? null
    : new Date(Math.min(subscription.expiresAtMs, nowMs + estimate.estimatedWaitP90Ms)).toISOString();
  const lastActivityMs = Date.parse(subscription.lastActivityAt || '');
  const staleSinceMs = Number.isFinite(lastActivityMs)
    ? Math.max(0, nowMs - lastActivityMs)
    : null;
  const stalled = subscriptionIsStalled(subscription, nowMs);
  const waitState = subscription.pending.length > 0
    ? 'event_pending'
    : stalled
      ? 'stalled'
      : 'waiting_external';
  const nextAction = waitState === 'event_pending'
    ? 'ack_event'
    : waitState === 'stalled'
      ? 'reconcile_once_or_escalate'
      : subscription.shared
      ? 'attach_shared_listener'
      : duplicateTargetCount > 1
      ? 'reuse_shared_observer'
      : listenerAttached === true ? 'wait_for_webhook' : 'attach_single_listener';
  return {
    id: subscription.id,
    agentId: subscription.agentId,
    resource: subscription.resource,
    repo: subscription.repo,
    number: subscription.number,
    runId: subscription.runId,
    sha: subscription.sha,
    environment: subscription.environment,
    workflow: subscription.workflow,
    deploymentId: subscription.deploymentId,
    branch: subscription.branch,
    followLatest: subscription.followLatest === true,
    waitFor: subscription.waitFor,
    once: subscription.once,
    createdAt: subscription.createdAt,
    lastRenewedAt: subscription.lastRenewedAt || null,
    expiresAt: subscription.expiresAt,
    pendingEvents: subscription.pending.length,
    ageMs,
    lastActivityAt: subscription.lastActivityAt,
    updatedAt: subscription.lastActivityAt,
    lastActivityState: subscription.lastActivityState,
    lastActivityAction: subscription.lastActivityAction,
    lastActivityRunId: subscription.lastActivityRunId,
    staleSinceMs,
    stalledAfterMs: subscription.stalledAfterMs,
    stalled,
    remainingMs,
    waitBudgetMs,
    deadlineAt: subscription.expiresAt,
    estimatedDecisionAt,
    observedAt: new Date(nowMs).toISOString(),
    waitState,
    nextAction,
    shared: subscription.shared === true,
    sharedObserverCount: subscription.shared
      ? Math.max(1, Array.isArray(subscription.sharedAgentIds) ? subscription.sharedAgentIds.length : 1)
      : 1,
    sharedJoin,
    targetKey: subscriptionTargetKey(subscription),
    duplicateTargetCount,
    sharedObserverRecommended: duplicateTargetCount > 1,
    listenerAttached,
    listenerInfo,
    compactLine: compactSubscriptionLine({
      ...subscription,
      waitState,
      stalled,
      lastActivityAt: subscription.lastActivityAt,
      staleSinceMs,
      listenerAttached,
      listenerInfo,
    }),
    ...estimate,
  };
}

function storedLatencySample(value) {
  if (!value || typeof value !== 'object') return null;
  const resource = canonicalResource(value.resource);
  const repo = validRepo(value.repo);
  const waitForKey = normalizedString(value.waitForKey);
  const waitMs = Number(value.waitMs);
  if (!['pull_request', 'workflow_run', 'deployment'].includes(resource)
    || !waitForKey
    || !Number.isFinite(waitMs)
    || waitMs < 0) return null;
  return {
    repo,
    resource,
    waitForKey,
    waitMs: Math.min(MAX_SUBSCRIPTION_TTL_MS, Math.round(waitMs)),
    observedAt: normalizedString(value.observedAt) || new Date().toISOString(),
  };
}

function storedSubscription(value) {
  if (!value || typeof value !== 'object' || !normalizedString(value.id)) return null;
  const expiresAtMs = Number(value.expiresAtMs ?? Date.parse(String(value.expiresAt || '')));
  if (!Number.isFinite(expiresAtMs)) return null;
  const resource = canonicalResource(value.resource);
  const repo = validRepo(value.repo);
  const number = value.number === null || value.number === undefined ? null : Number(value.number);
  const waitFor = Array.isArray(value.waitFor) ? unique(value.waitFor.map(normalizedState)) : [];
  if (!['pull_request', 'workflow_run', 'deployment'].includes(resource)
    || !repo
    || (number !== null && (!Number.isInteger(number) || number <= 0))
    || waitFor.length === 0) return null;
  return {
    id: String(value.id),
    agentId: normalizedString(value.agentId) || 'anonymous-agent',
    resource,
    repo,
    number,
    runId: value.runId === null || value.runId === undefined ? null : String(value.runId),
    sha: normalizedString(value.sha),
    branch: normalizedString(value.branch),
    environment: normalizedString(value.environment),
    workflow: normalizedString(value.workflow),
    deploymentId: value.deploymentId === null || value.deploymentId === undefined ? null : String(value.deploymentId),
    waitFor,
    shared: value.shared === true,
    sharedAgentIds: value.shared === true
      ? unique((Array.isArray(value.sharedAgentIds) ? value.sharedAgentIds : []).map(String).concat(
        normalizedString(value.agentId) || 'anonymous-agent',
      ))
      : [],
    followLatest: value.followLatest === true,
    once: value.once !== false,
    createdAt: normalizedString(value.createdAt) || new Date().toISOString(),
    stalledAfterMs: Number.isFinite(Number(value.stalledAfterMs)) && Number(value.stalledAfterMs) > 0
      ? Math.min(MAX_SUBSCRIPTION_TTL_MS, Number(value.stalledAfterMs))
      : DEFAULT_STALLED_AFTER_MS,
    lastActivityAt: normalizedString(value.lastActivityAt)
      || normalizedString(value.createdAt)
      || new Date().toISOString(),
    lastActivityState: normalizedString(value.lastActivityState),
    lastActivityAction: normalizedString(value.lastActivityAction),
    lastActivityRunId: value.lastActivityRunId === null || value.lastActivityRunId === undefined
      ? null
      : String(value.lastActivityRunId),
    lastRenewedAt: normalizedString(value.lastRenewedAt),
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    pending: Array.isArray(value.pending) ? value.pending : [],
  };
}

function eventAuditRecord({
  event,
  eventName,
  deliveryId,
  targetMatchedSubscriptionIds = [],
  matchedSubscriptionIds = [],
  ignoredReason = null,
  duplicate = false,
  recordedAt,
}) {
  const targetMatches = unique(targetMatchedSubscriptionIds.map(String));
  const waitMatches = unique(matchedSubscriptionIds.map(String));
  const normalizedStateValue = normalizedState(event?.state);
  const normalizedActionValue = normalizedState(event?.action);
  const id = String(deliveryId || event?.id || `audit:${Date.now()}`);
  return {
    id,
    deliveryId: id,
    eventName: normalizedString(eventName || event?.eventName) || 'unknown',
    repo: validRepo(event?.repo),
    resource: event?.resource ? canonicalResource(event.resource) : null,
    number: event?.number === null || event?.number === undefined ? null : Number(event.number),
    runId: event?.runId === null || event?.runId === undefined ? null : String(event.runId),
    sha: normalizedString(event?.sha),
    branch: normalizedString(event?.branch),
    workflow: normalizedString(event?.workflow),
    environment: normalizedString(event?.environment),
    deploymentId: event?.deploymentId === null || event?.deploymentId === undefined
      ? null
      : String(event.deploymentId),
    commentId: normalizedCommentId(event?.commentId),
    commentUrl: normalizedString(event?.commentUrl),
    mergeable: event?.mergeable === true || event?.mergeable === false ? event.mergeable : null,
    mergeableState: normalizedMergeableState(event?.mergeableState),
    state: normalizedStateValue || null,
    states: Array.isArray(event?.states) ? unique(event.states.map(normalizedState)) : [],
    action: normalizedActionValue || null,
    conclusion: normalizedState(event?.conclusion) || null,
    receivedAt: normalizedString(event?.receivedAt) || recordedAt,
    recordedAt,
    targetMatchedSubscriptionIds: targetMatches,
    matchedSubscriptionIds: waitMatches,
    targetMatchCount: targetMatches.length,
    matchCount: waitMatches.length,
    classification: ignoredReason
      ? 'ignored'
      : waitMatches.length > 0
        ? 'matched'
        : targetMatches.length > 0
          ? 'target_matched_wait_unmatched'
          : 'unmatched',
    ignoredReason: normalizedString(ignoredReason),
    duplicate: duplicate === true,
  };
}

function storedEventAudit(value) {
  if (!value || typeof value !== 'object' || !normalizedString(value.id || value.deliveryId)) return null;
  const record = eventAuditRecord({
    event: value,
    eventName: value.eventName,
    deliveryId: value.id || value.deliveryId,
    targetMatchedSubscriptionIds: Array.isArray(value.targetMatchedSubscriptionIds)
      ? value.targetMatchedSubscriptionIds
      : [],
    matchedSubscriptionIds: Array.isArray(value.matchedSubscriptionIds)
      ? value.matchedSubscriptionIds
      : [],
    ignoredReason: value.ignoredReason,
    duplicate: value.duplicate,
    recordedAt: normalizedString(value.recordedAt) || new Date().toISOString(),
  });
  return {
    ...record,
    receivedAt: normalizedString(value.receivedAt) || record.recordedAt,
  };
}

function webhookRepo(payload) {
  return validRepo(payload?.repository?.full_name);
}

function eventStates(primary, ...additional) {
  return unique([normalizedState(primary), ...additional.map(normalizedState)]);
}

function normalizedEvent({
  deliveryId,
  eventName,
  repo,
  resource,
  resources,
  state,
  states,
  action,
  number = null,
  pullRequestNumbers = [],
  runId = null,
  workflow = null,
  branch = null,
  deploymentId = null,
  environment = null,
  sha = null,
  conclusion = null,
  commentId = null,
  commentUrl = null,
  mergeable = null,
  mergeableState = null,
  url = null,
  receivedAt,
}) {
  return {
    id: String(deliveryId),
    deliveryId: String(deliveryId),
    eventName,
    resource,
    resources: unique([resource, ...resources]),
    repo,
    state: normalizedState(state),
    states: eventStates(state, ...states),
    action: normalizedState(action),
    number,
    pullRequestNumbers: unique(pullRequestNumbers.map((value) => String(value))),
    runId: runId === null || runId === undefined ? null : String(runId),
    workflow,
    branch,
    deploymentId: deploymentId === null || deploymentId === undefined ? null : String(deploymentId),
    environment,
    sha,
    conclusion: normalizedState(conclusion),
    commentId: normalizedCommentId(commentId),
    commentUrl: normalizedString(commentUrl),
    mergeable: mergeable === true || mergeable === false ? mergeable : null,
    mergeableState: normalizedMergeableState(mergeableState),
    url,
    receivedAt,
  };
}

function workflowState(action, conclusion) {
  const normalizedConclusion = normalizedState(conclusion);
  if (action === 'completed') {
    if (normalizedConclusion === 'success') return { state: 'success', states: ['completed'] };
    if (normalizedConclusion === 'failed' || normalizedConclusion === 'cancelled') {
      return { state: normalizedConclusion, states: ['completed'] };
    }
    if (normalizedConclusion === 'neutral' || normalizedConclusion === 'skipped') {
      return { state: normalizedConclusion, states: ['completed'] };
    }
    return { state: 'completed', states: [] };
  }
  return { state: normalizedState(action), states: [] };
}

export function normalizeWebhookEvent({ eventName, deliveryId, payload, receivedAt = new Date().toISOString() }) {
  const event = String(eventName || '').toLowerCase();
  const repo = webhookRepo(payload);
  if (!repo || !payload || typeof payload !== 'object') return null;

  if (event === 'pull_request') {
    const pullRequest = payload.pull_request || {};
    const action = normalizedState(payload.action);
    const merged = action === 'closed' && pullRequest.merged === true;
    const mergeability = pullRequestMergeability(pullRequest);
    const state = merged ? 'merged' : mergeability.conflict ? 'conflict' : action;
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'pull_request',
      resources: [],
      state,
      states: merged ? ['closed'] : mergeability.conflict ? ['conflict'] : [],
      action,
      number: pullRequest.number || payload.number || null,
      sha: pullRequest.head?.sha || null,
      mergeable: mergeability.mergeable,
      mergeableState: mergeability.mergeableState,
      url: pullRequest.html_url || null,
      receivedAt,
    });
  }

  if (event === 'pull_request_review') {
    const pullRequest = payload.pull_request || {};
    const reviewState = normalizedState(payload.review?.state);
    const mergeability = pullRequestMergeability(pullRequest);
    const state = reviewState === 'needs_review'
      ? 'needs_review'
      : reviewState === 'approved'
        ? 'approved'
      : reviewState === 'commented'
          ? 'commented'
          : normalizedState(payload.action);
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'pull_request',
      resources: [],
      state,
      states: [
        ...(reviewState ? [reviewState] : []),
        ...(mergeability.conflict ? ['conflict'] : []),
      ],
      action: payload.action,
      number: pullRequest.number || payload.number || null,
      sha: pullRequest.head?.sha || null,
      mergeable: mergeability.mergeable,
      mergeableState: mergeability.mergeableState,
      url: payload.review?.html_url || pullRequest.html_url || null,
      receivedAt,
    });
  }

  if (event === 'issue_comment' || event === 'pull_request_review_comment') {
    const pullRequest = event === 'issue_comment'
      ? payload.issue?.pull_request ? payload.issue : null
      : payload.pull_request || null;
    if (!pullRequest) return null;
    const action = normalizedState(payload.action);
    const comment = payload.comment || {};
    const commentUrl = comment.html_url || pullRequest.html_url || null;
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'pull_request',
      resources: [],
      state: action === 'created' ? 'commented' : action,
      states: action === 'created' ? ['commented'] : [],
      action,
      number: pullRequest.number || payload.number || null,
      sha: pullRequest.head?.sha || null,
      commentId: comment.id,
      commentUrl,
      url: commentUrl,
      receivedAt,
    });
  }

  if (event === 'workflow_run') {
    const run = payload.workflow_run || {};
    const action = normalizedState(payload.action);
    const result = workflowState(action, run.conclusion);
    const pullRequestNumbers = Array.isArray(run.pull_requests)
      ? run.pull_requests.map((pullRequest) => pullRequest.number).filter(Boolean)
      : [];
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'workflow_run',
      resources: pullRequestNumbers.length ? ['pull_request'] : [],
      state: result.state,
      states: result.states,
      action,
      number: pullRequestNumbers.length === 1 ? pullRequestNumbers[0] : null,
      pullRequestNumbers,
      runId: run.id,
      workflow: run.name || run.workflow_name || null,
      branch: run.head_branch || null,
      sha: run.head_sha || null,
      conclusion: run.conclusion || null,
      url: run.html_url || null,
      receivedAt,
    });
  }

  if (event === 'deployment_status') {
    const deployment = payload.deployment || {};
    const status = payload.deployment_status || {};
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'deployment',
      resources: [],
      state: status.state,
      states: [],
      action: payload.action,
      deploymentId: deployment.id,
      environment: status.environment || deployment.environment || null,
      sha: deployment.sha || null,
      url: status.target_url || deployment.url || null,
      receivedAt,
    });
  }

  if (event === 'deployment') {
    const deployment = payload.deployment || {};
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'deployment',
      resources: [],
      state: payload.action,
      states: [],
      action: payload.action,
      deploymentId: deployment.id,
      environment: deployment.environment || null,
      sha: deployment.sha || null,
      url: deployment.url || null,
      receivedAt,
    });
  }

  return null;
}

export function eventMatchesSubscription(event, subscription) {
  if (!eventMatchesSubscriptionTarget(event, subscription)) return false;
  if (subscription.followLatest
    && subscription.resource === 'workflow_run'
    && event.state === 'cancelled'
    && subscription.waitFor.includes('completed')) return false;
  const states = event.states || [event.state];
  return subscription.waitFor.some((state) => states.includes(state));
}

export function eventMatchesSubscriptionTarget(event, subscription) {
  if (!event || !subscription || event.repo !== subscription.repo) return false;
  const resources = event.resources || [event.resource];
  if (!resources.includes(subscription.resource)) return false;
  if (subscription.number !== null && subscription.number !== undefined) {
    const numbers = [event.number, ...(event.pullRequestNumbers || [])].map((value) => Number(value));
    if (!numbers.includes(subscription.number)) return false;
  }
  if (subscription.runId && String(event.runId) !== String(subscription.runId)) return false;
  if (subscription.sha && event.sha !== subscription.sha) return false;
  if (subscription.branch && event.branch !== subscription.branch) return false;
  if (subscription.environment && event.environment !== subscription.environment) return false;
  if (subscription.workflow && event.workflow !== subscription.workflow) return false;
  if (subscription.deploymentId && String(event.deploymentId) !== String(subscription.deploymentId)) return false;
  return true;
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || typeof rawBody !== 'string' || typeof signature !== 'string') return false;
  if (!signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function normalizeReconciliationEvent({ subscription, data, checkedAt = new Date().toISOString() }) {
  if (!subscription || !data || typeof data !== 'object') return null;
  const fingerprint = data.updated_at || data.id || data.run_id || checkedAt;
  const deliveryId = `reconcile:${subscription.id}:${fingerprint}`;
  if (subscription.resource === 'pull_request') {
    const merged = data.merged === true || Boolean(data.merged_at);
    const mergeability = pullRequestMergeability(data);
    const state = merged ? 'merged' : mergeability.conflict ? 'conflict' : normalizedState(data.state);
    return normalizedEvent({
      deliveryId,
      eventName: 'reconciliation',
      repo: subscription.repo,
      resource: 'pull_request',
      resources: [],
      state,
      states: merged ? ['closed'] : mergeability.conflict ? ['conflict'] : [],
      action: data.state,
      number: data.number || subscription.number || null,
      sha: data.head?.sha || data.head_sha || null,
      mergeable: mergeability.mergeable,
      mergeableState: mergeability.mergeableState,
      url: data.html_url || null,
      receivedAt: checkedAt,
    });
  }
  if (subscription.resource === 'workflow_run') {
    const action = normalizedState(data.status || 'completed');
    const result = workflowState(action, data.conclusion);
    const pullRequestNumbers = Array.isArray(data.pull_requests)
      ? data.pull_requests.map((pullRequest) => pullRequest.number).filter(Boolean)
      : [];
    return normalizedEvent({
      deliveryId,
      eventName: 'reconciliation',
      repo: subscription.repo,
      resource: 'workflow_run',
      resources: pullRequestNumbers.length ? ['pull_request'] : [],
      state: result.state,
      states: result.states,
      action,
      number: pullRequestNumbers.length === 1 ? pullRequestNumbers[0] : null,
      pullRequestNumbers,
      runId: data.id || data.run_id || subscription.runId,
      workflow: data.name || data.workflow_name || null,
      branch: data.head_branch || subscription.branch || null,
      sha: data.head_sha || null,
      conclusion: data.conclusion || null,
      url: data.html_url || null,
      receivedAt: checkedAt,
    });
  }
  if (subscription.resource === 'deployment') {
    return normalizedEvent({
      deliveryId,
      eventName: 'reconciliation',
      repo: subscription.repo,
      resource: 'deployment',
      resources: [],
      state: data.state,
      states: [],
      action: data.state,
      deploymentId: subscription.deploymentId || data.deployment_id || data.id,
      environment: data.environment || subscription.environment || null,
      sha: data.sha || null,
      url: data.target_url || data.url || null,
      receivedAt: checkedAt,
    });
  }
  return null;
}

export class GitHubEventBroker {
  constructor({ stateFile, webhookSecret, now = () => Date.now(), legacyStateFile = null }) {
    if (!stateFile) throw new TypeError('event_state_file_required');
    this.stateFile = stateFile;
    this.legacyStateFile = legacyStateFile && legacyStateFile !== stateFile ? legacyStateFile : null;
    this.webhookSecret = normalizedString(webhookSecret);
    this.now = now;
    this.metrics = {
      subscriptionsCreated: 0,
      subscriptionsExpired: 0,
      subscriptionsAcknowledged: 0,
      subscriptionsRenewed: 0,
      webhookEvents: 0,
      webhookDuplicates: 0,
      webhookIgnored: 0,
      matchedEvents: 0,
      pendingOverflow: 0,
      latencySamplesRecorded: 0,
      subscriptionsGarbageCollected: 0,
    };
    this.state = this.loadState();
    if (this.state.migratedLegacyFiles?.length > 0) this.persist();
  }

  loadState() {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.stateFile), 0o700); } catch { /* best effort */ }
    const readState = (path) => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed.version !== EVENT_BROKER_STATE_VERSION) {
          throw brokerError('event_state_version_unsupported', 'unsupported event broker state version');
        }
        const subscriptions = Array.isArray(parsed.subscriptions)
          ? parsed.subscriptions.map(storedSubscription)
          : [];
        if (subscriptions.some((subscription) => !subscription || !subscription.repo || !subscription.waitFor.length)) {
          throw brokerError('event_state_invalid', 'event broker state contains an invalid subscription');
        }
        return {
          version: EVENT_BROKER_STATE_VERSION,
          subscriptions,
          seenDeliveries: Array.isArray(parsed.seenDeliveries)
            ? parsed.seenDeliveries.filter((delivery) => delivery?.id && Number.isFinite(Number(delivery.seenAtMs)))
            : [],
          latencySamples: Array.isArray(parsed.latencySamples)
            ? parsed.latencySamples.map(storedLatencySample).filter(Boolean).slice(-MAX_LATENCY_SAMPLES)
            : [],
          eventAudit: Array.isArray(parsed.eventAudit)
            ? parsed.eventAudit.map(storedEventAudit).filter(Boolean).slice(-MAX_EVENT_AUDIT)
            : [],
          migratedLegacyFiles: Array.isArray(parsed.migratedLegacyFiles)
            ? parsed.migratedLegacyFiles.map(String)
            : [],
        };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };
    const current = readState(this.stateFile) || {
      version: EVENT_BROKER_STATE_VERSION,
      subscriptions: [],
      seenDeliveries: [],
      latencySamples: [],
      eventAudit: [],
      migratedLegacyFiles: [],
    };
    if (!this.legacyStateFile || current.migratedLegacyFiles.includes(this.legacyStateFile)) return current;
    const legacy = readState(this.legacyStateFile);
    if (!legacy) return current;
    const subscriptionsByKey = new Map(current.subscriptions.map((subscription) => [
      subscriptionDedupKey(subscription),
      subscription,
    ]));
    for (const subscription of legacy.subscriptions) {
      const key = subscriptionDedupKey(subscription);
      const existing = subscriptionsByKey.get(key);
      if (!existing) {
        subscriptionsByKey.set(key, subscription);
        continue;
      }
      existing.shared = true;
      existing.sharedAgentIds = unique([
        ...(existing.sharedAgentIds || []),
        existing.agentId,
        ...(subscription.sharedAgentIds || []),
        subscription.agentId,
      ]);
      existing.pending = [...existing.pending, ...subscription.pending]
        .filter((event, index, events) => events.findIndex((candidate) => candidate.id === event.id) === index)
        .slice(-32);
      if (subscription.expiresAtMs > existing.expiresAtMs) {
        existing.expiresAtMs = subscription.expiresAtMs;
        existing.expiresAt = subscription.expiresAt;
      }
      const existingActivityMs = Date.parse(existing.lastActivityAt || '');
      const legacyActivityMs = Date.parse(subscription.lastActivityAt || '');
      if (!Number.isFinite(existingActivityMs) || legacyActivityMs > existingActivityMs) {
        existing.lastActivityAt = subscription.lastActivityAt;
        existing.lastActivityState = subscription.lastActivityState;
        existing.lastActivityAction = subscription.lastActivityAction;
        existing.lastActivityRunId = subscription.lastActivityRunId;
      }
    }
    const seenById = new Map(current.seenDeliveries.map((delivery) => [delivery.id, delivery]));
    for (const delivery of legacy.seenDeliveries) seenById.set(delivery.id, delivery);
    current.subscriptions = [...subscriptionsByKey.values()];
    current.seenDeliveries = [...seenById.values()].slice(-MAX_SEEN_DELIVERIES);
    current.latencySamples = [...current.latencySamples, ...legacy.latencySamples].slice(-MAX_LATENCY_SAMPLES);
    const auditById = new Map(current.eventAudit.map((event) => [event.id, event]));
    for (const event of legacy.eventAudit) auditById.set(event.id, event);
    current.eventAudit = [...auditById.values()].slice(-MAX_EVENT_AUDIT);
    current.migratedLegacyFiles.push(this.legacyStateFile);
    return current;
  }

  persist() {
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.stateFile);
      chmodSync(this.stateFile, 0o600);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* no temporary file */ }
      throw error;
    }
  }

  pruneExpiredSubscriptions(nowMs = this.now()) {
    const subscriptionsBefore = this.state.subscriptions.length;
    const expiredIds = this.state.subscriptions
      .filter((subscription) => subscription.expiresAtMs <= nowMs)
      .map((subscription) => subscription.id);
    this.state.subscriptions = this.state.subscriptions.filter((subscription) => subscription.expiresAtMs > nowMs);
    this.metrics.subscriptionsExpired += subscriptionsBefore - this.state.subscriptions.length;
    return expiredIds;
  }

  pruneSeenDeliveries(nowMs = this.now()) {
    const seenBefore = this.state.seenDeliveries.length;
    this.state.seenDeliveries = this.state.seenDeliveries
      .filter((delivery) => nowMs - Number(delivery.seenAtMs) <= SEEN_DELIVERY_TTL_MS)
      .slice(-MAX_SEEN_DELIVERIES);
    return seenBefore !== this.state.seenDeliveries.length;
  }

  prune() {
    const nowMs = this.now();
    const subscriptionsBefore = this.state.subscriptions.length;
    const expiredIds = this.pruneExpiredSubscriptions(nowMs);
    const seenChanged = this.pruneSeenDeliveries(nowMs);
    return expiredIds.length > 0
      || subscriptionsBefore !== this.state.subscriptions.length
      || seenChanged;
  }

  expireSubscriptions() {
    const nowMs = this.now();
    const expiredIds = this.pruneExpiredSubscriptions(nowMs);
    const seenChanged = this.pruneSeenDeliveries(nowMs);
    if (expiredIds.length > 0 || seenChanged) this.persist();
    return expiredIds;
  }

  duplicateSubscriptionCounts() {
    const counts = new Map();
    for (const subscription of this.state.subscriptions) {
      const key = subscriptionDedupKey(subscription);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  duplicateGroups() {
    const groups = new Map();
    for (const subscription of this.state.subscriptions) {
      const dedupKey = subscriptionDedupKey(subscription);
      if (!groups.has(dedupKey)) groups.set(dedupKey, []);
      groups.get(dedupKey).push(subscription);
    }
    return [...groups.values()]
      .filter((subscriptions) => subscriptions.length > 1)
      .map((subscriptions) => ({
        targetKey: subscriptionTargetKey(subscriptions[0]),
        waitFor: subscriptions[0].waitFor,
        count: subscriptions.length,
        subscriptionIds: subscriptions.map(({ id }) => id),
        agentIds: unique(subscriptions.map(({ agentId }) => agentId)),
      }));
  }

  estimateFor(subscription) {
    const exactKey = latencySampleKey(subscription);
    const exact = this.state.latencySamples.filter((sample) => sample.waitForKey === exactKey);
    const contextual = this.state.latencySamples.filter((sample) => (
      sample.repo === subscription.repo
      && sample.resource === subscription.resource
      && (sample.workflow || '*') === (subscription.workflow || '*')
      && (sample.branch || '*') === (subscription.branch || '*')
    ));
    const resourceSamples = this.state.latencySamples.filter((sample) => sample.resource === subscription.resource);
    if (exact.length >= MIN_ESTIMATE_SAMPLES) return summarizeWaitEstimate(exact, 'same_wait_for');
    if (contextual.length >= MIN_ESTIMATE_SAMPLES) return summarizeWaitEstimate(contextual, 'same_repo_workflow');
    if (resourceSamples.length) return summarizeWaitEstimate(resourceSamples, 'resource');
    return summarizeWaitEstimate([], 'none');
  }

  publicSubscription(subscription, options = {}) {
    const duplicateTargetCount = this.duplicateSubscriptionCounts().get(subscriptionDedupKey(subscription)) || 1;
    return subscriptionPublic(subscription, {
      ...options,
      waitEstimate: this.estimateFor(subscription),
      duplicateTargetCount,
    });
  }

  listenerCount(listenerAttached) {
    if (typeof listenerAttached !== 'function' && !(listenerAttached instanceof Set) && !Array.isArray(listenerAttached)) return null;
    return this.state.subscriptions
      .filter(({ id }) => listenerAttachedValue(listenerAttached, id) === true)
      .length;
  }

  summary({ listenerAttached = null, listenerInfo = null, ...filters } = {}) {
    if (this.prune()) this.persist();
    const allSubscriptions = this.state.subscriptions;
    const nowMs = this.now();
    const subscriptions = allSubscriptions.filter((subscription) => (
      selectedSubscription(subscription, filters, listenerAttached, nowMs)
    ));
    const duplicateGroups = this.duplicateGroups()
      .filter((group) => subscriptions.some(({ id }) => group.subscriptionIds.includes(id)));
    const latencyByResource = new Map();
    for (const sample of this.state.latencySamples) {
      if (!latencyByResource.has(sample.resource)) latencyByResource.set(sample.resource, []);
      latencyByResource.get(sample.resource).push(sample);
    }
    const publicSubscriptions = subscriptions.map((subscription) => this.publicSubscription(subscription, {
      nowMs,
      listenerAttached: listenerAttachedValue(listenerAttached, subscription.id),
      listenerInfo: listenerInfoValue(listenerInfo, subscription.id),
    }));
    const listenerCount = listenerAttached === null
      ? null
      : publicSubscriptions.filter(({ listenerAttached: attached }) => attached === true).length;
    const stalledSubscriptions = publicSubscriptions.filter(({ stalled }) => stalled);
    const pendingEvents = subscriptions.reduce((total, subscription) => total + subscription.pending.length, 0);
    const orphanedSubscriptions = subscriptions.filter(({ id }) => listenerAttachedValue(listenerAttached, id) !== true).length;
    const duplicateSubscriptions = duplicateGroups.reduce((total, group) => total + group.count - 1, 0);
    const alerts = [];
    if (pendingEvents > 0) alerts.push({ code: 'pending_events', count: pendingEvents });
    if (listenerAttached !== null && orphanedSubscriptions > 0) {
      alerts.push({ code: 'listener_missing', count: orphanedSubscriptions });
    }
    if (duplicateSubscriptions > 0) alerts.push({ code: 'duplicate_subscriptions', count: duplicateSubscriptions });
    if (stalledSubscriptions.length > 0) {
      alerts.push({ code: 'stalled_subscriptions', count: stalledSubscriptions.length });
    }
    const summaryLine = publicSubscriptions.length === 1
      ? publicSubscriptions[0].compactLine
      : String(publicSubscriptions.length) + ' subscription · ' + String(listenerCount === null ? 'n/d' : listenerCount)
        + ' listener attivi · ' + String(pendingEvents) + ' eventi pending';
    return {
      stateFile: this.stateFile,
      subscriptionCount: subscriptions.length,
      totalSubscriptionCount: allSubscriptions.length,
      agentCount: unique(subscriptions.flatMap((subscription) => subscription.shared
        ? subscription.sharedAgentIds
        : [subscription.agentId])).length,
      pendingEvents,
      listenerCount,
      orphanedSubscriptions: listenerAttached === null ? null : orphanedSubscriptions,
      stalledSubscriptions: stalledSubscriptions.length,
      duplicateGroups,
      duplicateSubscriptions,
      alerts,
      summaryLine,
      metrics: { ...this.metrics },
      latency: {
        sampleCount: this.state.latencySamples.length,
        byResource: Object.fromEntries(
          [...latencyByResource.entries()].map(([resource, samples]) => [resource, summarizeWaitEstimate(samples, 'resource')]),
        ),
      },
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  status({ listenerAttached = null, listenerInfo = null, limit, ...filters } = {}) {
    if (this.prune()) this.persist();
    const nowMs = this.now();
    const allSubscriptions = this.state.subscriptions.filter((subscription) => (
      selectedSubscription(subscription, filters, listenerAttached, nowMs)
    ));
    const numericLimit = limit === undefined || limit === null ? null : Number(limit);
    const boundedLimit = Number.isFinite(numericLimit) && numericLimit >= 0
      ? Math.floor(numericLimit)
      : null;
    const subscriptions = boundedLimit === null
      ? allSubscriptions
      : allSubscriptions.slice(0, boundedLimit);
    return {
      stateFile: this.stateFile,
      subscriptions: subscriptions.map((subscription) => this.publicSubscription(subscription, {
        nowMs,
        listenerAttached: listenerAttachedValue(listenerAttached, subscription.id),
        listenerInfo: listenerInfoValue(listenerInfo, subscription.id),
      })),
      pendingEvents: subscriptions.reduce((total, subscription) => total + subscription.pending.length, 0),
      metrics: { ...this.metrics },
      summary: this.summary({ ...filters, listenerAttached, listenerInfo }),
    };
  }

  subscribe(spec) {
    this.prune();
    const nowMs = this.now();
    const normalized = normalizeSubscriptionSpec(spec, nowMs);
    const allowDuplicate = normalized.allowDuplicate === true;
    const agentId = normalized.agentId;
    delete normalized.allowDuplicate;
    const duplicate = this.state.subscriptions
      .filter((subscription) => subscriptionDedupKey(subscription) === subscriptionDedupKey(normalized))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
    if (duplicate && !allowDuplicate) {
      duplicate.shared = true;
      duplicate.sharedAgentIds = unique([
        ...(duplicate.sharedAgentIds || []),
        duplicate.agentId,
        agentId,
      ]);
      if (normalized.expiresAtMs > duplicate.expiresAtMs) {
        duplicate.expiresAtMs = Math.min(
          nowMs + MAX_SUBSCRIPTION_TTL_MS,
          Math.max(duplicate.expiresAtMs, normalized.expiresAtMs),
        );
        duplicate.expiresAt = new Date(duplicate.expiresAtMs).toISOString();
      }
      this.persist();
      return this.publicSubscription(duplicate, { nowMs, sharedJoin: true });
    }
    if (normalized.shared) normalized.sharedAgentIds = [agentId];
    normalized.id = `sub-${randomUUID()}`;
    this.state.subscriptions.push(normalized);
    this.metrics.subscriptionsCreated += 1;
    this.persist();
    return this.publicSubscription(normalized, { nowMs });
  }

  getSubscription(subscriptionId) {
    if (this.prune()) this.persist();
    const subscription = this.state.subscriptions.find(({ id }) => id === String(subscriptionId || ''));
    return subscription ? this.publicSubscription(subscription, { nowMs: this.now() }) : null;
  }

  getSubscriptionRecord(subscriptionId) {
    if (this.prune()) this.persist();
    return this.state.subscriptions.find(({ id }) => id === String(subscriptionId || '')) || null;
  }

  renew(subscriptionId, { ttlMs, ttlSeconds, agentId } = {}) {
    const subscription = this.getSubscriptionRecord(subscriptionId);
    if (!subscription) {
      return {
        ok: false,
        error: { code: 'event_subscription_not_found', message: 'event subscription not found' },
      };
    }
    const requestedTtl = Number(ttlMs ?? (
      ttlSeconds === undefined ? DEFAULT_SUBSCRIPTION_TTL_MS : Number(ttlSeconds) * 1_000
    ));
    if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) {
      return {
        ok: false,
        error: { code: 'event_ttl_invalid', message: 'event subscription TTL must be positive' },
      };
    }
    if (agentId && subscription.shared && !subscription.sharedAgentIds.includes(String(agentId))) {
      subscription.sharedAgentIds.push(String(agentId));
    }
    const nowMs = this.now();
    subscription.expiresAtMs = Math.min(
      nowMs + MAX_SUBSCRIPTION_TTL_MS,
      Math.max(subscription.expiresAtMs, nowMs + Math.min(MAX_SUBSCRIPTION_TTL_MS, requestedTtl)),
    );
    subscription.expiresAt = new Date(subscription.expiresAtMs).toISOString();
    subscription.lastRenewedAt = new Date(nowMs).toISOString();
    this.metrics.subscriptionsRenewed += 1;
    this.persist();
    return {
      ok: true,
      subscription: this.publicSubscription(subscription, { nowMs }),
      renewedAt: subscription.lastRenewedAt,
    };
  }

  listSubscriptions() {
    return this.status().subscriptions;
  }

  unsubscribe(subscriptionId) {
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter(({ id }) => id !== String(subscriptionId || ''));
    if (before !== this.state.subscriptions.length) this.persist();
    return { ok: true, subscriptionId: String(subscriptionId || ''), removed: before !== this.state.subscriptions.length };
  }

  garbageCollect({ listenerAttached = null, olderThanMs = DEFAULT_ORPHAN_GRACE_MS, apply = false, includeUnique = false } = {}) {
    if (typeof listenerAttached !== 'function' && !(listenerAttached instanceof Set) && !Array.isArray(listenerAttached)) {
      throw brokerError(
        'event_gc_listener_inspector_required',
        'event garbage collection requires the coordinator listener inspector',
      );
    }
    const grace = Number(olderThanMs);
    if (!Number.isFinite(grace) || grace <= 0) {
      throw brokerError('event_gc_age_invalid', 'event garbage collection age must be positive');
    }
    this.prune();
    const nowMs = this.now();
    const duplicateCounts = this.duplicateSubscriptionCounts();
    const eligibility = new Map();
    for (const subscription of this.state.subscriptions) {
      const createdAtMs = Date.parse(subscription.createdAt);
      const oldEnough = Number.isFinite(createdAtMs) && nowMs - createdAtMs >= grace;
      const noListener = listenerAttachedValue(listenerAttached, subscription.id) === false;
      const noPending = subscription.pending.length === 0;
      const duplicate = (duplicateCounts.get(subscriptionDedupKey(subscription)) || 0) > 1;
      eligibility.set(subscription.id, {
        eligible: oldEnough && noListener && noPending && (duplicate || includeUnique),
      });
    }
    const keepers = new Set();
    if (!includeUnique) {
      const groups = new Map();
      for (const subscription of this.state.subscriptions) {
        const key = subscriptionDedupKey(subscription);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(subscription);
      }
      for (const [key, group] of groups) {
        if ((duplicateCounts.get(key) || 0) < 2) continue;
        const eligible = group.filter((subscription) => eligibility.get(subscription.id).eligible);
        const protectedMembers = group.filter((subscription) => !eligibility.get(subscription.id).eligible);
        if (protectedMembers.length === 0 && eligible.length > 0) {
          const keeper = [...eligible]
            .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
          keepers.add(keeper.id);
        }
      }
    }
    const candidates = this.state.subscriptions.filter((subscription) => (
      eligibility.get(subscription.id).eligible && !keepers.has(subscription.id)
    ));
    const candidateIds = candidates.map(({ id }) => id);
    const removedIds = apply ? candidateIds : [];
    if (apply && removedIds.length > 0) {
      const removed = new Set(removedIds);
      this.state.subscriptions = this.state.subscriptions.filter(({ id }) => !removed.has(id));
      this.metrics.subscriptionsGarbageCollected += removedIds.length;
      this.persist();
    }
    return {
      ok: true,
      dryRun: !apply,
      olderThanMs: grace,
      includeUnique,
      candidateCount: candidates.length,
      candidates: candidates.map((subscription) => this.publicSubscription(subscription, {
        nowMs,
        listenerAttached: listenerAttachedValue(listenerAttached, subscription.id),
      })),
      removedIds,
    };
  }

  pendingEvent(subscriptionId) {
    const subscription = this.getSubscriptionRecord(subscriptionId);
    return subscription?.pending[0] || null;
  }

  acknowledge(subscriptionId, eventId) {
    const subscription = this.getSubscriptionRecord(subscriptionId);
    if (!subscription) {
      return { ok: false, error: { code: 'event_subscription_not_found', message: 'event subscription not found' } };
    }
    const index = subscription.pending.findIndex(({ id }) => id === String(eventId || ''));
    if (index < 0) {
      return { ok: false, error: { code: 'event_not_pending', message: 'event is no longer pending' } };
    }
    const [event] = subscription.pending.splice(index, 1);
    const createdAtMs = Date.parse(subscription.createdAt);
    const eventAtMs = Date.parse(event.receivedAt || '');
    const waitMs = Number.isFinite(createdAtMs)
      ? Math.max(0, (Number.isFinite(eventAtMs) ? eventAtMs : this.now()) - createdAtMs)
      : null;
    if (Number.isFinite(waitMs)) {
      this.state.latencySamples.push({
        repo: subscription.repo,
        resource: subscription.resource,
        workflow: subscription.workflow,
        branch: subscription.branch,
        waitForKey: latencySampleKey(subscription),
        waitMs: Math.min(MAX_SUBSCRIPTION_TTL_MS, Math.round(waitMs)),
        observedAt: new Date(this.now()).toISOString(),
      });
      this.state.latencySamples = this.state.latencySamples.slice(-MAX_LATENCY_SAMPLES);
      this.metrics.latencySamplesRecorded += 1;
    }
    this.metrics.subscriptionsAcknowledged += 1;
    this.persist();
    return { ok: true, event };
  }

  appendEventAudit(options) {
    const record = eventAuditRecord({
      ...options,
      recordedAt: options.recordedAt || new Date(this.now()).toISOString(),
    });
    this.state.eventAudit = [
      ...this.state.eventAudit.filter((event) => event.id !== record.id),
      record,
    ].slice(-MAX_EVENT_AUDIT);
    return record;
  }

  audit({ limit = 20, ...filters } = {}) {
    if (this.prune()) this.persist();
    const numericLimit = Number(limit);
    const boundedLimit = Number.isFinite(numericLimit) && numericLimit >= 0
      ? Math.floor(numericLimit)
      : 20;
    const events = this.state.eventAudit
      .filter((event) => {
        if (filters.repo && event.repo !== filters.repo) return false;
        if (filters.resource && event.resource !== canonicalResource(filters.resource)) return false;
        if (filters.runId && String(event.runId) !== String(filters.runId)) return false;
        if (filters.number !== undefined && filters.number !== null && event.number !== Number(filters.number)) return false;
        for (const key of ['sha', 'branch', 'environment', 'workflow', 'deploymentId']) {
          if (filters[key] && event[key] !== String(filters[key])) return false;
        }
        return true;
      })
      .slice()
      .reverse()
      .slice(0, boundedLimit);
    const unmatchedEvents = events.filter((event) => event.classification !== 'matched').length;
    return {
      stateFile: this.stateFile,
      eventCount: events.length,
      unmatchedEvents,
      events,
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  recordEvent(event) {
    if (!event || !event.id || !event.repo || !event.state) {
      return { ok: true, ignored: true, matchedSubscriptionIds: [] };
    }
    if (this.prune()) this.persist();
    const matchedSubscriptionIds = [];
    const targetMatchedSubscriptionIds = [];
    let changed = false;
    for (const subscription of this.state.subscriptions) {
      if (!eventMatchesSubscriptionTarget(event, subscription)) continue;
      targetMatchedSubscriptionIds.push(subscription.id);
      const receivedAtMs = Date.parse(event.receivedAt || '');
      const previousActivityMs = Date.parse(subscription.lastActivityAt || '');
      if (!Number.isFinite(previousActivityMs) || !Number.isFinite(receivedAtMs) || receivedAtMs >= previousActivityMs) {
        const activityAt = Number.isFinite(receivedAtMs)
          ? new Date(receivedAtMs).toISOString()
          : new Date(this.now()).toISOString();
        const activityChanged = subscription.lastActivityAt !== activityAt
          || subscription.lastActivityState !== event.state
          || subscription.lastActivityAction !== event.action
          || subscription.lastActivityRunId !== event.runId;
        if (activityChanged) {
          subscription.lastActivityAt = activityAt;
          subscription.lastActivityState = event.state;
          subscription.lastActivityAction = event.action;
          subscription.lastActivityRunId = event.runId;
          changed = true;
        }
      }
      if (!eventMatchesSubscription(event, subscription)) continue;
      matchedSubscriptionIds.push(subscription.id);
      if (subscription.pending.some(({ id }) => id === event.id)) continue;
      if (subscription.pending.length >= MAX_PENDING_EVENTS) {
        this.metrics.pendingOverflow += 1;
        continue;
      }
      subscription.pending.push(event);
      this.metrics.matchedEvents += 1;
      changed = true;
    }
    this.appendEventAudit({
      event,
      eventName: event.eventName,
      deliveryId: event.id,
      targetMatchedSubscriptionIds,
      matchedSubscriptionIds,
    });
    changed = true;
    if (changed) this.persist();
    return {
      ok: true,
      event,
      targetMatchedSubscriptionIds,
      matchedSubscriptionIds,
    };
  }

  ingestWebhook({ eventName, deliveryId, signature, rawBody, payload, receivedAt = new Date(this.now()).toISOString() }) {
    if (!this.webhookSecret) {
      throw brokerError('event_webhook_secret_unconfigured', 'webhook secret is not configured');
    }
    const normalizedDeliveryId = normalizedString(deliveryId);
    if (!normalizedDeliveryId) throw brokerError('event_delivery_id_required', 'X-GitHub-Delivery is required');
    const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(payload ?? {});
    if (!verifyWebhookSignature(body, signature, this.webhookSecret)) {
      throw brokerError('event_webhook_signature_invalid', 'GitHub webhook signature is invalid');
    }
    let webhookPayload = payload;
    if (!webhookPayload) {
      try { webhookPayload = JSON.parse(body); } catch (error) {
        throw brokerError('event_webhook_payload_invalid', `webhook payload is not valid JSON: ${error.message}`);
      }
    }
    if (this.prune()) this.persist();
    const seen = this.state.seenDeliveries.some(({ id }) => id === normalizedDeliveryId);
    if (seen) {
      this.metrics.webhookDuplicates += 1;
      return { ok: true, duplicate: true, matchedSubscriptionIds: [] };
    }
    this.state.seenDeliveries.push({ id: normalizedDeliveryId, seenAtMs: this.now() });
    this.metrics.webhookEvents += 1;
    const event = normalizeWebhookEvent({
      eventName,
      deliveryId: normalizedDeliveryId,
      payload: webhookPayload,
      receivedAt,
    });
    if (!event) {
      this.metrics.webhookIgnored += 1;
      this.appendEventAudit({
        eventName,
        deliveryId: normalizedDeliveryId,
        ignoredReason: 'unsupported_event',
      });
      this.persist();
      return { ok: true, ignored: true, matchedSubscriptionIds: [] };
    }
    const result = this.recordEvent(event);
    if (!result.matchedSubscriptionIds.length) this.persist();
    return { ...result, duplicate: false };
  }
}
