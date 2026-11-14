/**
 * Guard against "update branch" calls on the site and corpus repositories.
 *
 * A PR branch updated through the API (`gh pr update-branch`, `PUT
 * /repos/<o>/<r>/pulls/<n>/update-branch`, or the GraphQL mutation
 * `updatePullRequestBranch`) gets a "Merge branch 'main' into X" commit made
 * by GitHub web-flow.  That commit changes HEAD, cancels the runs in flight
 * and invalidates the review/LGTM of every PR it touches (2026-11-14: 162 such
 * commits in one wave).  The rule is frontaliere-si-o-no/AGENTS.md:71: never
 * merge origin/main "per profilassi".  Conflicts are handled locally with
 * `git merge-tree` and a local merge, only when a conflict really exists.
 *
 * The owner can override with the explicit environment value documented in
 * CLAUDE.md.  The same detection works on structured coordinator requests and
 * on a raw shell command (PreToolUse hook feedback).
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export const OWNER_UPDATE_BRANCH_ENV = 'FRONTALIERE_OWNER_UPDATE_BRANCH';
export const OWNER_UPDATE_BRANCH_OVERRIDE = 'I_UNDERSTAND_UPDATE_BRANCH';

export const GUARDED_REPOS = Object.freeze([
  'valerielinc-ops/frontaliere-si-o-no',
  'nanakokyobashi-rgb/frontaliere-articles',
]);

const GUARDED_SET = new Set(GUARDED_REPOS);
const READ_METHODS = new Set(['GET', 'HEAD']);
const OPTIONS_WITH_VALUE = new Set([
  '--cache', '--field', '--header', '--hostname', '--input', '--jq', '--method',
  '--preview', '--raw-field', '--repo', '--template', '-F', '-H', '-f', '-q', '-R', '-t', '-X',
]);
const BODY_OPTIONS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
const REST_PATH_RE = /^\/?repos\/([^/\s]+)\/([^/\s]+)\/pulls\/([^/\s?#]+)\/update-branch\/?(?:[?#].*)?$/i;
const GRAPHQL_MARKER_RE = /updatePullRequestBranch/i;

function normalizedRepo(owner, name) {
  return `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
}

function isConcreteRepo(repo) {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) && !repo.includes('{');
}

/** `null` when the repo is a concrete repo outside the guard, otherwise a guarded/unknown repo label. */
function guardedRepoLabel(repo) {
  if (!repo || !isConcreteRepo(repo)) return 'repo non esplicito';
  return GUARDED_SET.has(repo) ? repo : null;
}

function repoFromUrlOrPath(value) {
  const text = String(value || '');
  const url = text.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\//i);
  if (url) return normalizedRepo(url[1], url[2]);
  return null;
}

function repoOption(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === '--repo' || value === '-R') {
      return String(args[index + 1] || '').replace(/^https?:\/\/github\.com\//i, '').toLowerCase();
    }
    if (value.startsWith('--repo=')) return value.slice('--repo='.length).toLowerCase();
  }
  return null;
}

function restUpdateBranch(path, method) {
  if (READ_METHODS.has(String(method || 'GET').toUpperCase())) return null;
  let pathname = String(path || '').trim();
  try {
    if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(REST_PATH_RE);
  if (!match) return null;
  const label = guardedRepoLabel(normalizedRepo(match[1], match[2]));
  return label ? { repo: label, number: match[3] } : null;
}

function describe(kind, target, repo) {
  return { kind, target, repo };
}

function parseApi(args) {
  const apiIndex = args.findIndex((value) => String(value) === 'api');
  if (apiIndex < 0) return null;
  let endpoint = null;
  let method = null;
  let hasBody = false;
  const values = [];
  const files = [];
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
    if (BODY_OPTIONS.has(value) || /^(--field|--raw-field|--input)=/.test(value)) hasBody = true;
    if (value.startsWith('--input=')) files.push(value.slice('--input='.length));
    if (OPTIONS_WITH_VALUE.has(value)) {
      const operand = String(args[index + 1] || '');
      if (value === '--input') files.push(operand);
      else if (/^query=@/.test(operand)) files.push(operand.slice('query=@'.length));
      values.push(operand);
      index += 1;
      continue;
    }
    if (value.startsWith('-')) {
      values.push(value);
      continue;
    }
    if (endpoint === null) endpoint = value;
    else values.push(value);
  }
  const graphql = endpoint === 'graphql' || endpoint === '/graphql';
  return {
    endpoint,
    graphql,
    method: String(method || (hasBody || graphql ? 'POST' : 'GET')).toUpperCase(),
    values,
    files,
  };
}

