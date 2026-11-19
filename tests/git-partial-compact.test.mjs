import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'bin', 'git-partial-compact');

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...overrides,
  };
}

function parseVersion(output) {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output || '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function resolveGit() {
  const candidates = [];
  for (const directory of (process.env.PATH || '').split(':')) {
    const candidate = join(directory, 'git');
    try {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      const version = result.status === 0 ? parseVersion(result.stdout) : null;
      if (version) candidates.push({ candidate, version });
    } catch { /* Try the next PATH entry. */ }
  }
  const home = process.env.HOME || '';
  for (const candidate of [join(home, '.local', 'bin', 'git'), '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      const version = result.status === 0 ? parseVersion(result.stdout) : null;
      if (version) candidates.push({ candidate, version });
    } catch { /* Candidate absent. */ }
  }
  try {
    for (const entry of readdirSync(join(home, '.local'))) {
      if (!/^git-[^/]+$/.test(entry)) continue;
      const candidate = join(home, '.local', entry, 'bin', 'git');
      try {
        const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
        const version = result.status === 0 ? parseVersion(result.stdout) : null;
        if (version) candidates.push({ candidate, version });
      } catch { /* Candidate absent. */ }
    }
  } catch { /* No versioned Git directory under ~/.local. */ }
  candidates.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) if (left.version[index] !== right.version[index]) return right.version[index] - left.version[index];
    const leftIsShim = /\/\.local\/bin\/git$/.test(left.candidate);
    const rightIsShim = /\/\.local\/bin\/git$/.test(right.candidate);
    return Number(leftIsShim) - Number(rightIsShim);
  });
  return candidates.find((entry) => entry.version[0] > 2 || (entry.version[0] === 2 && entry.version[1] >= 44))?.candidate || null;
}

const GIT = resolveGit();
const GIT_VERSION = GIT
  ? spawnSync(GIT, ['--version'], { encoding: 'utf8' }).stdout.trim()
  : (spawnSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }).stdout || 'Git non trovato').trim();
const INTEGRATION_SKIP = GIT ? false : `${GIT_VERSION} è inferiore a 2.44; test d'integrazione richiede --no-lazy-fetch`;

function tempRoot(t, prefix = 'git-partial-compact-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env: options.env || cleanEnv(),
    maxBuffer: options.maxBuffer || 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return run(GIT, ['-C', cwd, ...args], {
    ...options,
    env: cleanEnv({ GIT_NO_LAZY_FETCH: '1', ...(options.env || {}) }),
  }).stdout.trimEnd();
}

function gitLazy(cwd, args, options = {}) {
  return run(GIT, ['-C', cwd, ...args], {
    ...options,
    env: cleanEnv(options.env || {}),
  }).stdout.trimEnd();
}

function runTool(args, root, extraEnv = {}, options = {}) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return run(process.execPath, [SCRIPT, ...args], {
    allowFailure: options.allowFailure,
    env: cleanEnv({
      HOME: home,
      FRONTALIERE_GIT_BIN: GIT,
      FRONTALIERE_MAINTENANCE_LOCK: join(root, 'locks', 'git-maintenance.lock'),
      FRONTALIERE_GIT_PARTIAL_COMPACT_STATE: join(root, 'state', 'last'),
      FRONTALIERE_GIT_PARTIAL_COMPACT_LOG: join(root, 'logs', 'compact.log'),
      ...extraEnv,
    }),
  });
}

