/**
 * Guard for the self-driven Pages deploy queue.
 *
 * Agent requests must never enqueue deploy.yml or deploy-publish.yml. The
 * workflows dispatch their own next run with GITHUB_TOKEN; an owner can use
 * the explicit environment override documented in CLAUDE.md for recovery.
 */

export const OWNER_DEPLOY_DISPATCH_ENV = 'FRONTALIERE_OWNER_DEPLOY_DISPATCH';
export const OWNER_DEPLOY_DISPATCH_OVERRIDE = 'I_UNDERSTAND_DEPLOY_DISPATCH';

const BLOCKED_WORKFLOWS = new Set(['deploy.yml', 'deploy-publish.yml']);
const API_OPTIONS_WITH_VALUE = new Set([
  '--cache', '--field', '--header', '--hostname', '--input', '--jq', '--method',
  '--preview', '--raw-field', '--repo', '--template', '-F', '-H', '-f', '-t', '-X',
]);

function workflowBasename(value) {
  const raw = String(value || '').trim().split(/[?#]/, 1)[0];
  if (!raw) return null;
  const basename = raw.split('/').pop();
  return BLOCKED_WORKFLOWS.has(basename) ? basename : null;
}

function workflowFromDispatchPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/\/actions\/workflows\/([^/]+)\/dispatches\/?$/i);
  if (!match) return null;
  try {
    return workflowBasename(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function parseApiArgs(args) {
  if (!Array.isArray(args)) return null;
  const apiIndex = args.indexOf('api');
  if (apiIndex < 0) return null;
  let endpoint = null;
  let method = null;
  let hasBody = false;
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
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(value)
      || /^(--field|--raw-field|--input)=/.test(value)) {
      hasBody = true;
    }
    if (API_OPTIONS_WITH_VALUE.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    if (endpoint === null) endpoint = value;
  }
  if (!endpoint) return null;
  return {
    path: endpoint,
    method: String(method || (hasBody ? 'POST' : 'GET')).toUpperCase(),
  };
}

function cliWorkflowDispatch(args) {
  if (!Array.isArray(args)) return null;
  const workflowIndex = args.findIndex((value, index) => (
    String(value) === 'workflow' && String(args[index + 1] || '') === 'run'
  ));
  if (workflowIndex < 0) return null;
  const workflow = workflowBasename(args[workflowIndex + 2]);
  return workflow ? { workflow, kind: 'workflow-cli', target: `gh workflow run ${workflow}` } : null;
}

export function deployDispatchDetails(request) {
  if (request?.type === 'api') {
    const workflow = String(request.method || 'GET').toUpperCase() === 'POST'
      ? workflowFromDispatchPath(request.path)
      : null;
    return workflow
      ? { workflow, kind: 'rest-api', target: `${request.method || 'POST'} ${request.path}` }
      : null;
  }
  if (request?.type !== 'exec') return null;
  const workflow = cliWorkflowDispatch(request.args);
  if (workflow) return workflow;
  const parsed = parseApiArgs(request.args);
  const apiWorkflow = parsed?.method === 'POST' ? workflowFromDispatchPath(parsed.path) : null;
  return apiWorkflow
    ? { workflow: apiWorkflow, kind: 'rest-cli', target: `${parsed.method} ${parsed.path}` }
    : null;
}

export function ownerDeployDispatchOverrideFromEnvironment(environment = process.env) {
  return String(environment?.[OWNER_DEPLOY_DISPATCH_ENV] || '')
    === OWNER_DEPLOY_DISPATCH_OVERRIDE;
}

export function deployDispatchBlockedResponse(details) {
  const message = [
    `dispatch agent bloccato per ${details.workflow}: il deploy è auto-rilanciato dal workflow e non va accodato manualmente`,
    `target: ${details.target}`,
    `override proprietario esplicito: ${OWNER_DEPLOY_DISPATCH_ENV}=${OWNER_DEPLOY_DISPATCH_OVERRIDE}`,
  ].join('\n');
  return {
    ok: false,
    exitCode: 2,
    stdout: '',
    stderr: `${message}\n`,
    error: {
      code: 'deploy_dispatch_blocked',
      message,
      workflow: details.workflow,
      target: details.target,
      exitCode: 2,
    },
  };
}

