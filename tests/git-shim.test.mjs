import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const SHIM = join(ROOT, 'bin', 'git-shim');

function fakeGitSource(version, callsFile) {
  return `#!/bin/sh
if [ "$1" = --version ]; then printf 'git version ${version}\\n'; exit 0; fi
printf '%s\\n' "$*" >>"${callsFile}"
if [ "$1" = -C ]; then target=$2; shift 2; else target=$PWD; fi
case "$1" in
  config)
    if [ "$2" = --get ] && [ "$3" = frontaliere.fetchThrottleSeconds ]; then
      [ -n "\${FAKE_THROTTLE_SECONDS:-}" ] || exit 1
      printf '%s\\n' "$FAKE_THROTTLE_SECONDS"
      exit 0
    fi
    ;;
  rev-parse)
    case "$2" in
      --show-toplevel) printf '%s\\n' "$FAKE_REPO_ROOT"; exit 0 ;;
      --git-common-dir) printf '.git\\n'; exit 0 ;;
    esac
    ;;
esac
exit 0
`;
}

function fixture({ recentRef = false, recentReflog = false, lock = false, throttleSeconds = '30', version = '2.56.0', sleepBody = 'sleep "$1"' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'git shim fixture-'));
  const home = join(root, 'home');
  const tools = join(root, 'tools');
  const repo = join(root, 'repo');
  const gitDir = join(repo, '.git');
  const calls = join(root, 'calls.log');
  const sleepCalls = join(root, 'sleep-calls.log');
  mkdirSync(join(gitDir, 'refs', 'remotes', 'origin'), { recursive: true });
  mkdirSync(tools, { recursive: true });
  const fakeGit = join(tools, 'git-real');
  writeFileSync(fakeGit, fakeGitSource(version, calls), { mode: 0o755 });
  chmodSync(fakeGit, 0o755);
  writeFileSync(join(tools, 'sleep'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${sleepCalls}"\n${sleepBody}\n`, { mode: 0o755 });
  if (recentRef) {
    const refPath = join(gitDir, 'refs', 'remotes', 'origin', 'main');
    writeFileSync(refPath, '1111111111111111111111111111111111111111\n');
    const now = new Date();
    utimesSync(refPath, now, now);
  }
  if (recentReflog) {
    const reflogDir = join(gitDir, 'logs', 'refs', 'remotes', 'origin');
    mkdirSync(reflogDir, { recursive: true });
    const reflog = join(reflogDir, 'main');
    const epoch = Math.floor(Date.now() / 1000);
    writeFileSync(reflog, `0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 Agent <agent@example.test> ${epoch} +0000\tfetch origin main\n`);
    const past = new Date(Date.now() - 5 * 60_000);
    utimesSync(reflog, past, past);
  }
  if (lock) mkdirSync(join(gitDir, 'frontaliere-fetch-main.lock'));
  const env = {
    ...process.env,
    HOME: home,
    FRONTALIERE_GIT_BIN: fakeGit,
    FRONTALIERE_SLEEP_BIN: join(tools, 'sleep'),
    FAKE_REPO_ROOT: repo,
    FAKE_THROTTLE_SECONDS: throttleSeconds,
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  return { root, home, tools, repo, gitDir, fakeGit, calls, sleepCalls, env };
}

function runShim(fixtureData, args, extraEnv = {}) {
  return spawnSync('/bin/sh', [SHIM, ...args], { encoding: 'utf8', env: { ...fixtureData.env, ...extraEnv } });
}

function fetchCalls(data) {
  if (!existsSync(data.calls)) return [];
  return readFileSync(data.calls, 'utf8').split('\n').filter((line) => /(^| )fetch( |$)/.test(line));
}

test('throttles every supported exact origin/main fetch form and respects quiet flags', () => {
  const forms = [
    { args: ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], quiet: true },
    { args: ['fetch', '--quiet', 'origin', 'main'], quiet: true },
    { args: ['fetch', 'origin', 'main', '-q'], quiet: true },
    { args: ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main', '--no-tags'], quiet: false },
    { args: ['fetch', 'origin', 'main', '--prune', '--no-tags'], quiet: false },
    { args: ['-C', '/target/repo', 'fetch', 'origin', 'main', '-p', '--quiet'], quiet: true },
  ];
  for (const form of forms) {
    const data = fixture({ recentRef: true });
    try {
      const result = runShim(data, form.args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fetchCalls(data).length, 0, JSON.stringify(form.args));
      if (form.quiet) assert.equal(result.stderr, '');
      else assert.match(result.stderr, /skipped recent fetch/);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  }
});

test('uses the reflog timestamp when the loose ref is absent and supports opt-out', () => {
  const data = fixture({ recentReflog: true });
  try {
    const skipped = runShim(data, ['fetch', 'origin', 'main']);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(fetchCalls(data).length, 0);
    assert.match(skipped.stderr, /skipped recent fetch/);

    const optedOut = runShim(data, ['fetch', 'origin', 'main'], { FRONTALIERE_FETCH_THROTTLE: '0' });
    assert.equal(optedOut.status, 0, optedOut.stderr);
    assert.equal(fetchCalls(data).length, 1, 'opt-out delegates the exact fetch to Git');
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('passes through other refspecs, depth/refetch flags, and unrelated Git commands', () => {
  const data = fixture({ recentRef: true });
  const commands = [
    ['fetch', 'origin', 'topic'],
    ['fetch', 'origin', 'refs/heads/main'],
    ['fetch', 'origin', 'main', '--unshallow'],
    ['fetch', '--refetch', 'origin', 'main'],
    ['fetch', 'origin', '--depth=1', 'main'],
    ['status'],
  ];
  try {
    for (const args of commands) {
      const result = runShim(data, args);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    }
    const calls = readFileSync(data.calls, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(calls.slice(-commands.length), commands.map((args) => args.join(' ')));
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('waits on a concurrent main fetch and skips when its ref advances', () => {
  const data = fixture({ lock: true, sleepBody: 'touch "$FAKE_REPO_ROOT/.git/refs/remotes/origin/main"' });
  try {
    const result = runShim(data, ['fetch', 'origin', 'main']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fetchCalls(data).length, 0);
    assert.equal(readFileSync(data.sleepCalls, 'utf8').trim(), '1');
    assert.match(result.stderr, /skipped recent fetch/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('a main fetch owns and releases the common-gitdir lock when no recent update exists', () => {
  const data = fixture();
  try {
    const result = runShim(data, ['fetch', 'origin', 'main']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fetchCalls(data).length, 1);
    assert.equal(existsSync(join(data.gitDir, 'frontaliere-fetch-main.lock')), false);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('selects the newest local Git at or above 2.44 when the explicit candidate is old', () => {
  const data = fixture({ recentRef: true });
  try {
    const localOld = join(data.home, '.local', 'git-2.45.1', 'bin', 'git');
    const localNew = join(data.home, '.local', 'git-2.56.0', 'bin', 'git');
    const oldCalls = join(data.root, 'old.log');
    const newCalls = join(data.root, 'new.log');
    const explicitCalls = join(data.root, 'explicit.log');
    mkdirSync(join(localOld, '..'), { recursive: true });
    mkdirSync(join(localNew, '..'), { recursive: true });
    writeFileSync(localOld, fakeGitSource('2.45.1', oldCalls), { mode: 0o755 });
    writeFileSync(localNew, fakeGitSource('2.56.0', newCalls), { mode: 0o755 });
    const explicitGit = join(data.tools, 'git-old');
    writeFileSync(explicitGit, fakeGitSource('2.39.2', explicitCalls), { mode: 0o755 });
    data.env.FRONTALIERE_GIT_BIN = explicitGit;
    const result = runShim(data, ['fetch', 'origin', 'main']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fetchCalls(data).length, 0, 'the selected modern Git observed the recent ref');
    assert.equal(existsSync(newCalls), true, 'the highest local Git handled config/rev-parse');
    assert.equal(existsSync(oldCalls), false);
    assert.equal(existsSync(explicitCalls), false);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