function createFixture(root, { partial = true } = {}) {
  const source = join(root, 'source');
  const bare = join(root, 'origin.git');
  const repo = join(root, 'clone');
  mkdirSync(source, { recursive: true });
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.name', 'Partial Compact Test']);
  git(source, ['config', 'user.email', 'partial-compact@example.invalid']);

  mkdirSync(join(source, 'archive'), { recursive: true });
  mkdirSync(join(source, 'docs'), { recursive: true });
  mkdirSync(join(source, 'public'), { recursive: true });
  writeFileSync(join(source, 'archive', 'history.json'), JSON.stringify({ version: 1, data: 'historical-' + 'a'.repeat(60_000) }));
  writeFileSync(join(source, 'docs', 'guide.md'), 'guide v1\n');
  writeFileSync(join(source, 'public', 'catalog.json'), JSON.stringify({ version: 1, data: 'catalog-' + 'p'.repeat(20_000) }));
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'first historical version']);
  const oldCommit = git(source, ['rev-parse', 'HEAD']);
  const oldBlob = git(source, ['rev-parse', 'HEAD:archive/history.json']);

  writeFileSync(join(source, 'archive', 'history.json'), JSON.stringify({ version: 2, data: 'current-' + 'b'.repeat(60_000) }));
  writeFileSync(join(source, 'docs', 'guide.md'), 'guide v2\n');
  writeFileSync(join(source, 'public', 'catalog.json'), JSON.stringify({ version: 2, data: 'catalog-current-' + 'q'.repeat(20_000) }));
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'second historical version']);

  git(source, ['branch', 'obsolete']);
  git(source, ['checkout', '-q', 'obsolete']);
  writeFileSync(join(source, 'retired-only.json'), JSON.stringify({ retired: true, data: 'retired-' + 'z'.repeat(30_000) }));
  git(source, ['add', 'retired-only.json']);
  git(source, ['commit', '-qm', 'branch later deleted from remote']);
  const retiredCommit = git(source, ['rev-parse', 'HEAD']);
  const retiredBlob = git(source, ['rev-parse', 'HEAD:retired-only.json']);
  git(source, ['checkout', '-q', 'main']);

  git(source, ['checkout', '-qb', 'offline']);
  writeFileSync(join(source, 'offline-only.json'), JSON.stringify({ offline: true, data: 'unfetched-' + 'o'.repeat(24_000) }));
  git(source, ['add', 'offline-only.json']);
  git(source, ['commit', '-qm', 'branch whose blob remains unfetched']);
  const offlineBlob = git(source, ['rev-parse', 'HEAD:offline-only.json']);
  git(source, ['checkout', '-q', 'main']);

  run(GIT, ['init', '--bare', '-q', bare]);
  git(source, ['push', '-q', bare, 'main', 'obsolete', 'offline']);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(bare, ['config', 'uploadpack.allowFilter', 'true']);
  git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const cloneArgs = ['-c', 'protocol.file.allow=always', 'clone', '-q', '--no-local'];
  if (partial) cloneArgs.push('--filter=blob:none');
  cloneArgs.push(bare, repo);
  run(GIT, cloneArgs);

  git(repo, ['config', 'user.name', 'Partial Compact Test']);
  git(repo, ['config', 'user.email', 'partial-compact@example.invalid']);
  if (!partial) return { root, source, bare, repo, oldCommit, oldBlob, retiredCommit, retiredBlob };

  gitLazy(repo, ['checkout', '-qb', 'local-retired', 'refs/remotes/origin/obsolete']);
  const localRetiredBlob = git(repo, ['rev-parse', 'HEAD:retired-only.json']);
  git(repo, ['branch', 'local-offline', 'refs/remotes/origin/offline']);
  assert.equal(existsObject(repo, offlineBlob), false, 'il blob non materializzato del branch remoto deve restare assente');
  git(bare, ['update-ref', '-d', 'refs/heads/obsolete']);
  git(bare, ['update-ref', '-d', 'refs/heads/offline']);
  git(repo, ['update-ref', '-d', 'refs/remotes/origin/obsolete']);
  git(repo, ['update-ref', '-d', 'refs/remotes/origin/offline']);
  git(repo, ['checkout', '-q', 'main']);

  git(repo, ['checkout', '-qb', 'agent-only']);
  writeFileSync(join(repo, 'unpublished-only.json'), JSON.stringify({ unpublished: true, data: 'local-' + 'u'.repeat(35_000) }));
  git(repo, ['add', 'unpublished-only.json']);
  git(repo, ['commit', '-qm', 'unpublished local commit']);
  const unpublishedCommit = git(repo, ['rev-parse', 'HEAD']);
  const unpublishedBlob = git(repo, ['rev-parse', 'HEAD:unpublished-only.json']);
  git(repo, ['checkout', '-q', 'main']);

  const sparse = join(root, 'sparse-worktree');
  gitLazy(repo, ['worktree', 'add', '--detach', sparse, 'refs/remotes/origin/main']);
  git(sparse, ['sparse-checkout', 'init', '--cone']);
  git(sparse, ['sparse-checkout', 'set', 'docs']);

  writeFileSync(join(repo, 'archive', 'history.json'), JSON.stringify({ version: 3, data: 'stashed-' + 'c'.repeat(60_000) }));
  git(repo, ['stash', 'push', '-qm', 'preserve local snapshot']);
  const stashCommit = git(repo, ['rev-parse', 'refs/stash']);
  const stashBlob = git(repo, ['rev-parse', 'refs/stash:archive/history.json']);
  writeFileSync(join(repo, 'archive', 'history.json'), JSON.stringify({ version: 4, data: 'working-' + 'd'.repeat(60_000) }));

  writeFileSync(join(repo, 'docs', 'guide.md'), 'staged index version\n');
  git(repo, ['add', 'docs/guide.md']);
  const indexBlob = git(repo, ['rev-parse', ':docs/guide.md']);
  writeFileSync(join(repo, 'docs', 'guide.md'), 'staged and unstaged version\n');
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes', 'untracked.txt'), 'untracked worktree data\n');

  return {
    root, source, bare, repo, sparse, oldCommit, oldBlob, retiredCommit, retiredBlob,
    localRetiredBlob, offlineBlob, unpublishedCommit, unpublishedBlob, stashCommit, stashBlob, indexBlob,
  };
}