/** Text of a GraphQL document kept in a file (`query=@file`, `--input file`); null when unreadable. */
function readDocument(file, cwd) {
  if (!file || file === '-') return null;
  try {
    const path = resolvePath(typeof cwd === 'string' && cwd ? cwd : process.cwd(), file);
    if (statSync(path).size > 1_000_000) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function updateBranchDetails(request) {
  if (request?.type === 'api') {
    const path = String(request.path || '');
    if (path === '/graphql' || path === 'graphql') {
      const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? '');
      return GRAPHQL_MARKER_RE.test(body)
        ? describe('graphql-mutation', 'graphql updatePullRequestBranch', 'repo non esplicito')
        : null;
    }
    const rest = restUpdateBranch(path, request.method);
    return rest
      ? describe('rest-api', `${String(request.method || 'PUT').toUpperCase()} ${path}`, rest.repo)
      : null;
  }
  if (request?.type !== 'exec' || !Array.isArray(request.args)) return null;
  const args = request.args.map(String);

  const prIndex = args.findIndex((value, index) => value === 'pr' && args[index + 1] === 'update-branch');
  if (prIndex >= 0) {
    const rest = args.slice(prIndex + 2);
    const repo = repoOption(args)
      || rest.map(repoFromUrlOrPath).find(Boolean)
      || null;
    const label = guardedRepoLabel(repo);
    return label ? describe('pr-cli', 'gh pr update-branch', label) : null;
  }

  const api = parseApi(args);
  if (!api) return null;
  if (api.graphql) {
    // The document may come from `-f query=...`, `-F query=@file` or `--input`:
    // inline text and readable files are both inspected; stdin cannot be.
    const named = api.values.some((value) => GRAPHQL_MARKER_RE.test(value))
      || api.files.some((file) => GRAPHQL_MARKER_RE.test(readDocument(file, request.cwd) || ''));
    return named
      ? describe('graphql-cli', 'gh api graphql updatePullRequestBranch', 'repo non esplicito')
      : null;
  }
  const rest = restUpdateBranch(api.endpoint, api.method);
  return rest ? describe('rest-cli', `${api.method} ${api.endpoint}`, rest.repo) : null;
}

export function ownerUpdateBranchOverrideFromEnvironment(environment = process.env) {
  return String(environment?.[OWNER_UPDATE_BRANCH_ENV] || '') === OWNER_UPDATE_BRANCH_OVERRIDE;
}

export function updateBranchMessage(details) {
  return [
    `update-branch agente bloccato (${details.repo}): produce un merge commit "Merge branch 'main' into ..." via web-flow che cambia la HEAD, cancella le run in corso e invalida review/LGTM`,
    `target: ${details.target}`,
    'regola: frontaliere-si-o-no/AGENTS.md:71 (MAI git merge origin/main per profilassi; main non e\' strict)',
    'conflitto reale? controlla con `git merge-tree --write-tree origin/main <head>` e risolvi con un merge locale nel worktree, poi push normale',
    `override proprietario esplicito: ${OWNER_UPDATE_BRANCH_ENV}=${OWNER_UPDATE_BRANCH_OVERRIDE}`,
  ].join('\n');
}

export function updateBranchBlockedResponse(details) {
  const message = updateBranchMessage(details);
  return {
    ok: false,
    exitCode: 2,
    stdout: '',
    stderr: `${message}\n`,
    error: {
      code: 'update_branch_blocked',
      message,
      target: details.target,
      exitCode: 2,
    },
  };
}

// ---------------------------------------------------------------------------
// Raw shell command (PreToolUse hook).  A small quote-aware tokenizer: it keeps
// quoted strings as single words (a GraphQL document is one word), splits
// commands on ; & | and newlines, and skips heredoc bodies so that text
// quoted in a PR body is never mistaken for an invocation.
// ---------------------------------------------------------------------------

function* shellSegments(command) {
  const source = String(command ?? '');
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const pendingHeredocs = [];
  let index = 0;

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };

  const segments = [];
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };

  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (quote === '"' && char === '\\' && index + 1 < source.length) {
        word += source[index + 1];
        index += 1;
      } else {
        word += char;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      index += 1;
      continue;
    }
    if (char === '\\' && index + 1 < source.length) {
      if (source[index + 1] !== '\n') {
        word += source[index + 1];
        inWord = true;
      }
      index += 2;
      continue;
    }
    if (char === '<' && source[index + 1] === '<' && source[index + 2] !== '<') {
      const match = source.slice(index).match(/^<<(-?)[ \t]*(?:(['"])(.*?)\2|([^\s;&|()<>]+))/);
      if (match) {
        pendingHeredocs.push({ delimiter: match[3] ?? match[4], stripTabs: match[1] === '-' });
        index += match[0].length;
        continue;
      }
    }
    if (char === '\n') {
      endSegment();
      index += 1;
      while (pendingHeredocs.length) {
        const heredoc = pendingHeredocs.shift();
        while (index < source.length) {
          const lineEnd = source.indexOf('\n', index);
          const end = lineEnd === -1 ? source.length : lineEnd;
          const line = source.slice(index, end);
          index = lineEnd === -1 ? source.length : lineEnd + 1;
          if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
        }
      }
      continue;
    }
    if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')') {
      endSegment();
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      index += 1;
      continue;
    }
    word += char;
    inWord = true;
    index += 1;
  }
  endSegment();
  yield* segments;
}

function ghArguments(words) {
  let position = 0;
  while (position < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[position])) position += 1;
  while (['command', 'exec', 'time', 'env', 'do', 'then'].includes(words[position])) {
    position += 1;
    while (position < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[position])) position += 1;
  }
  const program = String(words[position] || '').split('/').pop();
  if (!['gh', 'gh-frontaliere', 'gh-nanako'].includes(program)) return null;
  return words.slice(position + 1);
}

function inlineOverride(words) {
  return words.some((word) => word === `${OWNER_UPDATE_BRANCH_ENV}=${OWNER_UPDATE_BRANCH_OVERRIDE}`);
}

/** Details of the first update-branch invocation in a shell command, or null. */
export function updateBranchInCommand(command) {
  for (const words of shellSegments(command)) {
    const args = ghArguments(words);
    if (!args) continue;
    const details = updateBranchDetails({ type: 'exec', args });
    if (details) return { ...details, inlineOverride: inlineOverride(words) };
  }
  return null;
}
