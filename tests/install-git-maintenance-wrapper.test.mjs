import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const INSTALLER = join(ROOT, 'bin', 'install-git-maintenance-wrapper');
const SCHEDULES = { hourly: 'hourly', daily: 'daily', weekly: 'weekly', sunday: 'daily' };

const FAKE_PLUTIL = `
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function read(file) {
  const source = readFileSync(file, 'utf8');
  try { return JSON.parse(source); } catch {}
  const plist = {};
  const label = source.match(/<key>Label<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>/);
  if (label) plist.Label = label[1];
  const argumentsMatch = source.match(/<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/);
  if (argumentsMatch) plist.ProgramArguments = [...argumentsMatch[1].matchAll(/<string>([\\s\\S]*?)<\\/string>/g)].map((match) => match[1]);
  return plist;
}
const walk = (root, keyPath) => keyPath.split('.').reduce((node, key) => (node == null ? undefined : node[key]), root);
function parentOf(root, keyPath, create) {
  const keys = keyPath.split('.');
  const last = keys.pop();
  let node = root;
  for (const key of keys) {
    if (node[key] == null) {
      if (!create) return [null, last];
      node[key] = {};
    }
    node = node[key];
  }
  return [node, last];
}

if (args[0] === '-extract' && args[2] === 'raw') {
  const value = walk(read(args[3]), args[1]);
  if (value === undefined) process.exitCode = 1;
  else process.stdout.write(String(value));
} else if (args[0] === '-replace' && args[1] === 'ProgramArguments' && args[2] === '-json') {
  const plist = read(args[4]);
  plist.ProgramArguments = JSON.parse(args[3]);
  writeFileSync(args[4], JSON.stringify(plist));
} else if ((args[0] === '-replace' || args[0] === '-insert') && args[2] === '-string') {
  const plist = read(args[4]);
  const [parent, last] = parentOf(plist, args[1], true);
  parent[last] = args[3];
  writeFileSync(args[4], JSON.stringify(plist));
} else if (args[0] === '-remove') {
  const plist = read(args[2]);
  const [parent, last] = parentOf(plist, args[1], false);
  if (!parent || !(last in parent)) process.exitCode = 1;
  else {
    delete parent[last];
    writeFileSync(args[2], JSON.stringify(plist));
  }
} else if (args[0] === '-lint') {
  read(args[1]);
} else {
  process.exitCode = 2;
}
`;

function runInstaller(args, env) {
  return spawnSync('/bin/sh', [INSTALLER, ...args], { encoding: 'utf8', env });
}