function packNames(repo) {
  return readdirSync(join(repo, '.git', 'objects', 'pack')).filter((name) => name.endsWith('.pack')).sort();
}

function existsObject(repo, oid, lazy = false) {
  const env = cleanEnv(lazy ? {} : { GIT_NO_LAZY_FETCH: '1' });
  const result = run(GIT, ['--no-lazy-fetch', '-C', repo, 'cat-file', '-e', oid], { allowFailure: true, env });
  return result.status === 0;
}

function statusBytes(worktree) {
  return run(GIT, ['--no-lazy-fetch', '-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: null,
    env: cleanEnv({ GIT_NO_LAZY_FETCH: '1' }),
  }).stdout;
}

function assertNoPlaceholders(contents) {
  assert.doesNotMatch(contents, /__(?:NODE_PATH|SCRIPT_PATH|SITE_REPO|WORKSPACE|HOME|LOG_DIR)__/);
}

test('git troppo vecchio viene rifiutato tramite eseguibile finto', (t) => {
  const root = tempRoot(t, 'git-partial-compact-fake-');
  const fake = join(root, 'git-too-old');
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "git version 2.39.2\\n"; exit 0; fi\nexit 99\n', { mode: 0o700 });
  chmodSync(fake, 0o700);
  const result = run(process.execPath, [SCRIPT, '--repo', root], {
    allowFailure: true,
    env: cleanEnv({ FRONTALIERE_GIT_BIN: fake }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git >= 2\.44 richiesto/);
});

test('install e uninstall del LaunchAgent sono idempotenti e non invocano launchctl', (t) => {
  const root = tempRoot(t, 'git-partial-compact-install-');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const site = join(workspace, 'frontaliere-si-o-no');
  const agents = join(root, 'LaunchAgents');
  mkdirSync(site, { recursive: true });
  const env = cleanEnv({ HOME: home, FRONTALIERE_LAUNCH_AGENTS_DIR: agents, FRONTALIERE_WORKSPACE_ROOT: workspace });
  const target = join(agents, 'ch.frontaliere.git-partial-compact.plist');
  const first = run(process.execPath, [SCRIPT, 'install'], { env });
  assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(target, 'utf8');
  assertNoPlaceholders(original);
  assert.match(original, /ch\.frontaliere\.git-partial-compact/);
  assert.match(original, /--apply/);
  assert.match(original, /--if-needed/);
  assert.match(original, /<key>Weekday<\/key><integer>0<\/integer>/);
  assert.match(original, /<key>Hour<\/key><integer>5<\/integer>/);
  assert.match(original, /<key>Minute<\/key><integer>30<\/integer>/);
  assert.match(original, /<key>LowPriorityIO<\/key>\s*<true\/>/);
  assert.match(original, /<key>Nice<\/key>\s*<integer>10<\/integer>/);
  const before = statSync(target);
  run(process.execPath, [SCRIPT, 'install'], { env });
  const after = statSync(target);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  writeFileSync(join(agents, 'unrelated.plist'), 'keep');
  run(process.execPath, [SCRIPT, 'uninstall'], { env });
  run(process.execPath, [SCRIPT, 'uninstall'], { env });
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(join(agents, 'unrelated.plist'), 'utf8'), 'keep');
});

test('flock condivide il lock fallback del wrapper di manutenzione', async (t) => {
  const root = tempRoot(t, 'git-partial-compact-lock-');
  const home = join(root, 'home');
  const wrapperLock = join(home, 'Library', 'Logs', 'frontaliere', 'git-maintenance.lock');
  mkdirSync(dirname(wrapperLock), { recursive: true });
  const holder = spawn('python3', ['-c', [
    'import fcntl, os, sys',
    'fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)',
    'fcntl.flock(fd, fcntl.LOCK_EX)',
    'print("ready", flush=True)',
    'sys.stdin.readline()',
  ].join('; '), wrapperLock], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (holder.exitCode === null) holder.stdin.end('release\n');
    await new Promise((resolveExit) => holder.exitCode !== null ? resolveExit() : holder.once('exit', resolveExit));
  });
  await new Promise((resolveReady, rejectReady) => {
    holder.stdout.once('data', resolveReady);
    holder.once('error', rejectReady);
    holder.once('exit', (code) => rejectReady(new Error(`lock holder exited early: ${code}`)));
  });
  const result = run(process.execPath, [SCRIPT, '--repo', root, '--apply'], {
    allowFailure: true,
    env: cleanEnv({
      HOME: home,
      FRONTALIERE_MAINTENANCE_LOCK: join(root, 'state', 'git-maintenance.lock'),
    }),
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /flock occupato/);
});

test('pack-objects conserva commit e tree senza leggere blob storici assenti', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-pack-');
  const fixture = createFixture(root);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), false, 'il blob storico deve essere assente prima del pack');
  const scratch = mkdtempSync(join(root, 'pack-output-'));
  const prefix = join(scratch, 'pack-filtered');
  const result = run(GIT, ['--no-lazy-fetch', '-C', fixture.repo, 'pack-objects', '--revs', '--filter=blob:none', '--missing=allow-any', prefix], {
    input: `${git(fixture.repo, ['rev-parse', 'HEAD'])}\n`,
    env: cleanEnv({ GIT_NO_LAZY_FETCH: '1' }),
  });
  assert.match(result.stdout.trim(), /^[0-9a-f]{40,64}$/);
  assert.equal(existsObject(fixture.repo, `${git(fixture.repo, ['rev-parse', 'HEAD'])}^{tree}`), true);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), false, 'pack-objects non deve fare lazy fetch del blob');
  const pack = join(scratch, `pack-filtered-${result.stdout.trim()}.idx`);
  assert.equal(existsSync(pack), true);
});

