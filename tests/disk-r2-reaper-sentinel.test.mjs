import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { discoverGit, runReaper } from '../bin/agent-orphan-reaper.mjs';
import { runDiskSentinel, scanLazyFetchPacks, TSV_HEADER } from '../bin/disk-sentinel.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REAPER = join(ROOT, 'bin', 'agent-orphan-reaper.mjs');
const AUTUPDATE = join(ROOT, 'bin', 'workspace-autoupdate');
const GIB = 1024 ** 3;
const UID = 501;
const NOW = 1_800_000_000_000;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function processRow(pid, ppid, ageSeconds, command, uid = UID) {
  return { pid, ppid, ageSeconds, uid, command };
}

function elapsedString(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${days ? `${days}-` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function idleBroker(pid, { ppid = 1, age = 3 * 3600, uid = UID } = {}) {
  return processRow(pid, ppid, age, `/Users/test/node /Users/test/.claude/plugins/cache/openai-codex/codex/1/scripts/app-server-broker.mjs serve --endpoint unix:/tmp/cxc-${pid}/broker.sock`, uid);
}

function reaperOptions(dir, extra = {}) {
  return {
    homeDir: dir,
    workspaceRoot: join(dir, 'workspace'),
    logPath: join(dir, 'logs', 'agent-orphan-reaper.log'),
    stateDir: join(dir, 'state'),
    uid: UID,
    ownPid: 90000,
    gitBin: 'fake-git',
    lsofBin: 'fake-lsof',
    listProcesses: () => [],
    readSocketCount: () => 5,
    readCwd: () => null,
    pathExists: () => true,
    sleep: async () => {},
    signal: () => assert.fail('dry-run must not signal'),
    nowMs: NOW,
    runCommand: () => ({ status: 1, stdout: '', stderr: '' }),
    ...extra,
  };
}

test('reaper classifica broker inattivo, occupato, giovane e con padre vivo; dry-run non segnala', async () => {
  const dir = tempDir('r2-reaper-classification-');
  try {
    const rows = [
      idleBroker(101),
      idleBroker(102, { age: 4 * 3600 }),
      idleBroker(103, { age: 60 * 60 }),
      idleBroker(104, { ppid: 77, age: 5 * 3600 }),
    ];
    const sockets = new Map([[101, 4], [102, 5], [103, 4], [104, 4]]);
    const samples = [];
    const result = await runReaper(reaperOptions(dir, {
      listProcesses: () => rows,
      readSocketCount: (pid) => sockets.get(pid),
      sleep: async (ms) => samples.push(ms),
    }));
    const brokerActions = result.actions.filter((action) => action.reason === 'inactive_orphan_broker');
    assert.deepEqual(brokerActions.map((action) => [action.action, action.signal, action.pid]), [
      ['would_signal', 'SIGTERM', 101],
      ['would_signal_after_grace', 'SIGKILL', 101],
    ]);
    assert.deepEqual(samples, [30_000]);
    assert.equal(rows.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('il broker deve restare eleggibile in entrambi i campioni separati da 30 secondi', async () => {
  const dir = tempDir('r2-reaper-two-samples-');
  try {
    const first = [idleBroker(201)];
    const second = [idleBroker(201)];
    let sample = 0;
    const sleeps = [];
    const sockets = [];
    const result = await runReaper(reaperOptions(dir, {
      listProcesses: () => [first, second, second][Math.min(sample++, 2)],
      readSocketCount: () => { sockets.push(sockets.length); return sockets.length === 1 ? 4 : 5; },
      sleep: async (ms) => sleeps.push(ms),
    }));
    assert.deepEqual(sleeps, [30_000]);
    assert.equal(result.actions.some((action) => action.reason === 'inactive_orphan_broker'), false);
    assert.equal(sockets.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in apply invia SIGTERM, attende 15 secondi e poi invia SIGKILL a broker e sottoalbero', async () => {
  const dir = tempDir('r2-reaper-signal-order-');
  try {
    const root = idleBroker(301);
    const child = processRow(302, 301, 3 * 3600, 'npm exec @upstash/context7-mcp@latest');
    const rows = [root, child];
    const order = [];
    const result = await runReaper(reaperOptions(dir, {
      apply: true,
      listProcesses: () => rows,
      readSocketCount: () => 4,
      sleep: async (ms) => order.push(`sleep:${ms}`),
      signal: (pid, signal) => order.push(`${signal}:${pid}`),
    }));
    assert.deepEqual(order, ['sleep:30000', 'SIGTERM:301', 'sleep:15000', 'SIGKILL:302', 'SIGKILL:301']);
    assert.ok(result.actions.some((action) => action.action === 'signal' && action.signal === 'SIGKILL' && action.pid === 302));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reaper prende MCP e app-server orfani vecchi e fsmonitor vecchi o con worktree mancante', async () => {
  const dir = tempDir('r2-reaper-orphan-types-');
  try {
    const rows = [
      processRow(401, 1, 3 * 3600, 'node /tmp/context7-mcp/index.js'),
      processRow(402, 1, 3 * 3600, 'codex app-server --listen stdio'),
      processRow(403, 1, 30, 'git fsmonitor--daemon run --detach'),
      processRow(404, 1, 25 * 3600, 'git fsmonitor--daemon run --detach'),
      processRow(405, 77, 25 * 3600, 'git fsmonitor--daemon run --detach'),
      processRow(406, 1, 3 * 3600, 'codex app-server'),
      // Il daemon Codex avviato da launchd: ppid 1 e settimane di vita, mai un bersaglio.
      processRow(407, 1, 50 * 86400, '/Users/u/.codex/packages/app-server-daemon/releases/0.170.0-x86_64-apple-darwin/bin/codex app-server daemon pid-update-loop'),
      processRow(408, 1, 30 * 86400, '/opt/codex/bin/codex app-server --remote-control --listen unix:// --analytics-default-enabled'),
      processRow(409, 1, 30 * 86400, 'codex app-server daemon pid-update-loop'),
    ];
    const result = await runReaper(reaperOptions(dir, {
      listProcesses: () => rows,
      readCwd: (pid) => pid === 403 ? '/missing/worktree' : '/existing/worktree',
      pathExists: (path) => path !== '/missing/worktree',
    }));
    const reasons = result.actions.filter((action) => action.action === 'would_signal').map((action) => [action.pid, action.reason]);
    assert.deepEqual(reasons, [
      [401, 'orphan_mcp_or_app_server'],
      [402, 'orphan_mcp_or_app_server'],
      [403, 'fsmonitor_worktree_missing'],
      [404, 'orphan_fsmonitor_age'],
      [406, 'orphan_mcp_or_app_server'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reaper rimuove solo tmp_pack/tmp_idx vecchi e non aperti, nel dry-run non li cancella', async () => {
  const dir = tempDir('r2-reaper-pack-files-');
  try {
    const workspace = join(dir, 'workspace');
    const common = join(dir, 'common-git');
    const packDir = join(common, 'objects', 'pack');
    for (const path of [workspace, join(workspace, 'frontaliere-si-o-no'), join(workspace, 'frontaliere-articles'), join(workspace, 'frontaliere-reddit-devvit'), packDir]) {
      mkdirSync(path, { recursive: true });
    }
    const old = join(packDir, 'tmp_pack_abandoned');
    const open = join(packDir, 'tmp_idx_open');
    const recent = join(packDir, 'tmp_pack_recent');
    for (const file of [old, open, recent]) writeFileSync(file, 'x');
    utimesSync(old, new Date(NOW - 7 * 3600_000), new Date(NOW - 7 * 3600_000));
    utimesSync(open, new Date(NOW - 7 * 3600_000), new Date(NOW - 7 * 3600_000));
    utimesSync(recent, new Date(NOW - 3600_000), new Date(NOW - 3600_000));
    const fakeCommand = (bin, args) => {
      if (bin === 'fake-git' && args[0] === '-C') return { status: 0, stdout: `${common}\n` };
      if (bin === 'fake-lsof' && args[0] === '-nP' && args[1] === '-t') {
        return args[2] === open ? { status: 0, stdout: '42\n' } : { status: 1, stdout: '' };
      }
      return { status: 1, stdout: '' };
    };
    const result = await runReaper(reaperOptions(dir, { workspaceRoot: workspace, lsofBin: 'fake-lsof', runCommand: fakeCommand }));
    assert.deepEqual(result.actions.filter((action) => action.target === 'temporary_git_pack').map((action) => action.file), [old]);
    assert.equal(existsSync(old), true);
    assert.equal(existsSync(open), true);
    assert.equal(existsSync(recent), true);
    const applied = await runReaper(reaperOptions(dir, { workspaceRoot: workspace, lsofBin: 'fake-lsof', runCommand: fakeCommand, apply: true }));
    assert.ok(applied.actions.some((action) => action.action === 'delete' && action.file === old));
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(open), true);
    assert.equal(existsSync(recent), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reaper protegge current, release in uso e le due versioni piu recenti; applica solo quelle vecchie', async () => {
  const dir = tempDir('r2-codex-releases-');
  try {
    const makePackage = (name, releases, current) => {
      const packageDir = join(dir, '.codex', 'packages', name);
      const releaseDir = join(packageDir, 'releases');
      mkdirSync(releaseDir, { recursive: true });
      for (const release of releases) mkdirSync(join(releaseDir, release), { recursive: true });
      symlinkSync(join('releases', current), join(packageDir, 'current'));
      return { packageDir, releaseDir };
    };
    const standalone = makePackage('standalone', [
      '0.100.0', '0.110.0', '0.140.0', '0.150.0', '0.160.0', '0.170.0',
    ], '0.100.0');
    const daemon = makePackage('app-server-daemon', [
      '1.0.0', '1.1.0', '1.2.0', '1.3.0',
    ], '1.0.0');
    const inUsePath = join(standalone.releaseDir, '0.110.0');
    const process = processRow(701, 1, 30 * 86400, `${inUsePath}/bin/codex app-server --listen stdio`);
    const options = reaperOptions(dir, { listProcesses: () => [process] });

    const dryRun = await runReaper(options);
    const planned = dryRun.actions.filter((action) => action.target === 'codex_release');
    assert.deepEqual(planned.map((action) => [action.package, action.release]).sort(), [
      ['app-server-daemon', '1.1.0'],
      ['standalone', '0.140.0'],
      ['standalone', '0.150.0'],
    ]);
    assert.ok(planned.every((action) => action.action === 'would_delete'));
    for (const release of ['0.100.0', '0.110.0', '0.160.0', '0.170.0']) {
      assert.equal(existsSync(join(standalone.releaseDir, release)), true, `${release} is kept in dry-run`);
    }

    const applied = await runReaper({ ...options, apply: true });
    const removed = applied.actions.filter((action) => action.target === 'codex_release' && action.action === 'delete');
    assert.deepEqual(removed.map((action) => [action.package, action.release]).sort(), [
      ['app-server-daemon', '1.1.0'],
      ['standalone', '0.140.0'],
      ['standalone', '0.150.0'],
    ]);
    for (const release of ['0.140.0', '0.150.0']) {
      assert.equal(existsSync(join(standalone.releaseDir, release)), false, `${release} is removed in apply`);
    }
    for (const release of ['0.100.0', '0.110.0', '0.160.0', '0.170.0']) {
      assert.equal(existsSync(join(standalone.releaseDir, release)), true, `${release} is protected`);
    }
    assert.equal(existsSync(join(daemon.releaseDir, '1.1.0')), false);
    assert.equal(existsSync(join(daemon.releaseDir, '1.2.0')), true);
    assert.equal(existsSync(join(daemon.releaseDir, '1.3.0')), true);
    assert.equal(applied.actions.some((action) => action.reason === 'orphan_mcp_or_app_server'), false, 'a Codex process under its managed release is protected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opt-out impedisce al reaper di leggere o agire sui processi', async () => {
  const dir = tempDir('r2-reaper-opt-out-');
  try {
    const marker = join(dir, 'state', 'agent-orphan-reaper.disabled');
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, 'paused\n');
    const result = await runReaper(reaperOptions(dir, {
      disabledPath: marker,
      listProcesses: () => assert.fail('process reader called despite opt-out'),
    }));
    assert.equal(result.optedOut, true);
    assert.deepEqual(result.actions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('il sentinel aggiunge header e righe TSV con le misure e i campi R1', async () => {
  const dir = tempDir('r2-disk-tsv-');
  try {
    const metrics = {
      freeBytes: 20 * GIB,
      swapUsedBytes: 1 * GIB,
      swapTotalBytes: 4 * GIB,
      memoryPressure: 'pressure=20% free=80%',
      sitePackCount: 7,
      sitePackBytes: 123456,
      multiPackIndexMtime: '2026-11-19T12:00:00.000Z',
      health: { present: true, fields: { updated_epoch: '1799999990', repo: 'workspace', git_version: '2.56.0' } },
    };
    const common = { homeDir: dir, logDir: join(dir, 'logs'), statePath: join(dir, 'logs', 'state.json'), metrics, lazyFindings: [], notify: async () => true };
    await runDiskSentinel({ ...common, nowEpoch: 1_800_000_000 });
    await runDiskSentinel({ ...common, nowEpoch: 1_800_000_900 });
    const lines = readFileSync(join(dir, 'logs', 'disk-sentinel.tsv'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0].split('\t'), TSV_HEADER);
    const row = lines[1].split('\t');
    assert.equal(row[0], '2027-01-15T08:00:00.000Z');
    assert.equal(row[1], String(20 * GIB));
    assert.equal(row[2], String(GIB));
    assert.equal(row[3], String(4 * GIB));
    assert.equal(row[4], 'pressure=20% free=80%');
    assert.equal(row[5], '7');
    assert.equal(row[6], '123456');
    assert.equal(row[7], metrics.multiPackIndexMtime);
    assert.equal(row[8], '1799999990');
    assert.equal(row[9], 'workspace');
    assert.equal(row[TSV_HEADER.indexOf('health_git_version')], '2.56.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la sentinella continua ad appendere a un TSV precedente senza cambiarne lo schema', async () => {
  const dir = tempDir('r2-disk-legacy-tsv-');
  try {
    const logDir = join(dir, 'logs');
    const tsvPath = join(logDir, 'disk-sentinel.tsv');
    const legacyHeader = TSV_HEADER.slice(0, 8 + 9).join('\t');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(tsvPath, `${legacyHeader}\nlegacy-row\n`);
    await runDiskSentinel({
      homeDir: dir,
      logDir,
      tsvPath,
      statePath: join(logDir, 'state.json'),
      nowEpoch: 1_800_000_000,
      metrics: {
        freeBytes: 20 * GIB,
        swapUsedBytes: 0,
        swapTotalBytes: GIB,
        sitePackCount: 2,
        sitePackBytes: 12,
        health: { present: true, fields: { health_since_epoch: '1799990000', articles_pack_count: '4' } },
      },
      lazyFindings: [],
      notify: async () => true,
    });
    const lines = readFileSync(tsvPath, 'utf8').split('\n');
    assert.equal(lines[0], legacyHeader);
    assert.equal(lines[1], 'legacy-row');
    assert.equal(lines[2].split('\t').length, legacyHeader.split('\t').length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la sentinella considera health_since_epoch solo per consolidazioni mai eseguite, anche nel corpus', async () => {
  const dir = tempDir('r2-consolidation-health-since-');
  try {
    const nowEpoch = 1_800_000_000;
    const common = {
      homeDir: dir,
      logDir: join(dir, 'logs'),
      statePath: join(dir, 'logs', 'state.json'),
      metrics: {
        freeBytes: 20 * GIB,
        swapUsedBytes: 0,
        swapTotalBytes: 4 * GIB,
        health: { present: true, fields: {} },
      },
      lazyFindings: [],
      notify: async () => true,
    };
    const runWith = (fields, offset = 0) => runDiskSentinel({
      ...common,
      metrics: { ...common.metrics, health: { present: true, fields } },
      nowEpoch: nowEpoch + offset,
    });
    const recentSince = String(nowEpoch - 72 * 3600 + 1);
    const recent = await runWith({
      last_consolidation_epoch: '0',
      health_since_epoch: recentSince,
      articles_last_consolidation_epoch: '0',
      articles_health_since_epoch: recentSince,
    });
    assert.equal(recent.alerts.some((alert) => alert.type === 'consolidation_stale'), false);
    const row = readFileSync(join(dir, 'logs', 'disk-sentinel.tsv'), 'utf8').trim().split('\n')[1].split('\t');
    assert.equal(row[TSV_HEADER.indexOf('health_articles_health_since_epoch')], recentSince);

    const oldZero = await runWith({
      last_consolidation_epoch: '0',
      health_since_epoch: String(nowEpoch - 72 * 3600 - 1),
      articles_last_consolidation_epoch: '0',
      articles_health_since_epoch: recentSince,
    }, 1);
    assert.deepEqual(oldZero.alerts.map((alert) => alert.type), ['consolidation_stale']);
    assert.match(oldZero.alerts[0].summary, /sito:/);

    const oldSuccess = await runWith({
      last_consolidation_epoch: String(nowEpoch - 72 * 3600 - 1),
      health_since_epoch: recentSince,
      articles_last_consolidation_epoch: String(nowEpoch - 72 * 3600 - 1),
      articles_health_since_epoch: recentSince,
    }, 2);
    assert.deepEqual(oldSuccess.alerts.map((alert) => alert.type), ['consolidation_stale']);
    assert.match(oldSuccess.alerts[0].summary, /sito:.*corpus:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ogni allarme ha throttle indipendente di sei ore e l’alert lazy-fetch conserva le prove', async () => {
  const dir = tempDir('r2-disk-alerts-');
  try {
    const start = 1_800_000_000;
    const metrics = {
      freeBytes: 9 * GIB,
      swapUsedBytes: 4 * GIB,
      swapTotalBytes: 5 * GIB,
      memoryPressure: 'pressure=90% free=10%',
      sitePackCount: 3,
      sitePackBytes: 99,
      multiPackIndexMtime: '',
      health: { present: true, fields: { last_space_recovery_epoch: String(start - 7 * 3600), last_consolidation_epoch: String(start - 73 * 3600) } },
    };
    const notifications = [];
    const finding = (fingerprint, oid) => ({
      fingerprint,
      repo: '/workspace/frontaliere-si-o-no',
      packPath: `/workspace/frontaliere-si-o-no/.git/objects/pack/${fingerprint}.pack`,
      oid,
      message: `Causa del fetch ${fingerprint}`,
    });
    const runAt = (nowEpoch, lazy, processSnapshot) => runDiskSentinel({
      homeDir: dir,
      logDir: join(dir, 'logs'),
      statePath: join(dir, 'logs', 'state.json'),
      metrics,
      lazyFindings: lazy,
      processSnapshot,
      nowEpoch,
      notify: async (type) => { notifications.push(`${nowEpoch}:${type}`); return true; },
    });

    const first = await runAt(start, [finding('one', 'a'.repeat(40))], 'pid=70 ppid=1 uid=501 git fetch origin');
    assert.deepEqual(first.alerts.map((alert) => alert.type).sort(), [
      'consolidation_stale', 'free_space', 'lazy_fetch', 'space_recovery_stale', 'swap',
    ]);
    assert.equal(notifications.length, 5);
    const second = await runAt(start + 3600, [finding('two', 'b'.repeat(40))], 'pid=71 ppid=1 uid=501 codex app-server');
    assert.equal(second.notificationResults.every((result) => result.status === 'throttled'), true);
    assert.equal(notifications.length, 5);
    const third = await runAt(start + 6 * 3600 + 1, [finding('three', 'c'.repeat(40))], 'pid=72 ppid=1 uid=501 claude');
    assert.equal(third.notificationResults.every((result) => result.status === 'sent'), true);
    assert.equal(notifications.length, 10);
    assert.equal(new Set(notifications.map((entry) => entry.split(':')[1])).size, 5);
    const alert = readFileSync(join(dir, 'logs', 'disk-sentinel.alert'), 'utf8');
    assert.match(alert, /oid: c{40}/);
    assert.match(alert, /commit message: Causa del fetch three/);
    assert.match(alert, /process snapshot:/);
    assert.match(alert, /pid=72 ppid=1 uid=501 claude/);
    assert.match(alert, /free_space/);
    assert.match(alert, /swap/);
    assert.match(alert, /space_recovery_stale/);
    assert.match(alert, /consolidation_stale/);
    assert.equal(readFileSync(join(dir, 'logs', 'disk-sentinel.tsv'), 'utf8').trim().split('\n').length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la firma lazy-fetch accetta una riga con commit e scarta blob e più ref', () => {
  const dir = tempDir('r2-lazy-signature-');
  try {
    const workspace = join(dir, 'workspace');
    const repo = join(workspace, 'frontaliere-si-o-no');
    const common = join(repo, '.git');
    const packDir = join(common, 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    const commit = '1'.repeat(40);
    const blob = '2'.repeat(40);
    const ref = '3'.repeat(40);
    const packs = [
      ['pack-commit', `${commit} ${ref}\n`],
      ['pack-blob', `${blob} ${ref}\n`],
      ['pack-multiple', `${commit} ${ref}\n${commit} ${ref}\n`],
    ];
    for (const [name, content] of packs) {
      writeFileSync(join(packDir, `${name}.pack`), 'fake-pack');
      writeFileSync(join(packDir, `${name}.promisor`), content);
    }
    const fakeGit = (_bin, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'git version 2.56.0\n' };
      if (args.includes('rev-parse')) return { status: 0, stdout: '.git\n' };
      if (args.includes('cat-file')) {
        const oid = args.at(-1);
        return { status: 0, stdout: `${oid === commit ? 'commit' : 'blob'}\n` };
      }
      if (args.includes('show')) return { status: 0, stdout: 'recupero cronologia completa\n' };
      return { status: 1, stdout: '' };
    };
    const findings = scanLazyFetchPacks({ workspaceRoot: workspace, gitBin: 'fake-git', runCommand: fakeGit });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].oid, commit);
    assert.equal(findings[0].message, 'recupero cronologia completa');
    assert.equal(findings[0].packPath, join(packDir, 'pack-commit.pack'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('il lazy-fetch salva la catena dei processi git/codex/claude dello stesso utente', async () => {
  const dir = tempDir('r2-process-snapshot-');
  try {
    const finding = {
      fingerprint: 'snapshot-one',
      repo: '/workspace/frontaliere-si-o-no',
      packPath: '/workspace/frontaliere-si-o-no/.git/objects/pack/pack-one.pack',
      oid: '4'.repeat(40),
      message: 'messaggio commit',
    };
    await runDiskSentinel({
      homeDir: dir,
      logDir: join(dir, 'logs'),
      statePath: join(dir, 'logs', 'state.json'),
      nowEpoch: 1_800_000_000,
      uid: UID,
      metrics: { freeBytes: 20 * GIB, swapUsedBytes: 0, swapTotalBytes: GIB, health: { present: false, fields: {} } },
      lazyFindings: [finding],
      runCommand: (_bin, args) => ({
        status: 0,
        stdout: args[0] === '-axo'
          ? [
            '1 0 20-00:00:00 0 /sbin/launchd',
            '10 1 02:00:00 501 /bin/zsh -l',
            '11 10 01:00:00 501 /usr/bin/git fetch origin',
            '12 1 01:00:00 502 /usr/bin/claude --version',
          ].join('\n')
          : '',
      }),
      notify: async () => true,
    });
    const alert = readFileSync(join(dir, 'logs', 'disk-sentinel.alert'), 'utf8');
    assert.match(alert, /pid=11 ppid=10 uid=501 \/usr\/bin\/git fetch origin/);
    assert.match(alert, /pid=10 ppid=1 uid=501 \/bin\/zsh -l/);
    assert.match(alert, /chain_for=11: 11 <- 10 <- 1/);
    assert.doesNotMatch(alert, /uid=502/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la discovery sceglie il Git più recente trovato nel PATH o in ~/.local/git-*/bin', () => {
  const dir = tempDir('r2-git-discovery-');
  try {
    const systemDir = join(dir, 'system-bin');
    const modernDir = join(dir, '.local', 'git-2.56.0', 'bin');
    mkdirSync(systemDir, { recursive: true });
    mkdirSync(modernDir, { recursive: true });
    const oldGit = join(systemDir, 'git');
    const modernGit = join(modernDir, 'git');
    writeFileSync(oldGit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(modernGit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(oldGit, 0o755);
    chmodSync(modernGit, 0o755);
    const found = discoverGit({
      home: dir,
      pathValue: systemDir,
      runCommand: (bin) => ({ status: 0, stdout: bin === modernGit ? 'git version 2.56.0\n' : 'git version 2.39.2\n' }),
    });
    assert.equal(found, modernGit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace-autoupdate installa i plist e ricarica solo quando cambiano', () => {
  const dir = tempDir('r2-autoupdate-launchd-');
  try {
    const workspace = join(dir, 'workspace');
    const tools = join(dir, 'tools');
    const home = join(dir, 'home');
    const launchAgents = join(home, 'Library', 'LaunchAgents');
    const loadedDir = join(dir, 'loaded');
    const launchLog = join(dir, 'launchctl.log');
    const gitBin = join(tools, 'git');
    const launchctlBin = join(tools, 'launchctl');
    const plutilBin = join(tools, 'plutil');
    mkdirSync(join(workspace, 'bin'), { recursive: true });
    mkdirSync(join(workspace, 'config', 'launchd'), { recursive: true });
    mkdirSync(tools, { recursive: true });
    mkdirSync(loadedDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    copyFileSync(AUTUPDATE, join(workspace, 'bin', 'workspace-autoupdate'));
    chmodSync(join(workspace, 'bin', 'workspace-autoupdate'), 0o755);
    for (const label of ['ch.frontaliere.agent-orphan-reaper', 'ch.frontaliere.disk-sentinel']) {
      copyFileSync(join(ROOT, 'config', 'launchd', `${label}.plist`), join(workspace, 'config', 'launchd', `${label}.plist`));
    }
    symlinkSync(process.execPath, join(tools, 'node'));
    writeFileSync(gitBin, '#!/bin/sh\ncase "$*" in *"symbolic-ref --short -q HEAD"*) echo main;; *"rev-parse --verify -q origin/main"*) echo 0123456789012345678901234567890123456789;; *"rev-parse HEAD"*) echo 0123456789012345678901234567890123456789;; *) exit 0;; esac\n', { mode: 0o755 });
    writeFileSync(plutilBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(launchctlBin, `#!/bin/sh
operation=$1
label=${'${'}2##*/}
if [ "$operation" = bootstrap ]; then label=${'${'}3##*/}; label=${'${'}label%.plist}; fi
case "$operation" in
  print) test -f "$FAKE_LOADED_DIR/$label" ;;
  bootout) printf 'bootout %s\\n' "$label" >>"$FAKE_LAUNCH_LOG"; rm -f "$FAKE_LOADED_DIR/$label" ;;
  bootstrap) printf 'bootstrap %s\\n' "$label" >>"$FAKE_LAUNCH_LOG"; : >"$FAKE_LOADED_DIR/$label" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    for (const path of [gitBin, plutilBin, launchctlBin]) chmodSync(path, 0o755);
    const env = {
      HOME: home,
      PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
      AU_WORKSPACE: workspace,
      AU_LOG_DIR: join(dir, 'logs'),
      AU_LAUNCH_AGENTS_DIR: launchAgents,
      AU_GIT_BIN: gitBin,
      AU_PLUTIL_BIN: plutilBin,
      AU_LAUNCHCTL_BIN: launchctlBin,
      FAKE_LOADED_DIR: loadedDir,
      FAKE_LAUNCH_LOG: launchLog,
    };
    const run = () => spawnSync('/bin/bash', [join(workspace, 'bin', 'workspace-autoupdate'), 'run'], { encoding: 'utf8', env });
    const initialRun = run();
    assert.equal(initialRun.status, 0, `${initialRun.stdout}\n${initialRun.stderr}\n${readFileSync(join(dir, 'logs', 'workspace-autoupdate.log'), 'utf8')}`);
    const installed = readFileSync(join(launchAgents, 'ch.frontaliere.agent-orphan-reaper.plist'), 'utf8');
    assert.match(installed, new RegExp(`<string>${join(tools, 'node').replaceAll('/', '\\\/')}</string>`));
    assert.match(installed, /<string>\-\-apply<\/string>/);
    assert.match(installed, /<integer>900<\/integer>/);
    assert.match(installed, /<string>Background<\/string>/);
    const firstLog = readFileSync(launchLog, 'utf8');
    assert.equal((firstLog.match(/bootstrap ch\.frontaliere\.(?:agent-orphan-reaper|disk-sentinel)/g) || []).length, 2, `${firstLog}\n${readFileSync(join(dir, 'logs', 'workspace-autoupdate.log'), 'utf8')}`);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(launchLog, 'utf8'), firstLog);

    const sentinelTemplate = join(workspace, 'config', 'launchd', 'ch.frontaliere.disk-sentinel.plist');
    writeFileSync(sentinelTemplate, readFileSync(sentinelTemplate, 'utf8').replace('<integer>900</integer>', '<integer>901</integer>'));
    assert.equal(run().status, 0);
    const changedLog = readFileSync(launchLog, 'utf8');
    assert.equal((changedLog.match(/bootstrap ch\.frontaliere\.(?:agent-orphan-reaper|disk-sentinel)/g) || []).length, 3);
    assert.match(changedLog, /bootout ch\.frontaliere\.disk-sentinel/);
    assert.equal(readdirSync(launchAgents).filter((name) => name.includes('.tmp.')).length, 0);

    const install = spawnSync('/bin/bash', [join(workspace, 'bin', 'workspace-autoupdate'), 'install'], { encoding: 'utf8', env });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const updatePlist = readFileSync(join(launchAgents, 'ch.frontaliere.workspace-autoupdate.plist'), 'utf8');
    assert.match(updatePlist, /<string>ch\.frontaliere\.workspace-autoupdate<\/string>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
