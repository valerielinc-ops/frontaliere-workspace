#!/usr/bin/env node

/**
 * Versioned, fail-closed routing policy for GitHub event coordinators.
 *
 * The selected coordinator identity is explicit at the process boundary.  A
 * route mismatch must therefore stop before a REST request or broker write;
 * this module deliberately never redirects a request to another identity.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = dirname(THIS_DIR);
export const EVENT_ROUTING_CONFIG_PATH = `${WORKSPACE_DIR}/config/github-event-routing.json`;
const EVENT_ROUTING_CONFIG_LABEL = relative(WORKSPACE_DIR, EVENT_ROUTING_CONFIG_PATH);
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9._-]+$/;
const CONFIG_VERSION = 1;

function normalizedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function routingError(code, message, details = {}) {
  const error = new Error(message);
  Object.assign(error, { code, exitCode: 2 }, details);
  return error;
}

function configError(message, cause = null) {
  return routingError(
    'event_identity_route_config_invalid',
    `${message}; controlla ${EVENT_ROUTING_CONFIG_LABEL}`,
    cause ? { cause } : {},
  );
}

function assertValidRepo(repo, { source = 'event subscription' } = {}) {
  if (!REPO_PATTERN.test(repo || '')) {
    throw routingError(
      'event_repo_invalid',
      `${source} requires owner/repo`,
      {
        repo: repo || null,
        actualIdentity: null,
        expectedIdentity: null,
        nextAction: 'fornisci --repo owner/repo',
      },
    );
  }
  return repo;
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9._/@:+,=-]+$/.test(text)
    ? text
    : `'${text.replace(/'/g, "'\\''")}'`;
}

function subscriptionCommand(spec, identity) {
  const repo = normalizedString(spec?.repo) || '<owner/repo>';
  const args = [
    'bin/gh-frontaliere',
    '--identity',
    identity,
    'events',
    'subscribe',
    '--repo',
    repo,
  ];
  for (const [key, option] of [
    ['resource', '--resource'],
    ['number', '--number'],
    ['runId', '--run-id'],
    ['workflow', '--workflow'],
    ['branch', '--branch'],
    ['sha', '--sha'],
    ['environment', '--environment'],
    ['deploymentId', '--deployment-id'],
  ]) {
    const value = spec?.[key];
    if (value !== null && value !== undefined && String(value).trim()) {
      args.push(option, String(value));
    }
  }
  const waitFor = Array.isArray(spec?.waitFor)
    ? spec.waitFor.filter((state) => normalizedString(state))
    : [];
  if (waitFor.length) args.push('--wait-for', waitFor.join(','));
  if (spec?.followLatest === true) args.push('--follow-latest');
  return args.map(shellQuote).join(' ');
}

function routeNextAction({ repo, expectedIdentity, spec, operation }) {
  if (expectedIdentity) {
    if (operation === 'webhook') {
      return `inoltra la delivery al receiver/coordinatore con identità ${expectedIdentity}, per esempio bin/github-webhook --identity ${expectedIdentity}; non autoroutare ${repo}`;
    }
    const action = operation === 'reconcile'
      ? 'ricrea o ricollega la subscription'
      : `riesegui ${operation}`;
    return `${action} con l'identità autorizzata: ${subscriptionCommand(spec, expectedIdentity)}`;
  }
  const command = operation === 'webhook'
    ? 'bin/github-webhook --identity [identità-configurata]'
    : subscriptionCommand(spec, '<identità-configurata>');
  return `aggiungi ${repo}: "<identità>" a ${EVENT_ROUTING_CONFIG_LABEL}, poi riesegui l'operazione con l'identità configurata (nessun autoroute) - comando: ${command}`;
}

export function loadEventRouting(configPath = EVENT_ROUTING_CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw configError(`impossibile leggere il file di routing (${error.code || error.message})`, error);
  }
  if (!raw || typeof raw !== 'object' || raw.version !== CONFIG_VERSION || !raw.routes
    || typeof raw.routes !== 'object' || Array.isArray(raw.routes)) {
    throw configError(`schema non valido: richiesti version=${CONFIG_VERSION} e routes oggetto`);
  }
  const routes = new Map();
  for (const [repoValue, identityValue] of Object.entries(raw.routes)) {
    const repo = normalizedString(repoValue);
    const identity = normalizedString(identityValue)?.toLowerCase();
    if (!repo || !REPO_PATTERN.test(repo)) {
      throw configError(`repo non valido nella route: ${repoValue}`);
    }
    if (!identity || !IDENTITY_PATTERN.test(identity)) {
      throw configError(`identità non valida nella route ${repo}`);
    }
    if (routes.has(repo)) throw configError(`route duplicata: ${repo}`);
    routes.set(repo, identity);
  }
  if (routes.size === 0) throw configError('routes non può essere vuoto');
  return { version: CONFIG_VERSION, routes };
}

export function hasEventRoute(repoValue, {
  configPath = EVENT_ROUTING_CONFIG_PATH,
  routing = null,
} = {}) {
  const repo = normalizedString(repoValue);
  if (!repo || !REPO_PATTERN.test(repo)) return false;
  const { routes } = routing || loadEventRouting(configPath);
  return routes.has(repo);
}

export function assertEventIdentity({
  spec,
  actualIdentity,
  operation = 'subscribe',
  configPath = EVENT_ROUTING_CONFIG_PATH,
  routing = null,
}) {
  const repo = assertValidRepo(normalizedString(spec?.repo) || '');
  const actual = (normalizedString(actualIdentity) || 'default').toLowerCase();
  if (!IDENTITY_PATTERN.test(actual)) {
    throw routingError(
      'event_identity_invalid',
      `identità coordinatore non valida: ${actual}`,
      {
        repo,
        actualIdentity: actual,
        expectedIdentity: null,
        nextAction: 'seleziona un\'identità coordinatore valida',
      },
    );
  }
  const { routes } = routing || loadEventRouting(configPath);
  const expected = routes.get(repo) || null;
  const nextAction = routeNextAction({ repo, expectedIdentity: expected, spec, operation });
  if (!expected) {
    throw routingError(
      'event_identity_route_missing',
      `nessuna identità autorizzata per ${repo}`,
      {
        repo,
        actualIdentity: actual,
        expectedIdentity: null,
        nextAction,
      },
    );
  }
  if (actual !== expected) {
    throw routingError(
      'event_identity_mismatch',
      `identità ${actual} non autorizzata per ${repo}; attesa ${expected}`,
      {
        repo,
        actualIdentity: actual,
        expectedIdentity: expected,
        nextAction,
      },
    );
  }
  return { repo, actualIdentity: actual, expectedIdentity: expected };
}