test('dry-run non modifica pack, ref o stato del clone parziale', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-dry-');
  const fixture = createFixture(root);
  const beforePacks = packNames(fixture.repo);
  const packDirectory = join(fixture.repo, '.git', 'objects', 'pack');
  const beforePackFiles = readdirSync(packDirectory).sort();
  const beforeStatus = statusBytes(fixture.repo);
  const beforeConfig = git(fixture.repo, ['config', '--local', '--get', 'remote.origin.promisor']);
  const result = runTool(['--repo', fixture.repo, '--json'], root);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.repo, realpathSync(fixture.repo));
  assert.equal(summary.remote, 'origin');
  assert.equal(summary.apply, false);
  assert.ok(summary.packBytesBefore > 0);
  assert.ok(summary.localOnlyCommits > 0);
  assert.ok(summary.localOnlyObjectsEstimated > 0);
  assert.ok(summary.estimatedPackBytes > 0);
  assert.deepEqual(packNames(fixture.repo), beforePacks);
  assert.deepEqual(readdirSync(packDirectory).sort(), beforePackFiles);
  assert.deepEqual(statusBytes(fixture.repo), beforeStatus);
  assert.equal(git(fixture.repo, ['config', '--local', '--get', 'remote.origin.promisor']), beforeConfig);
  assert.equal(existsSync(join(root, 'state', 'last')), false);
  assert.equal(existsSync(join(root, 'logs', 'compact.log')), false);
});

