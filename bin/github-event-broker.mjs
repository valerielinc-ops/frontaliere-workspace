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

const MAX_PENDING_EVENTS = 32;
const MAX_SEEN_DELIVERIES = 5_000;
const SEEN_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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
    once: spec.once !== false,
    createdAt: new Date(nowMs).toISOString(),
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    pending: [],
  };
}

function subscriptionPublic(subscription) {
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
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { version: EVENT_BROKER_STATE_VERSION, subscriptions: [], seenDeliveries: [] };
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

  prune() {
    const nowMs = this.now();
    const subscriptionsBefore = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter((subscription) => subscription.expiresAtMs > nowMs);
    this.metrics.subscriptionsExpired += subscriptionsBefore - this.state.subscriptions.length;
    const seenBefore = this.state.seenDeliveries.length;
    this.state.seenDeliveries = this.state.seenDeliveries
      .filter((delivery) => nowMs - Number(delivery.seenAtMs) <= SEEN_DELIVERY_TTL_MS)
      .slice(-MAX_SEEN_DELIVERIES);
    return subscriptionsBefore !== this.state.subscriptions.length
      || seenBefore !== this.state.seenDeliveries.length;
  }

  status() {
    if (this.prune()) this.persist();
    return {
      stateFile: this.stateFile,
      subscriptions: this.state.subscriptions.map(subscriptionPublic),
      pendingEvents: this.state.subscriptions.reduce((total, subscription) => total + subscription.pending.length, 0),
      metrics: { ...this.metrics },
    };
  }

  subscribe(spec) {
    this.prune();
    const nowMs = this.now();
    const normalized = normalizeSubscriptionSpec(spec, nowMs);
    normalized.id = `sub-${randomUUID()}`;
    this.state.subscriptions.push(normalized);
    this.metrics.subscriptionsCreated += 1;
    this.persist();
    return subscriptionPublic(normalized);
  }

  getSubscription(subscriptionId) {
    if (this.prune()) this.persist();
    const subscription = this.state.subscriptions.find(({ id }) => id === String(subscriptionId || ''));
    return subscription ? subscriptionPublic(subscription) : null;
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
