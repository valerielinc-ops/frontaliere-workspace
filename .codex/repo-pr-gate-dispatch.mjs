/**
 * Dispatch the workspace's local PR gates to the repository named by gh.
 *
 * The workspace session starts at the parent repository, while PRs may be
 * opened from one of its independent child repositories.  The old root hook
 * always ran the site's sibling gate, so a corpus PR was analysed against the
 * site's HEAD and could never identify its own branch.
 *
 * This dispatcher keeps the site gate as the default for backwards
 * compatibility, routes an explicit --repo to the matching child checkout,
 * and is deliberately a no-op when that repository has no sibling gate.  The
 * latter is not a CI bypass: the repository's own remote checks still run;
 * it only avoids applying another repository's local gate to it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN_REPOSITORIES = new Map([
  ['valerielinc-ops/frontaliere-si-o-no', 'frontaliere-si-o-no'],
  ['nanakokyobashi-rgb/frontaliere-articles', 'frontaliere-articles'],
  ['nanakokyobashi-rgb/frontaliere-reddit-devvit', 'frontaliere-reddit-devvit'],
]);

const REPO_FLAG_RE = /(?:^|\s)(?:--repo|-R)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;
const REPO_FLAG_TEST_RE = /(?:^|\s)(?:--repo|-R)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/;

/**
 * @param {string} command
 * @returns {string|undefined}
 */
export function explicitRepository(command) {
  for (const match of String(command ?? '').matchAll(REPO_FLAG_RE)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (KNOWN_REPOSITORIES.has(value)) return value;
  }
  return undefined;
}

/**
 * @param {string} command
 * @returns {boolean}
 */
export function hasExplicitRepositoryFlag(command) {
  return REPO_FLAG_TEST_RE.test(String(command ?? ''));
}

/**
 * @param {string|undefined} repository
 * @param {string} workspaceRoot
 * @returns {string|undefined}
 */
export function repositoryDirectory(repository, workspaceRoot = ROOT) {
  if (repository === undefined) return join(workspaceRoot, 'frontaliere-si-o-no');
  const child = KNOWN_REPOSITORIES.get(repository);
  return child ? join(workspaceRoot, child) : undefined;
}

/**
 * @param {string} rawPayload
 * @returns {{ command: string }|undefined}
 */
function parsePayload(rawPayload) {
  try {
    const payload = JSON.parse(rawPayload);
    return {
      command: String(payload?.tool_input?.command ?? payload?.command ?? ''),
    };
  } catch {
    return undefined;
  }
}

function main() {
  let rawPayload;
  try {
    rawPayload = readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }

  const parsed = parsePayload(rawPayload.trim());
  if (!parsed || !parsed.command.includes('gh pr create')) process.exit(0);

  const workspaceRoot = process.env.WORKSPACE || ROOT;
  const repository = explicitRepository(parsed.command);
  if (hasExplicitRepositoryFlag(parsed.command) && repository === undefined) process.exit(0);
  const repositoryRoot = repositoryDirectory(repository, workspaceRoot);
  if (!repositoryRoot) process.exit(0);
  const gate = join(repositoryRoot, 'scripts', 'ci', 'sibling-check-gate.mjs');

  // A child repository without this repository-specific gate must not inherit
  // the site's gate. Its GitHub workflows remain the enforcement boundary.
  if (!existsSync(gate)) process.exit(0);

  const result = spawnSync(process.execPath, [gate], {
    cwd: repositoryRoot,
    input: rawPayload,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  process.exit(result.error ? 0 : (result.status ?? 0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