test('--if-needed salta un clone sotto max(10 GiB, 4x ultima compattazione)', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-threshold-');
  const fixture = createFixture(root);
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'last'), 'epoch=1\nbyte_before=10\nbyte_after=100\npack_before=3\npack_after=1\nresult=success\n');
  const before = packNames(fixture.repo);
  const result = runTool(['--repo', fixture.repo, '--apply', '--if-needed', '--json'], root);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.result, 'skipped');
  assert.equal(summary.reason, 'sotto soglia');
  assert.equal(summary.thresholdBytes, 10 * 1024 ** 3);
  assert.deepEqual(packNames(fixture.repo), before);
  assert.equal(readFileSync(join(root, 'state', 'last'), 'utf8').includes('byte_after=100'), true);
});

test('apply conserva refs, stash, blob locali, index e status di worktree sparse e sporco', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-apply-');
  const fixture = createFixture(root);
  const worktrees = [fixture.repo, fixture.sparse];
  const beforeStatuses = new Map(worktrees.map((worktree) => [worktree, statusBytes(worktree)]));
  assert.match(git(fixture.sparse, ['ls-files', '-t']), /^S /m, 'fixture deve includere entry skip-worktree');
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), false);
  const result = runTool(['--repo', fixture.repo, '--apply', '--json'], root);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.result, 'success');
  assert.ok(summary.packCountAfter <= summary.packCountBefore + 1);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), false, 'nessuna verifica deve scaricare il blob storico');
  assert.equal(existsObject(fixture.repo, fixture.localRetiredBlob), true, 'blob del branch locale non più pubblicato');
  assert.equal(existsObject(fixture.repo, fixture.offlineBlob), false, 'blob già assente del branch locale eliminato dal remote resta saltato');
  assert.equal(existsObject(fixture.repo, fixture.unpublishedBlob), true, 'blob del commit locale non pubblicato');
  assert.equal(existsObject(fixture.repo, fixture.stashBlob), true, 'blob dello stash');
  assert.equal(existsObject(fixture.repo, fixture.indexBlob), true, 'blob presente solo nell’indice');
  assert.equal(git(fixture.repo, ['rev-parse', 'refs/stash']), fixture.stashCommit);
  assert.equal(git(fixture.repo, ['rev-parse', 'refs/heads/agent-only']), fixture.unpublishedCommit);
  assert.equal(git(fixture.repo, ['config', '--local', '--get', 'remote.origin.promisor']), 'true');
  assert.equal(readdirSync(join(fixture.repo, '.git', 'objects', 'pack')).some((name) => name.startsWith('pack-quarantine-')), false);
  for (const worktree of worktrees) assert.deepEqual(statusBytes(worktree), beforeStatuses.get(worktree));
  const commits = git(fixture.repo, ['rev-list', '--all']).split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    const tree = git(fixture.repo, ['rev-parse', `${commit}^{tree}`]);
    assert.equal(existsObject(fixture.repo, commit), true, `commit mancante ${commit}`);
    assert.equal(existsObject(fixture.repo, tree), true, `tree mancante ${tree}`);
  }
  assert.match(readFileSync(join(root, 'state', 'last'), 'utf8'), /result=success/);
  assert.match(readFileSync(join(root, 'logs', 'compact.log'), 'utf8'), /result=success/);
});