test('install and restore replace the complete LaunchAgent argument vector', () => {
  const root = mkdtempSync(join(tmpdir(), 'git maintenance installer-'));
  try {
    const home = join(root, 'home with spaces');
    const launchAgents = join(home, 'Library', 'LaunchAgents');
    const toolDir = join(root, 'tools');
    const siteRepo = join(root, 'site repo');
    const articlesRepo = join(root, 'articles repo');
    const fakePlutilScript = join(toolDir, 'fake-plutil.mjs');
    const fakePlutil = join(toolDir, 'plutil');
    const fakeLaunchctl = join(toolDir, 'launchctl');
    const globalGitConfig = join(root, 'gitconfig');
    const launchctlLog = join(root, 'launchctl.log');
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(toolDir, { recursive: true });
    execFileSync('git', ['init', '--quiet', siteRepo]);
    execFileSync('git', ['init', '--quiet', articlesRepo]);
    writeFileSync(fakePlutilScript, FAKE_PLUTIL);
    writeFileSync(fakePlutil, `#!/bin/sh\nexec "${process.execPath}" "${fakePlutilScript}" "$@"\n`, { mode: 0o755 });
    writeFileSync(fakeLaunchctl, '#!/bin/sh\nprintf "%s\\n" "$*" >>"$FAKE_LAUNCHCTL_LOG"\n', { mode: 0o755 });
    chmodSync(fakePlutil, 0o755);
    const env = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: globalGitConfig,
      FRONTALIERE_SITE_REPO: siteRepo,
      FRONTALIERE_ARTICLES_REPO: articlesRepo,
      FRONTALIERE_PLUTIL_BIN: fakePlutil,
      FRONTALIERE_LAUNCHCTL_BIN: fakeLaunchctl,
      FAKE_LAUNCHCTL_LOG: launchctlLog,
      PATH: `${toolDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    execFileSync('git', ['config', '--global', '--add', 'maintenance.repo', siteRepo], { env });

    const originalArguments = {};
    for (const [label, schedule] of Object.entries(SCHEDULES)) {
      const plistPath = join(launchAgents, `ch.frontaliere.git-maintenance-${label}.plist`);
      const oldWrapper = join(root, 'old bin', 'git-maintenance-wrapper');
      originalArguments[label] = [oldWrapper, schedule];
      writeFileSync(plistPath, JSON.stringify({
        ProgramArguments: originalArguments[label],
        EnvironmentVariables: { HOME: '/old/home', FRONTALIERE_SITE_REPO: '/old/site' },
        StandardOutPath: '/old/out.log',
        StandardErrorPath: '/old/err.log',
      }));
    }

    const installed = runInstaller([], env);
    assert.equal(installed.status, 0, installed.stderr);
    const wrapper = join(home, 'Library', 'Application Support', 'frontaliere', 'git-maintenance', 'git-maintenance-wrapper');
    for (const [label, schedule] of Object.entries(SCHEDULES)) {
      const plistPath = join(launchAgents, `ch.frontaliere.git-maintenance-${label}.plist`);
      const backupPath = join(home, 'Library', 'Application Support', 'frontaliere', 'git-maintenance', 'original-launch-agents', `ch.frontaliere.git-maintenance-${label}.plist`);
      assert.deepEqual(JSON.parse(readFileSync(plistPath, 'utf8')).ProgramArguments, [wrapper, schedule], `${label} has only wrapper + schedule`);
      assert.deepEqual(JSON.parse(readFileSync(backupPath, 'utf8')).ProgramArguments, originalArguments[label], `${label} backup preserves original arguments`);
    }
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'splitIndex.sharedIndexExpire'], { encoding: 'utf8' }).trim(), '1.day.ago');
    assert.equal(execFileSync('git', ['-C', articlesRepo, 'config', '--local', '--get', 'splitIndex.sharedIndexExpire'], { encoding: 'utf8' }).trim(), '1.day.ago');
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'frontaliere.fetchThrottleSeconds'], { encoding: 'utf8' }).trim(), '30');
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'fetch.unpackLimit'], { encoding: 'utf8' }).trim(), '2000');
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'transfer.unpackLimit'], { encoding: 'utf8' }).trim(), '2000');
    assert.throws(() => execFileSync('git', ['-C', articlesRepo, 'config', '--local', '--get', 'fetch.unpackLimit'], { encoding: 'utf8' }));
    assert.throws(() => execFileSync('git', ['-C', articlesRepo, 'config', '--local', '--get', 'transfer.unpackLimit'], { encoding: 'utf8' }));
    assert.match(readFileSync(join(home, '.local', 'bin', 'git'), 'utf8'), /FRONTALIERE_GIT_SHIM=1/);

    const reinstalled = runInstaller([], env);
    assert.equal(reinstalled.status, 0, reinstalled.stderr);
    for (const [label, schedule] of Object.entries(SCHEDULES)) {
      const plistPath = join(launchAgents, `ch.frontaliere.git-maintenance-${label}.plist`);
      assert.deepEqual(JSON.parse(readFileSync(plistPath, 'utf8')).ProgramArguments, [wrapper, schedule], `${label} remains idempotent`);
    }

    const restored = runInstaller(['--restore'], env);
    assert.equal(restored.status, 0, restored.stderr);
    for (const [label] of Object.entries(SCHEDULES)) {
      const plistPath = join(launchAgents, `ch.frontaliere.git-maintenance-${label}.plist`);
      assert.deepEqual(JSON.parse(readFileSync(plistPath, 'utf8')).ProgramArguments, originalArguments[label], `${label} restores original arguments`);
    }
    assert.equal(existsSync(wrapper), false, 'restore removes the installed wrapper');
    assert.equal(existsSync(join(home, '.local', 'bin', 'git')), false, 'restore removes the shim when no prior git existed');
    assert.equal(execFileSync('git', ['config', '--global', '--fixed-value', '--get', 'maintenance.repo', siteRepo], { encoding: 'utf8', env }).trim(), siteRepo);
    assert.throws(() => execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'splitIndex.sharedIndexExpire'], { encoding: 'utf8' }));
    assert.throws(() => execFileSync('git', ['-C', articlesRepo, 'config', '--local', '--get', 'splitIndex.sharedIndexExpire'], { encoding: 'utf8' }));
    assert.throws(() => execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'maintenance.strategy'], { encoding: 'utf8' }));
    assert.match(readFileSync(launchctlLog, 'utf8'), /bootstrap gui\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Minimal installer environment with only the given LaunchAgents, each saved
// with the StartCalendarInterval the real plists carry.
function installerFixture(root, labels) {
  const home = join(root, 'home');
  const launchAgents = join(home, 'Library', 'LaunchAgents');
  const toolDir = join(root, 'tools');
  const siteRepo = join(root, 'site');
  const articlesRepo = join(root, 'articles');
  const launchctlLog = join(root, 'launchctl.log');
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(toolDir, { recursive: true });
  execFileSync('git', ['init', '--quiet', siteRepo]);
  execFileSync('git', ['init', '--quiet', articlesRepo]);
  writeFileSync(join(toolDir, 'fake-plutil.mjs'), FAKE_PLUTIL);
  writeFileSync(join(toolDir, 'plutil'), `#!/bin/sh\nexec "${process.execPath}" "${join(toolDir, 'fake-plutil.mjs')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(toolDir, 'launchctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >>"$FAKE_LAUNCHCTL_LOG"\nexit 0\n', { mode: 0o755 });
  const calendar = { sunday: { Hour: 4, Minute: 0, Weekday: 0 }, daily: { Hour: 4, Minute: 0 }, hourly: { Minute: 30 } };
  for (const label of labels) {
    writeFileSync(join(launchAgents, `ch.frontaliere.git-maintenance-${label}.plist`), JSON.stringify({
      ProgramArguments: ['/old/bin/git-maintenance-wrapper', SCHEDULES[label]],
      StartCalendarInterval: calendar[label],
    }));
  }
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    FRONTALIERE_SITE_REPO: siteRepo,
    FRONTALIERE_ARTICLES_REPO: articlesRepo,
    FRONTALIERE_PLUTIL_BIN: join(toolDir, 'plutil'),
    FRONTALIERE_LAUNCHCTL_BIN: join(toolDir, 'launchctl'),
    FAKE_LAUNCHCTL_LOG: launchctlLog,
    PATH: `${toolDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const plist = (label) => JSON.parse(readFileSync(join(launchAgents, `ch.frontaliere.git-maintenance-${label}.plist`), 'utf8'));
  return { env, plist, launchctlLog, root, home, siteRepo, articlesRepo, launchAgents };
}

test('a host with only the Sunday job runs it every day; hourly keeps its own calendar', () => {
  const root = mkdtempSync(join(tmpdir(), 'git maintenance sunday-only-'));
  try {
    const { env, plist, launchctlLog } = installerFixture(root, ['hourly', 'sunday']);
    const installed = runInstaller([], env);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /gira ogni giorno/);
    assert.deepEqual(plist('sunday').StartCalendarInterval, { Hour: 4, Minute: 0 }, 'the weekday restriction is dropped, hour and minute stay');
    assert.equal(plist('sunday').ProgramArguments[1], 'daily', 'it still runs the daily schedule');
    assert.deepEqual(plist('hourly').StartCalendarInterval, { Minute: 30 }, 'other jobs are untouched');

    // A second run is a no-op: no reload, no rewrite.
    const bootstrapsBefore = readFileSync(launchctlLog, 'utf8').split('\n').filter((line) => line.startsWith('bootstrap')).length;
    const again = runInstaller([], env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /gia aggiornato/);
    const bootstrapsAfter = readFileSync(launchctlLog, 'utf8').split('\n').filter((line) => line.startsWith('bootstrap')).length;
    assert.equal(bootstrapsAfter, bootstrapsBefore, 'idempotent: LaunchAgents are not reloaded again');

    // --restore brings the saved weekly cadence back.
    const restored = runInstaller(['--restore'], env);
    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(plist('sunday').StartCalendarInterval, { Hour: 4, Minute: 0, Weekday: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the laptop, which has its own daily job, keeps the Sunday job on Sundays', () => {
  const root = mkdtempSync(join(tmpdir(), 'git maintenance laptop-'));
  try {
    const { env, plist } = installerFixture(root, ['daily', 'sunday']);
    const installed = runInstaller([], env);
    assert.equal(installed.status, 0, installed.stderr);
    assert.doesNotMatch(installed.stdout, /gira ogni giorno/);
    assert.deepEqual(plist('sunday').StartCalendarInterval, { Hour: 4, Minute: 0, Weekday: 0 });
    assert.deepEqual(plist('daily').StartCalendarInterval, { Hour: 4, Minute: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer adds one hourly job, preserves a user shim and Mole entries, and skips unpack limits on partial clones', () => {
  const root = mkdtempSync(join(tmpdir(), 'git maintenance hourly and restore-'));
  try {
    const fixture = installerFixture(root, ['daily', 'sunday']);
    const { env, launchctlLog, home, siteRepo, launchAgents, plist } = fixture;
    const shimDir = join(home, '.local', 'bin');
    const originalShim = join(shimDir, 'git');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(originalShim, '#!/bin/sh\necho user-git\n', { mode: 0o755 });
    mkdirSync(join(home, '.config', 'mole'), { recursive: true });
    const whitelist = join(home, '.config', 'mole', 'whitelist');
    writeFileSync(whitelist, '# keep this comment\n~/Library/Logs/frontaliere\n');
    execFileSync('git', ['-C', siteRepo, 'config', '--local', 'splitIndex.sharedIndexExpire', '2.weeks.ago']);
    execFileSync('git', ['-C', siteRepo, 'config', '--local', 'frontaliere.fetchThrottleSeconds', '9']);
    execFileSync('git', ['-C', siteRepo, 'config', '--local', 'remote.origin.promisor', 'true']);

    const installed = runInstaller([], env);
    assert.equal(installed.status, 0, installed.stderr);
    const hourly = join(launchAgents, 'ch.frontaliere.git-maintenance-hourly.plist');
    assert.deepEqual(JSON.parse(readFileSync(hourly, 'utf8')).ProgramArguments, [
      join(home, 'Library', 'Application Support', 'frontaliere', 'git-maintenance', 'git-maintenance-wrapper'),
      'hourly',
    ]);
    assert.equal(existsSync(join(launchAgents, 'ch.frontaliere.git-maintenance-hourly-frontaliere.plist')), false);
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'splitIndex.sharedIndexExpire'], { encoding: 'utf8' }).trim(), '1.day.ago');
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'frontaliere.fetchThrottleSeconds'], { encoding: 'utf8' }).trim(), '30');
    assert.throws(() => execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'fetch.unpackLimit'], { encoding: 'utf8' }));
    assert.throws(() => execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'transfer.unpackLimit'], { encoding: 'utf8' }));
    assert.equal(readFileSync(join(shimDir, 'git.pre-frontaliere'), 'utf8'), '#!/bin/sh\necho user-git\n');
    assert.match(readFileSync(originalShim, 'utf8'), /FRONTALIERE_GIT_SHIM=1/);
    assert.equal(readFileSync(whitelist, 'utf8'), '# keep this comment\n~/Library/Logs/frontaliere\n~/.local/state/frontaliere\n');

    const bootstrapsBefore = readFileSync(launchctlLog, 'utf8').split('\n').filter((line) => line.startsWith('bootstrap')).length;
    const reinstalled = runInstaller([], env);
    assert.equal(reinstalled.status, 0, reinstalled.stderr);
    const bootstrapsAfter = readFileSync(launchctlLog, 'utf8').split('\n').filter((line) => line.startsWith('bootstrap')).length;
    assert.equal(bootstrapsAfter, bootstrapsBefore, 'a second install does not add or reload a duplicate hourly job');

    const restored = runInstaller(['--restore'], env);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(existsSync(hourly), false, 'restore removes the LaunchAgent created by this installer');
    assert.equal(readFileSync(originalShim, 'utf8'), '#!/bin/sh\necho user-git\n');
    assert.equal(existsSync(join(shimDir, 'git.pre-frontaliere')), false);
    assert.equal(readFileSync(whitelist, 'utf8'), '# keep this comment\n~/Library/Logs/frontaliere\n');
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'splitIndex.sharedIndexExpire'], { encoding: 'utf8' }).trim(), '2.weeks.ago');
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'frontaliere.fetchThrottleSeconds'], { encoding: 'utf8' }).trim(), '9');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The real wrapper against fake git/df/time/taskpolicy/sysctl: only the MIDX
// repack invocation and the log matter here.
const WRAPPER = join(ROOT, 'bin', 'git-maintenance-wrapper');

function runWrapper({ batchConfig, schedule = 'daily', freeKib = 99999999999 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'git-maintenance-wrapper-'));
  try {
    const tools = join(root, 'tools');
    const repo = join(root, 'site');
    const logs = join(root, 'logs');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(tools, { recursive: true });
    const gitCalls = join(root, 'git-calls.log');
    const script = (name, body) => writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    script('git', `if [ "$1" = --version ]; then printf 'git version 2.56.0\\n'; exit 0; fi\ncase "$*" in *"config --get frontaliere.maintenance.midxBatchSize"*) if [ -n "\${FAKE_MIDX_BATCH+x}" ]; then printf '%s\\n' "$FAKE_MIDX_BATCH"; exit 0; fi; exit 1;; esac\nprintf '%s\\n' "$*" >>"$FAKE_GIT_CALLS"`);
    script('df', `printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 1 1 ${freeKib} 1%% /\\n"`);
    script('time', 'shift; exec "$@"');
    script('taskpolicy', 'case "$1" in -m) shift 2;; -b) shift;; esac\nexec "$@"');
    script('sysctl', 'echo 1');
    const env = {
      ...process.env,
      HOME: root,
      FRONTALIERE_SITE_REPO: repo,
      FRONTALIERE_LOG_DIR: logs,
      FRONTALIERE_GIT_BIN: join(tools, 'git'),
      FRONTALIERE_DF_BIN: join(tools, 'df'),
      FRONTALIERE_TIME_BIN: join(tools, 'time'),
      FRONTALIERE_TASKPOLICY_BIN: join(tools, 'taskpolicy'),
      FRONTALIERE_SYSCTL_BIN: join(tools, 'sysctl'),
      FAKE_GIT_CALLS: gitCalls,
    };
    if (batchConfig !== undefined) env.FAKE_MIDX_BATCH = batchConfig;
    else delete env.FAKE_MIDX_BATCH;
    const result = spawnSync('/bin/sh', [WRAPPER, schedule], { encoding: 'utf8', env });
    const log = existsSync(join(logs, 'git-maintenance.log')) ? readFileSync(join(logs, 'git-maintenance.log'), 'utf8') : '';
    const calls = existsSync(gitCalls) ? readFileSync(gitCalls, 'utf8').split('\n').filter(Boolean) : [];
    return { status: result.status, stderr: result.stderr, log, repackCalls: calls.filter((line) => line.includes('multi-pack-index repack')) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('wrapper: the MIDX batch defaults to 1g and the log names it', () => {
  const run = runWrapper();
  assert.equal(run.status, 0, run.stderr + run.log);
  assert.equal(run.repackCalls.length, 1);
  assert.match(run.repackCalls[0], /--batch-size=1g --no-progress/);
  assert.match(run.log, /action=repack_attempt .*batch_size=1g /);
  assert.doesNotMatch(run.log, /config_invalid/);
  // every existing guard is still in the invocation
  assert.match(run.repackCalls[0], /-c pack\.threads=1/);
  assert.match(run.repackCalls[0], /-c pack\.windowMemory=256m/);
});

test('wrapper: a valid frontaliere.maintenance.midxBatchSize is used and logged', () => {
  for (const value of ['4g', '512m', '800000k']) {
    const run = runWrapper({ batchConfig: value });
    assert.equal(run.status, 0, run.stderr + run.log);
    assert.match(run.repackCalls[0], new RegExp(`--batch-size=${value} --no-progress`), value);
    assert.match(run.log, new RegExp(`action=repack_attempt .*batch_size=${value} `), value);
    assert.doesNotMatch(run.log, /config_invalid/, value);
  }
});

test('wrapper: an invalid midxBatchSize is logged and the default 1g is used', () => {
  for (const value of ['', 'abc', '4G', '0g', '-1g', '1234567g', '4g\nfoo']) {
    const run = runWrapper({ batchConfig: value });
    assert.equal(run.status, 0, `${JSON.stringify(value)}: ${run.stderr}${run.log}`);
    assert.match(run.repackCalls[0], /--batch-size=1g --no-progress/, JSON.stringify(value));
    assert.match(run.log, /action=repack_attempt .*batch_size=1g /, JSON.stringify(value));
    if (value !== '') {
      assert.match(run.log, /action=config_invalid .*key=frontaliere\.maintenance\.midxBatchSize .*using_default=1g/, JSON.stringify(value));
    }
  }
});

test('wrapper: only the daily schedule repacks', () => {
  const hourly = runWrapper({ batchConfig: '4g', schedule: 'hourly' });
  assert.equal(hourly.status, 0, hourly.stderr + hourly.log);
  assert.equal(hourly.repackCalls.length, 0);
});

test('wrapper: a larger batch does not bypass the 5 GiB free-disk guard', () => {
  const run = runWrapper({ batchConfig: '8g', freeKib: 4 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr + run.log);
  assert.equal(run.repackCalls.length, 0);
  assert.match(run.log, /action=skip step=consolidation reason=low_disk .*minimum_gib=5/);
  assert.doesNotMatch(run.log, /action=repack_attempt/);
});
