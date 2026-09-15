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

const MAX_PENDING_EVENTS = 32;
const MAX_SEEN_DELIVERIES = 5_000;
const SEEN_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_LATENCY_SAMPLES = 200;
const MIN_ESTIMATE_SAMPLES = 3;

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
    error: 'failed',
    failure: 'failed',
    timed_out: 'failed',
    startup_failure: 'failed',
  };
  return aliases[state] || state;
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

function subscriptionTargetKey(subscription) {
  const selectors = [
    ['number', subscription.number],
    ['run', subscription.runId],
    ['sha', subscription.sha],
    ['environment', subscription.environment],
    ['workflow', subscription.workflow],
    ['deployment', subscription.deploymentId],
  ].map(([name, value]) => `${name}=${value === null || value === undefined ? '*' : value}`);
  return `${subscription.repo}|${subscription.resource}|${selectors.join('|')}`;
}

function subscriptionDedupKey(subscription) {
  return `${subscriptionTargetKey(subscription)}|wait=${[...subscription.waitFor].sort().join(',')}`;
}

function latencySampleKey(subscription) {
  return `${subscription.resource}:${[...subscription.waitFor].sort().join(',')}`;
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
  const number = spec.number === undefined || spec.number === null ? null : Number(spec.number);
  if (number !== null && (!Number.isInteger(number) || number <= 0)) {
    throw brokerError('event_number_invalid', 'event subscription number must be a positive integer');
  }
  return {
    agentId: normalizedString(spec.agentId ?? spec.agent_id ?? spec.sessionId ?? spec.session_id) || 'anonymous-agent',
    resource,
    repo,
    number,
    runId: spec.runId === undefined || spec.runId === null ? null : String(spec.runId),
    sha: normalizedString(spec.sha),
    environment: normalizedString(spec.environment),
    workflow: normalizedString(spec.workflow),
    deploymentId: spec.deploymentId === undefined || spec.deploymentId === null ? null : String(spec.deploymentId),
    waitFor: subscriptionStates(spec),
    allowDuplicate: spec.allowDuplicate === true || spec.allow_duplicate === true,
    shared: spec.shared === true || spec.sharedObserver === true,
    once: spec.once !== false,
    createdAt: new Date(nowMs).toISOString(),
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
  const waitState = subscription.pending.length > 0 ? 'event_pending' : 'waiting_external';
  const nextAction = waitState === 'event_pending'
    ? 'ack_event'
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
    waitFor: subscription.waitFor,
    once: subscription.once,
    createdAt: subscription.createdAt,
    expiresAt: subscription.expiresAt,
    pendingEvents: subscription.pending.length,
    ageMs,
    remainingMs,
    waitBudgetMs,
    deadlineAt: subscription.expiresAt,
    estimatedDecisionAt,
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
    ...estimate,
  };
}