test('un clone completo si converte solo con --convert --apply', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-convert-');
  const fixture = createFixture(root, { partial: false });
  const beforeStatus = statusBytes(fixture.repo);
  const priorPromisor = run(GIT, ['-C', fixture.repo, 'config', '--local', '--get', 'remote.origin.promisor'], { allowFailure: true });
  assert.notEqual(priorPromisor.status, 0);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), true);
  const result = runTool(['--repo', fixture.repo, '--convert', '--apply', '--json'], root);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, 'convert');
  assert.equal(summary.result, 'success');
  assert.equal(git(fixture.repo, ['config', '--local', '--get', 'core.repositoryformatversion']), '1');
  assert.equal(git(fixture.repo, ['config', '--local', '--get', 'extensions.partialClone']), 'origin');
  assert.equal(git(fixture.repo, ['config', '--local', '--get', 'remote.origin.promisor']), 'true');
  assert.equal(git(fixture.repo, ['config', '--local', '--get', 'remote.origin.partialclonefilter']), 'blob:none');
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), false);
  assert.deepEqual(statusBytes(fixture.repo), beforeStatus);
});

test('errore dopo la quarantena ripristina pack, config di conversione e MIDX', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-rollback-');
  const fixture = createFixture(root, { partial: false });
  const beforePacks = packNames(fixture.repo);
  const beforeStatus = statusBytes(fixture.repo);
  const sentinel = join(root, 'injected-once');
  const fakeGit = join(root, 'git-fail-once');
  const fakeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== '--version' && args.includes('multi-pack-index') && args.includes('write') && !fs.existsSync(process.env.R4_FAIL_SENTINEL)) {
  fs.writeFileSync(process.env.R4_FAIL_SENTINEL, 'failed once');
  process.stderr.write('injected MIDX failure');
  process.exit(91);
}
const result = spawnSync(process.env.R4_REAL_GIT, args, { stdio: 'inherit', env: process.env });
process.exit(result.status === null ? 1 : result.status);
`;
  writeFileSync(fakeGit, fakeSource, { mode: 0o700 });
  chmodSync(fakeGit, 0o700);
  const result = runTool(['--repo', fixture.repo, '--convert', '--apply', '--json'], root, {
    FRONTALIERE_GIT_BIN: fakeGit,
    R4_REAL_GIT: GIT,
    R4_FAIL_SENTINEL: sentinel,
  }, { allowFailure: true });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /injected MIDX failure/);
  assert.deepEqual(packNames(fixture.repo), beforePacks);
  assert.deepEqual(statusBytes(fixture.repo), beforeStatus);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), true);
  assert.equal(git(fixture.repo, ['config', '--local', '--get', 'core.repositoryformatversion']), '0');
  assert.equal(run(GIT, ['-C', fixture.repo, 'config', '--local', '--get', 'extensions.partialClone'], { allowFailure: true }).status, 1);
  assert.equal(run(GIT, ['-C', fixture.repo, 'config', '--local', '--get', 'remote.origin.promisor'], { allowFailure: true }).status, 1);
  assert.equal(run(GIT, ['-C', fixture.repo, 'config', '--local', '--get', 'remote.origin.partialclonefilter'], { allowFailure: true }).status, 1);
  assert.equal(existsSync(join(fixture.repo, '.git', 'objects', 'pack', 'multi-pack-index')), true);
  assert.equal(readdirSync(join(fixture.repo, '.git', 'objects', 'pack')).some((name) => name.startsWith('pack-quarantine-')), false);
  assert.match(readFileSync(join(root, 'state', 'last'), 'utf8'), /result=failure/);
});

test('una modifica concorrente in un worktree durante la run non annulla la compattazione', { skip: INTEGRATION_SKIP }, (t) => {
  // Sul Mac agenti una run dura 1-2 ore mentre gli agenti lavorano nei
  // worktree: lo status cambia per lavoro concorrente, non per corruzione.
  const root = tempRoot(t, 'git-partial-compact-concurrent-');
  const fixture = createFixture(root, { partial: true });
  const sentinel = join(root, 'edited-once');
  const fakeGit = join(root, 'git-edit-during-run');
  writeFileSync(fakeGit, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('multi-pack-index') && args.includes('write') && !fs.existsSync(process.env.R4_EDIT_SENTINEL)) {
  fs.writeFileSync(process.env.R4_EDIT_SENTINEL, 'edited');
  fs.appendFileSync(process.env.R4_EDIT_TARGET, 'concurrent agent edit\\n');
}
const result = spawnSync(process.env.R4_REAL_GIT, args, { stdio: 'inherit', env: process.env });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o700 });
  chmodSync(fakeGit, 0o700);
  const result = runTool(['--repo', fixture.repo, '--apply', '--json'], root, {
    FRONTALIERE_GIT_BIN: fakeGit,
    R4_REAL_GIT: GIT,
    R4_EDIT_SENTINEL: sentinel,
    R4_EDIT_TARGET: join(fixture.repo, 'notes', 'concurrent-agent.txt'),
  }, { allowFailure: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result, 'success');
  assert.equal(existsSync(sentinel), true, 'the concurrent edit happened mid-run');
  assert.match(result.stderr, /status cambiato durante la run \(lavoro concorrente\)/);
  assert.match(readFileSync(join(fixture.repo, 'notes', 'concurrent-agent.txt'), 'utf8'), /concurrent agent edit/);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), false, 'historical remote blob was still dropped');
});

test('apply rifiuta operazioni Git in corso e spazio insufficiente senza spostare pack', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-guards-');
  const fixture = createFixture(root);
  const beforePacks = packNames(fixture.repo);
  writeFileSync(join(fixture.repo, '.git', 'MERGE_HEAD'), 'pending merge\n');
  const dryRun = runTool(['--repo', fixture.repo, '--json'], root);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunSummary = JSON.parse(dryRun.stdout);
  assert.equal(dryRunSummary.applyAllowed, false);
  assert.ok(dryRunSummary.safetyBlockers.some((marker) => marker.endsWith('/MERGE_HEAD')));
  const merge = runTool(['--repo', fixture.repo, '--apply', '--json'], root, {}, { allowFailure: true });
  assert.notEqual(merge.status, 0);
  assert.match(merge.stderr, /operazione Git o gc in corso/);
  rmSync(join(fixture.repo, '.git', 'MERGE_HEAD'));
  const lowSpace = runTool(['--repo', fixture.repo, '--apply', '--json'], root, { FRONTALIERE_GIT_PARTIAL_COMPACT_FREE_BYTES: '0' }, { allowFailure: true });
  assert.equal(lowSpace.status, 1);
  assert.match(JSON.parse(lowSpace.stdout).error, /spazio insufficiente: richiesti \d+ byte/);
  assert.deepEqual(packNames(fixture.repo), beforePacks);
});

test('blob remoto mancante viene recuperato in lazy fetch economico', { skip: INTEGRATION_SKIP }, (t) => {
  const root = tempRoot(t, 'git-partial-compact-lazy-');
  const fixture = createFixture(root);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), false);
  const before = packNames(fixture.repo).length;
  const result = run(GIT, ['-C', fixture.repo, 'cat-file', '-e', fixture.oldBlob], { env: cleanEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsObject(fixture.repo, fixture.oldBlob), true);
  assert.ok(packNames(fixture.repo).length > before, 'il fetch deve aggiungere il pack promisor del blob richiesto');
});
