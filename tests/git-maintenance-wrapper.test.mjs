import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const WRAPPER = join(ROOT, 'bin', 'git-maintenance-wrapper');

function fakeGitSource(version, callsFile) {
  return `#!/bin/sh
if [ "$1" = --version ]; then printf 'git version ${version}\\n'; exit 0; fi
if [ "$1" = -C ] && [ "$3" = rev-parse ]; then
  [ -d "$2/.git" ] || [ -f "$2/.git" ] || exit 128
  if [ "$4" = --absolute-git-dir ]; then printf '%s\\n' "$2/.git"; fi
  exit 0
fi
case "$*" in
  *"config --get frontaliere.maintenance.midxBatchSize"*)
    if [ -n "\${FAKE_MIDX_BATCH+x}" ]; then printf '%s\\n' "$FAKE_MIDX_BATCH"; exit 0; fi
    exit 1
    ;;
esac
printf '%s|lazy=%s\\n' "$*" "\${GIT_NO_LAZY_FETCH:-}" >>"${callsFile}"
`;
}

function makeFakeGit(path, version, calls) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, fakeGitSource(version, calls), { mode: 0o755 });
  chmodSync(path, 0o755);
  return { FRONTALIERE_GIT_BIN: path, FAKE_GIT_CALLS: calls };
}