function storedLatencySample(value) {
  if (!value || typeof value !== 'object') return null;
  const resource = canonicalResource(value.resource);
  const waitForKey = normalizedString(value.waitForKey);
  const waitMs = Number(value.waitMs);
  if (!['pull_request', 'workflow_run', 'deployment'].includes(resource)
    || !waitForKey
    || !Number.isFinite(waitMs)
    || waitMs < 0) return null;
  return {
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
    once: value.once !== false,
    createdAt: normalizedString(value.createdAt) || new Date().toISOString(),
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    pending: Array.isArray(value.pending) ? value.pending : [],
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
  deploymentId = null,
  environment = null,
  sha = null,
  conclusion = null,
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
    deploymentId: deploymentId === null || deploymentId === undefined ? null : String(deploymentId),
    environment,
    sha,
    conclusion: normalizedState(conclusion),
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
    const state = merged ? 'merged' : action;
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'pull_request',
      resources: [],
      state,
      states: merged ? ['closed'] : [],
      action,
      number: pullRequest.number || payload.number || null,
      sha: pullRequest.head?.sha || null,
      url: pullRequest.html_url || null,
      receivedAt,
    });
  }

  if (event === 'pull_request_review') {
    const pullRequest = payload.pull_request || {};
    const reviewState = normalizedState(payload.review?.state);
    const state = reviewState === 'needs_review'
      ? 'needs_review'
      : reviewState === 'approved'
        ? 'approved'
        : normalizedState(payload.action);
    return normalizedEvent({
      deliveryId,
      eventName: event,
      repo,
      resource: 'pull_request',
      resources: [],
      state,
      states: reviewState ? [reviewState] : [],
      action: payload.action,
      number: pullRequest.number || payload.number || null,
      sha: pullRequest.head?.sha || null,
      url: payload.review?.html_url || pullRequest.html_url || null,
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
  if (!event || !subscription || event.repo !== subscription.repo) return false;
  const resources = event.resources || [event.resource];
  if (!resources.includes(subscription.resource)) return false;
  if (subscription.number !== null && subscription.number !== undefined) {
    const numbers = [event.number, ...(event.pullRequestNumbers || [])].map((value) => Number(value));
    if (!numbers.includes(subscription.number)) return false;
  }
  if (subscription.runId && String(event.runId) !== String(subscription.runId)) return false;
  if (subscription.sha && event.sha !== subscription.sha) return false;
  if (subscription.environment && event.environment !== subscription.environment) return false;
  if (subscription.workflow && event.workflow !== subscription.workflow) return false;
  if (subscription.deploymentId && String(event.deploymentId) !== String(subscription.deploymentId)) return false;
  const states = event.states || [event.state];
  return subscription.waitFor.some((state) => states.includes(state));
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
    const state = merged ? 'merged' : normalizedState(data.state);
    return normalizedEvent({
      deliveryId,
      eventName: 'reconciliation',
      repo: subscription.repo,
      resource: 'pull_request',
      resources: [],
      state,
      states: merged ? ['closed'] : [],
      action: data.state,
      number: data.number || subscription.number || null,
      sha: data.head?.sha || data.head_sha || null,
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
  constructor({ stateFile, webhookSecret, now = () => Date.now() }) {
    if (!stateFile) throw new TypeError('event_state_file_required');
    this.stateFile = stateFile;
    this.webhookSecret = webhookSecret || null;
    this.now = now;
    this.metrics = {
      subscriptionsCreated: 0,
      subscriptionsExpired: 0,
      subscriptionsAcknowledged: 0,
      webhookEvents: 0,
      webhookDuplicates: 0,
      webhookIgnored: 0,
      matchedEvents: 0,
      pendingOverflow: 0,
      latencySamplesRecorded: 0,
      subscriptionsGarbageCollected: 0,
    };
    this.state = this.loadState();
  }

  loadState() {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.stateFile), 0o700); } catch { /* best effort */ }
    try {
      const raw = readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
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
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { version: EVENT_BROKER_STATE_VERSION, subscriptions: [], seenDeliveries: [], latencySamples: [] };
      }
      throw error;
    }
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

  duplicateTargetCounts() {
    const counts = new Map();
    for (const subscription of this.state.subscriptions) {
      const key = subscriptionTargetKey(subscription);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  duplicateGroups() {
    const groups = new Map();
    for (const subscription of this.state.subscriptions) {
      const targetKey = subscriptionTargetKey(subscription);
      if (!groups.has(targetKey)) groups.set(targetKey, []);
      groups.get(targetKey).push(subscription);
    }
    return [...groups.entries()]
      .filter(([, subscriptions]) => subscriptions.length > 1)
      .map(([targetKey, subscriptions]) => ({
        targetKey,
        count: subscriptions.length,
        subscriptionIds: subscriptions.map(({ id }) => id),
        agentIds: unique(subscriptions.map(({ agentId }) => agentId)),
      }));
  }

  estimateFor(subscription) {
    const exactKey = latencySampleKey(subscription);
    const exact = this.state.latencySamples.filter((sample) => sample.waitForKey === exactKey);
    const resourceSamples = this.state.latencySamples.filter((sample) => sample.resource === subscription.resource);
    if (exact.length >= MIN_ESTIMATE_SAMPLES) return summarizeWaitEstimate(exact, 'same_wait_for');
    if (resourceSamples.length) return summarizeWaitEstimate(resourceSamples, 'resource');
    return summarizeWaitEstimate([], 'none');
  }

  publicSubscription(subscription, options = {}) {
    const duplicateTargetCount = this.duplicateTargetCounts().get(subscriptionTargetKey(subscription)) || 1;
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

  summary({ listenerAttached = null } = {}) {
    if (this.prune()) this.persist();
    const subscriptions = this.state.subscriptions;
    const duplicateGroups = this.duplicateGroups();
    const latencyByResource = new Map();
    for (const sample of this.state.latencySamples) {
      if (!latencyByResource.has(sample.resource)) latencyByResource.set(sample.resource, []);
      latencyByResource.get(sample.resource).push(sample);
    }
    const listenerCount = this.listenerCount(listenerAttached);
    return {
      stateFile: this.stateFile,
      subscriptionCount: subscriptions.length,
      agentCount: unique(subscriptions.map(({ agentId }) => agentId)).length,
      pendingEvents: subscriptions.reduce((total, subscription) => total + subscription.pending.length, 0),
      listenerCount,
      orphanedSubscriptions: listenerCount === null
        ? null
        : subscriptions.filter(({ id }) => listenerAttachedValue(listenerAttached, id) !== true).length,
      duplicateGroups,
      duplicateSubscriptions: duplicateGroups.reduce((total, group) => total + group.count - 1, 0),
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

  status({ listenerAttached = null } = {}) {
    if (this.prune()) this.persist();
    return {
      stateFile: this.stateFile,
      subscriptions: this.state.subscriptions.map((subscription) => this.publicSubscription(subscription, {
        nowMs: this.now(),
        listenerAttached: listenerAttachedValue(listenerAttached, subscription.id),
      })),
      pendingEvents: this.state.subscriptions.reduce((total, subscription) => total + subscription.pending.length, 0),
      metrics: { ...this.metrics },
      summary: this.summary({ listenerAttached }),
    };
  }

  subscribe(spec) {
    this.prune();
    const nowMs = this.now();
    const normalized = normalizeSubscriptionSpec(spec, nowMs);
    const allowDuplicate = normalized.allowDuplicate === true;
    const shared = normalized.shared === true;
    const agentId = normalized.agentId;
    delete normalized.allowDuplicate;
    const duplicate = this.state.subscriptions
      .filter((subscription) => subscriptionDedupKey(subscription) === subscriptionDedupKey(normalized))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
    if (duplicate && shared && duplicate.shared) {
      if (!duplicate.sharedAgentIds.includes(agentId)) duplicate.sharedAgentIds.push(agentId);
      this.persist();
      return this.publicSubscription(duplicate, { nowMs, sharedJoin: true });
    }
    if (duplicate && !allowDuplicate) {
      const error = brokerError(
        'event_duplicate_subscription',
        'an observer for this exact target and wait state already exists; reuse the shared observer',
      );
      error.existingSubscriptionId = duplicate.id;
      error.existingSubscription = this.publicSubscription(duplicate, { nowMs });
      error.targetKey = subscriptionTargetKey(duplicate);
      error.sharedObserverRecommended = true;
      throw error;
    }
    if (shared) normalized.sharedAgentIds = [agentId];
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
    const duplicateCounts = this.duplicateTargetCounts();
    const candidates = this.state.subscriptions.filter((subscription) => {
      const createdAtMs = Date.parse(subscription.createdAt);
      const oldEnough = Number.isFinite(createdAtMs) && nowMs - createdAtMs >= grace;
      const noListener = listenerAttachedValue(listenerAttached, subscription.id) === false;
      const noPending = subscription.pending.length === 0;
      const duplicate = (duplicateCounts.get(subscriptionTargetKey(subscription)) || 0) > 1;
      return oldEnough && noListener && noPending && (duplicate || includeUnique);
    });
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
        resource: subscription.resource,
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

  recordEvent(event) {
    if (!event || !event.id || !event.repo || !event.state) {
      return { ok: true, ignored: true, matchedSubscriptionIds: [] };
    }
    if (this.prune()) this.persist();
    const matchedSubscriptionIds = [];
    let changed = false;
    for (const subscription of this.state.subscriptions) {
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
    if (changed) this.persist();
    return { ok: true, event, matchedSubscriptionIds };
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
      this.persist();
      return { ok: true, ignored: true, matchedSubscriptionIds: [] };
    }
    const result = this.recordEvent(event);
    if (!result.matchedSubscriptionIds.length) this.persist();
    return { ...result, duplicate: false };
  }
}
