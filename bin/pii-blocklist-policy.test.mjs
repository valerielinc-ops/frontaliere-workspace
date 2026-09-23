import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPiiBlocklistCommand,
  policyResult,
  resolvedBlocklistPath,
} from './pii-blocklist-policy.mjs';

const ROOT = dirname(new URL(import.meta.url).pathname);
const POLICY = join(ROOT, 'pii-blocklist-policy.mjs');

function runPolicy(command, cwd = process.cwd()) {
  return spawnSync(process.execPath, [POLICY], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ cwd, tool_input: { command } }),
  });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function linkedWorktreeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pii-blocklist-policy-'));
  const worktree = join(root, 'linked');
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'PII gate test']);
  git(root, ['config', 'user.email', 'pii-gate-test@example.invalid']);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  git(root, ['worktree', 'add', '--quiet', '-b', 'linked-test', worktree]);
  const info = git(worktree, ['rev-parse', '--git-path', 'info']);
  writeFileSync(join(info, 'pii-blocklist.txt'), 'PRIVATE_MARKER\n');
  return { root, worktree };
}

test('rejects the literal .git/info path before a worker can use it', () => {
  const result = runPolicy('git diff --cached | grep -niE -f .git/info/pii-blocklist.txt');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rev-parse --git-path/);
});

test('does not reject a quoted documentation search for the historical path', () => {
  const command = "rg -n '\\.git/info/pii-blocklist\\.txt' AGENTS.md";
  assert.equal(isPiiBlocklistCommand(command), false);
  assert.equal(runPolicy(command).status, 0);
});

test('accepts the canonical resolver from a linked worktree', () => {
  const { root, worktree } = linkedWorktreeFixture();
  try {
    const expected = resolvedBlocklistPath(worktree);
    assert.ok(expected?.endsWith('/pii-blocklist.txt'));
    assert.equal(policyResult({
      cwd: worktree,
      command: 'BL="$(git rev-parse --git-path info/pii-blocklist.txt)"; test -f "$BL"',
    }).allowed, true);
    assert.equal(runPolicy(
      'BL="$(git rev-parse --git-path info/pii-blocklist.txt)"; test -f "$BL"',
      worktree,
    ).status, 0);
    assert.match(readFileSync(expected, 'utf8'), /^PRIVATE_MARKER\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a canonical-looking scan when the per-clone file is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pii-blocklist-missing-'));
  try {
    git(root, ['init', '--quiet']);
    const result = runPolicy(
      'BL="$(git rev-parse --git-path info/pii-blocklist.txt)"; test -f "$BL"',
      root,
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocklist assente/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both root hook configurations invoke the same policy', () => {
  const configs = ['.claude/settings.json', '.codex/hooks.json'];
  const commands = configs.map((config) => {
    const parsed = JSON.parse(readFileSync(join(ROOT, '..', config), 'utf8'));
    return parsed.hooks.PreToolUse[0].hooks.map((hook) => hook.command).find(
      (command) => command.includes('pii-blocklist-policy.mjs'),
    );
  });
  assert.ok(commands.every(Boolean));
  assert.equal(commands[0], commands[1]);
});
