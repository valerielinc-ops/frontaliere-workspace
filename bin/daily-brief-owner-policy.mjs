#!/usr/bin/env node

/**
 * Owner-only guard for re-enabling the daily brief workflow.
 *
 * The workflow is intentionally identified three ways because `gh` accepts a
 * workflow name, filename, or numeric id, while the REST endpoint accepts the
 * filename or id in its path.
 */

export const DAILY_BRIEF_WORKFLOW_ID = '329980428';
export const DAILY_BRIEF_WORKFLOW_NAME = 'Send Daily Brief Email';
export const DAILY_BRIEF_WORKFLOW_PATH = 'send-daily-brief.yml';

const WORKFLOW_SELECTORS = new Set([
  DAILY_BRIEF_WORKFLOW_ID,
  DAILY_BRIEF_WORKFLOW_NAME.toLowerCase(),
  DAILY_BRIEF_WORKFLOW_PATH.toLowerCase(),
]);

const API_OPTIONS_WITH_VALUE = new Set([
  '--cache', '--field', '--header', '--hostname', '--input', '--jq', '--method',
  '--preview', '--raw-field', '--repo', '--template', '-F', '-H', '-f', '-t', '-X',
]);

function cleanSelector(value) {
  const raw = String(value || '').trim().split(/[?#]/, 1)[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
function selectorDetails(value) {
  const selector = cleanSelector(value);
  if (!selector) return null;
  const normalized = selector.toLowerCase();
  const basename = normalized.split('/').pop();
  if (!WORKFLOW_SELECTORS.has(normalized) && !WORKFLOW_SELECTORS.has(basename)) return null;
  return {
    selector,
    workflow: DAILY_BRIEF_WORKFLOW_PATH,
    workflowId: DAILY_BRIEF_WORKFLOW_ID,
    workflowName: DAILY_BRIEF_WORKFLOW_NAME,
  };
}

function repoFromArguments(args) {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if ((value === '--repo' || value === '-R') && args[index + 1]) return String(args[index + 1]);
    if (value.startsWith('--repo=')) return value.slice('--repo='.length);
  }
  return null;
}

function apiWorkflowEnableDetails(pathname, method, inheritedRepo = null) {
  if (String(method || 'GET').toUpperCase() !== 'PUT') return null;
  const rawPath = String(pathname || '').trim();
  if (!rawPath) return null;
  let path = rawPath;
  try {
    if (/^https?:\/\//i.test(rawPath)) path = new URL(rawPath).pathname;
  } catch {
    return null;
  }
  const match = path.split('?')[0].match(/\/actions\/workflows\/([^/]+)\/enable\/?$/i);
  if (!match) return null;
  const selector = selectorDetails(match[1]);
  if (!selector) return null;
  const repoMatch = path.match(/\/repos\/([^/]+\/[^/]+)\/actions\/workflows\//i);
  return {
    kind: 'daily-brief-workflow-enable',
    repo: repoMatch?.[1] || inheritedRepo || null,
    target: `PUT ${path}`,
    ...selector,
  };
}

function parseApiArguments(args) {
  if (!Array.isArray(args)) return null;
  const apiIndex = args.indexOf('api');
  if (apiIndex < 0) return null;
  let endpoint = null;
  let method = null;
  for (let index = apiIndex + 1; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === '--method' || value === '-X') {
      method = String(args[index + 1] || '');
      index += 1;
      continue;
    }
    if (value.startsWith('--method=')) {
      method = value.slice('--method='.length);
      continue;
    }
    if (API_OPTIONS_WITH_VALUE.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    if (endpoint === null) endpoint = value;
  }
  if (!endpoint) return null;
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const repo = repoFromArguments(args);
  const scopedPath = repo && /^\/actions\/workflows\//i.test(path)
    ? `/repos/${repo}${path}`
    : path;
  return { path: scopedPath, method: method || 'GET', repo };
}

function cliWorkflowEnableDetails(args) {
  if (!Array.isArray(args)) return null;
  const enableIndex = args.findIndex((value, index) => (
    String(value) === 'workflow' && String(args[index + 1] || '') === 'enable'
  ));
  if (enableIndex < 0) return null;

  let selector = null;
  for (let index = enableIndex + 2; index < args.length; index += 1) {
    const value = String(args[index]);
    if ((value === '--repo' || value === '-R') && args[index + 1]) {
      index += 1;
      continue;
    }
    if (value.startsWith('--repo=')) continue;
    if (value.startsWith('-')) continue;
    selector = value;
    break;
  }
  const details = selectorDetails(selector);
  if (!details) return null;
  return {
    kind: 'daily-brief-workflow-enable',
    repo: repoFromArguments(args),
    target: `gh workflow enable ${selector}`,
    ...details,
  };
}

/**
 * Return owner-confirmation details for the daily-brief enable mutation, or
 * null for every unrelated read, write, workflow, and API request.
 */
export function dailyBriefWorkflowEnableDetails(request) {
  if (request?.type === 'api') {
    return apiWorkflowEnableDetails(request.path, request.method, request.repo || null);
  }
  if (request?.type !== 'exec' || !Array.isArray(request.args)) return null;
  return cliWorkflowEnableDetails(request.args)
    || (() => {
      const parsed = parseApiArguments(request.args);
      return parsed ? apiWorkflowEnableDetails(parsed.path, parsed.method, parsed.repo) : null;
    })();
}
