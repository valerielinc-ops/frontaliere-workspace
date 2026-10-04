/**
 * Fixture shared by the dispatcher and pr-gate-cache tests: a workspace whose
 * site checkout sits on another session's branch, plus a worktree for the
 * branch under review and a hooks-main worktree on main. Every copy of the
 * gate only prints which copy it is and blocks.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATE_PATH = join('scripts', 'ci', 'sibling-check-gate.mjs');

export function gateFixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pr-gate-dispatch-')));
  const site = join(workspace, 'frontaliere-si-o-no');
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const writeGate = (checkout, label) => {
    mkdirSync(join(checkout, 'scripts', 'ci'), { recursive: true });
    writeFileSync(join(checkout, GATE_PATH), `process.stderr.write('gate: ${label}\\n');\nprocess.exit(2);\n`);
  };
  mkdirSync(site, { recursive: true });
  git(site, 'init', '-q', '-b', 'main');
  git(site, 'config', 'user.email', 'test@example.com');
  git(site, 'config', 'user.name', 'test');
  writeGate(site, 'origin-main');
  git(site, 'add', '-A');
  git(site, 'commit', '-q', '-m', 'main');
  const feature = join(site, '.claude', 'worktrees', 'feat');
  git(site, 'worktree', 'add', '-q', '-b', 'feat', feature, 'main');
  writeGate(feature, 'head-worktree');
  git(feature, 'commit', '-q', '-am', 'feat');
  git(site, 'worktree', 'add', '-q', '--detach', join(site, '.claude', 'worktrees', 'hooks-main'), 'main');
  git(site, 'checkout', '-q', '-b', 'someone-elses-branch');
  writeGate(site, 'stale-main-checkout');
  git(site, 'commit', '-q', '-am', 'stale');
  return { workspace, site, feature, git, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}