function wrapperFixture({ pressure = 1, freeGib = 10, taskpolicyCap = true, batchConfig, gitVersion = '2.56.0', home: providedHome, logs: providedLogs, corpus = 'absent', omitArticlesEnv = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'git maintenance decision-'));
  const home = providedHome ?? join(root, 'home');
  const tools = join(root, 'tools');
  const workspace = join(root, 'workspace');
  const repo = join(workspace, 'frontaliere-si-o-no');
  const articlesRepo = join(workspace, 'frontaliere-articles');
  const logs = providedLogs ?? join(root, 'logs');
  const callsFile = join(root, 'git-calls.log');
  mkdirSync(join(repo, '.git', 'objects', 'pack'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  if (corpus !== 'absent') mkdirSync(articlesRepo, { recursive: true });
  if (corpus === 'git') mkdirSync(join(articlesRepo, '.git', 'objects', 'pack'), { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(repo, '.git', 'objects', 'pack', 'pack-a.pack'), '12345');
  writeFileSync(join(repo, '.git', 'objects', 'pack', 'pack-b.pack'), '1234567');
  if (corpus === 'git') writeFileSync(join(articlesRepo, '.git', 'objects', 'pack', 'pack-articles.pack'), 'articles');

  const git = join(tools, 'git');
  makeFakeGit(git, gitVersion, callsFile);
  const writeTool = (name, body) => writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  writeTool('df', `printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 1 1 $((FAKE_FREE_KIB)) 1%% /\\n"`);
  writeTool('time', 'shift; exec "$@"');
  writeTool('taskpolicy', `case "$1" in
  -m) shift 2; if [ "\${FAKE_TASKPOLICY_CAP}" = 0 ] && [ "$1" = /usr/bin/true ]; then exit 1; fi ;;
  -b) shift ;;
esac
exec "$@"`);
  writeTool('sysctl', 'printf "%s\\n" "$FAKE_PRESSURE"');

  const env = {
    ...process.env,
    HOME: home,
    FRONTALIERE_SITE_REPO: repo,
    FRONTALIERE_LOG_DIR: logs,
    FRONTALIERE_GIT_BIN: git,
    FRONTALIERE_DF_BIN: join(tools, 'df'),
    FRONTALIERE_TIME_BIN: join(tools, 'time'),
    FRONTALIERE_TASKPOLICY_BIN: join(tools, 'taskpolicy'),
    FRONTALIERE_SYSCTL_BIN: join(tools, 'sysctl'),
    FRONTALIERE_PYTHON_BIN: '/usr/bin/python3',
    FAKE_FREE_KIB: String(Math.floor(freeGib * 1024 * 1024)),
    FAKE_PRESSURE: String(pressure),
    FAKE_TASKPOLICY_CAP: taskpolicyCap ? '1' : '0',
  };
  if (omitArticlesEnv) delete env.FRONTALIERE_ARTICLES_REPO;
  else env.FRONTALIERE_ARTICLES_REPO = articlesRepo;
  if (batchConfig !== undefined) env.FAKE_MIDX_BATCH = batchConfig;
  else delete env.FAKE_MIDX_BATCH;

  return {
    root,
    home,
    repo,
    articlesRepo,
    logs,
    callsFile,
    stateDir: join(home, '.local', 'state', 'frontaliere'),
    run(schedule = 'daily') {
      const result = spawnSync('/bin/sh', [WRAPPER, schedule], { encoding: 'utf8', env });
      const logFile = join(logs, 'git-maintenance.log');
      const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      const healthPath = join(home, '.local', 'state', 'frontaliere', 'git-maintenance-health');
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
        calls,
        health: existsSync(healthPath) ? readFileSync(healthPath, 'utf8') : '',
        stateDir: join(home, '.local', 'state', 'frontaliere'),
        root,
        home,
      };
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function runWrapper(options = {}) {
  const fixture = wrapperFixture(options);
  try {
    return fixture.run(options.schedule || 'daily');
  } finally {
    fixture.cleanup();
  }
}

function hasCall(run, pattern) {
  return run.calls.some((call) => pattern.test(call));
}

test('wrapper separates low-space recovery from guarded consolidation across pressure and disk levels', () => {
  for (const pressure of [1, 2, 4]) {
    for (const freeGib of [0.5, 2, 10]) {
      const run = runWrapper({ pressure, freeGib, taskpolicyCap: true });
      assert.equal(run.status, 0, run.stderr + run.log);
      const recoveryExpected = pressure < 4 && freeGib >= 1;
      const consolidationExpected = (pressure === 1 || pressure === 2) && freeGib >= 5;
      assert.equal(hasCall(run, /multi-pack-index expire/), recoveryExpected || consolidationExpected, `expire pressure=${pressure} free=${freeGib}`);
      assert.equal(hasCall(run, /multi-pack-index write/), recoveryExpected, `write pressure=${pressure} free=${freeGib}`);
      assert.equal(hasCall(run, /multi-pack-index repack/), consolidationExpected, `repack pressure=${pressure} free=${freeGib}`);
      assert.equal(hasCall(run, /maintenance run --task=/), consolidationExpected, `scheduled task pressure=${pressure} free=${freeGib}`);
      for (const call of run.calls) assert.match(call, /lazy=1$/, 'maintenance Git commands disable lazy fetch');
      if (!recoveryExpected) assert.match(run.log, /action=skip step=space_recovery reason=/);
      if (!consolidationExpected) assert.match(run.log, /action=skip step=consolidation reason=/);
      if (freeGib === 2 && pressure < 4) assert.match(run.log, /action=skip step=consolidation reason=low_disk/);
    }
  }
});

test('pressure 2 requires taskpolicy -m for consolidation and caps the MIDX batch at 512m', () => {
  const unsupported = runWrapper({ pressure: 2, freeGib: 10, taskpolicyCap: false });
  assert.equal(unsupported.status, 0, unsupported.stderr + unsupported.log);
  assert.equal(hasCall(unsupported, /multi-pack-index write/), true, 'space recovery still runs');
  assert.equal(hasCall(unsupported, /maintenance run --task=/), false);
  assert.equal(hasCall(unsupported, /multi-pack-index repack/), false);
  assert.match(unsupported.log, /step=consolidation reason=taskpolicy_memory_cap_unsupported/);

  const capped = runWrapper({ pressure: 2, freeGib: 10, taskpolicyCap: true, batchConfig: '4g' });
  assert.equal(capped.status, 0, capped.stderr + capped.log);
  assert.match(capped.calls.find((call) => call.includes('multi-pack-index repack')), /--batch-size=512m/);
  assert.match(capped.log, /consolidation_decision .*memory_cap_mib=512/);
});

test('wrapper chooses the highest local Git at or above 2.44 when the explicit candidate is older', () => {
  const root = mkdtempSync(join(tmpdir(), 'git maintenance git selection-'));
  try {
    const home = join(root, 'home');
    const localOld = join(home, '.local', 'git-2.45.1', 'bin', 'git');
    const localNew = join(home, '.local', 'git-2.56.0', 'bin', 'git');
    const tools = join(root, 'tools');
    const repo = join(root, 'site');
    const callsOld = join(root, 'old-calls.log');
    const callsNew = join(root, 'new-calls.log');
    const callsExplicit = join(root, 'explicit-calls.log');
    mkdirSync(join(repo, '.git'), { recursive: true });
    makeFakeGit(localOld, '2.45.1', callsOld);
    makeFakeGit(localNew, '2.56.0', callsNew);
    mkdirSync(tools, { recursive: true });
    const explicit = join(tools, 'git');
    makeFakeGit(explicit, '2.39.2', callsExplicit);
    const fakeTool = (name, body) => writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fakeTool('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 1 1 20971520 1%% /\\n"');
    fakeTool('time', 'shift; exec "$@"');
    fakeTool('taskpolicy', 'case "$1" in -m) shift 2;; -b) shift;; esac; exec "$@"');
    fakeTool('sysctl', 'echo 1');
    const env = {
      ...process.env,
      HOME: home,
      FRONTALIERE_SITE_REPO: repo,
      FRONTALIERE_LOG_DIR: join(root, 'logs'),
      FRONTALIERE_GIT_BIN: explicit,
      FRONTALIERE_DF_BIN: join(tools, 'df'),
      FRONTALIERE_TIME_BIN: join(tools, 'time'),
      FRONTALIERE_TASKPOLICY_BIN: join(tools, 'taskpolicy'),
      FRONTALIERE_SYSCTL_BIN: join(tools, 'sysctl'),
      FRONTALIERE_PYTHON_BIN: '/usr/bin/python3',
      FAKE_GIT_CALLS: join(root, 'unused-calls.log'),
    };
    const result = spawnSync('/bin/sh', [WRAPPER, 'hourly'], { encoding: 'utf8', env });
    const log = readFileSync(join(root, 'logs', 'git-maintenance.log'), 'utf8');
    assert.equal(result.status, 0, result.stderr + log);
    assert.match(log, /action=git_selected git=.*git-2\.56\.0\/bin\/git git_version=2\.56\.0/);
    assert.equal(existsSync(callsNew), true);
    assert.equal(existsSync(callsOld), false);
    assert.equal(existsSync(callsExplicit), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper migrates old state and writes the atomic health contract with pack metrics', () => {
  const root = mkdtempSync(join(tmpdir(), 'git maintenance health-'));
  try {
    const home = join(root, 'home');
    const logs = join(home, 'Library', 'Logs', 'frontaliere');
    const oldState = join(logs, 'git-maintenance-state');
    mkdirSync(logs, { recursive: true });
    writeFileSync(oldState, '0 0 0 0\n');
    const run = runWrapper({ pressure: 1, freeGib: 2, home, logs });
    assert.equal(run.status, 0, run.stderr + run.log);
    assert.equal(existsSync(oldState), false);
    const stateFile = join(run.stateDir, 'git-maintenance-state');
    const healthFile = join(run.stateDir, 'git-maintenance-health');
    assert.equal(existsSync(stateFile), true);
    assert.equal(existsSync(healthFile), true);
    const health = Object.fromEntries(readFileSync(healthFile, 'utf8').trim().split('\n').map((line) => line.split('=')));
    for (const key of ['updated_epoch', 'repo', 'last_space_recovery_epoch', 'last_consolidation_epoch', 'health_since_epoch', 'last_skip_step', 'last_skip_reason', 'pack_count', 'pack_bytes', 'git_version']) {
      assert.ok(Object.hasOwn(health, key), `health includes ${key}`);
    }
    assert.equal(health.pack_count, '2');
    assert.equal(health.pack_bytes, '12');
    assert.equal(health.last_skip_step, 'consolidation');
    assert.equal(health.last_skip_reason, 'low_disk');
    assert.match(run.log, /action=state_migrated/);
    assert.ok(Number(health.last_space_recovery_epoch) > 0);
    assert.match(health.git_version, /^2\.56\.0$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper mantiene il sito quando il corpus manca o non è Git e tratta entrambi i repo quando è valido', () => {
  for (const corpus of ['absent', 'not-git']) {
    const fixture = wrapperFixture({ corpus });
    try {
      const result = fixture.run();
      assert.equal(result.status, 0, result.stderr + result.log);
      assert.ok(result.calls.some((call) => call.includes(`-C ${fixture.repo} `)), 'site maintenance still runs');
      assert.equal(result.calls.some((call) => call.includes(`-C ${fixture.articlesRepo} `)), false, `${corpus} corpus is skipped`);
      assert.match(result.health, /^health_since_epoch=\d+$/m);
      assert.doesNotMatch(result.health, /^articles_/m);
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = wrapperFixture({ corpus: 'git' });
  try {
    const first = fixture.run();
    assert.equal(first.status, 0, first.stderr + first.log);
    assert.ok(first.calls.some((call) => call.includes(`-C ${fixture.repo} `)), 'site maintenance runs');
    assert.ok(first.calls.some((call) => call.includes(`-C ${fixture.articlesRepo} `)), 'corpus maintenance runs');
    const firstHealth = Object.fromEntries(first.health.trim().split('\n').map((line) => line.split('=')));
    for (const key of ['articles_last_space_recovery_epoch', 'articles_last_consolidation_epoch', 'articles_health_since_epoch', 'articles_pack_count', 'articles_pack_bytes']) {
      assert.ok(Object.hasOwn(firstHealth, key), `health includes ${key}`);
    }
    assert.equal(firstHealth.articles_pack_count, '1');
    assert.equal(firstHealth.articles_pack_bytes, String(Buffer.byteLength('articles')));
    assert.ok(existsSync(join(fixture.stateDir, 'git-maintenance-state')));
    assert.ok(existsSync(join(fixture.stateDir, 'git-maintenance-state.articles')));

    const second = fixture.run();
    assert.equal(second.status, 0, second.stderr + second.log);
    const secondHealth = Object.fromEntries(second.health.trim().split('\n').map((line) => line.split('=')));
    assert.equal(secondHealth.health_since_epoch, firstHealth.health_since_epoch);
    assert.equal(secondHealth.articles_health_since_epoch, firstHealth.articles_health_since_epoch);
    assert.equal(secondHealth.repo, fixture.repo);
    assert.equal(secondHealth.articles_repo, fixture.articlesRepo);
  } finally {
    fixture.cleanup();
  }

  const derivedFixture = wrapperFixture({ corpus: 'git', omitArticlesEnv: true });
  try {
    const result = derivedFixture.run();
    assert.equal(result.status, 0, result.stderr + result.log);
    assert.ok(result.calls.some((call) => call.includes(`-C ${realpathSync(derivedFixture.articlesRepo)} `)), 'workspace corpus is derived from FRONTALIERE_SITE_REPO');
  } finally {
    derivedFixture.cleanup();
  }
});
