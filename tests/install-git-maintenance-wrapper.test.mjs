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
if (args[0] === '-extract' && args[1] === 'ProgramArguments.1' && args[2] === 'raw') {
  process.stdout.write(JSON.parse(readFileSync(args[3], 'utf8')).ProgramArguments[1]);
} else if (args[0] === '-replace' && args[1] === 'ProgramArguments' && args[2] === '-json') {
  const plist = JSON.parse(readFileSync(args[4], 'utf8'));
  plist.ProgramArguments = JSON.parse(args[3]);
  writeFileSync(args[4], JSON.stringify(plist));
} else if (args[0] === '-lint') {
  JSON.parse(readFileSync(args[1], 'utf8'));
} else if (args[0] === '-replace' || args[0] === '-insert') {
  // The test focuses on replacing the complete argv vector; other keys are
  // accepted so the installer can exercise its normal LaunchAgent path.
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
    const fakePlutilScript = join(toolDir, 'fake-plutil.mjs');
    const fakePlutil = join(toolDir, 'plutil');
    const fakeLaunchctl = join(toolDir, 'launchctl');
    const globalGitConfig = join(root, 'gitconfig');
    const launchctlLog = join(root, 'launchctl.log');
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(toolDir, { recursive: true });
    execFileSync('git', ['init', '--quiet', siteRepo]);
    writeFileSync(fakePlutilScript, FAKE_PLUTIL);
    writeFileSync(fakePlutil, `#!/bin/sh\nexec node "${fakePlutilScript}" "$@"\n`, { mode: 0o755 });
    writeFileSync(fakeLaunchctl, '#!/bin/sh\nprintf "%s\\n" "$*" >>"$FAKE_LAUNCHCTL_LOG"\n', { mode: 0o755 });
    chmodSync(fakePlutil, 0o755);
    const env = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: globalGitConfig,
      FRONTALIERE_SITE_REPO: siteRepo,
      FRONTALIERE_PLUTIL_BIN: fakePlutil,
      FRONTALIERE_LAUNCHCTL_BIN: fakeLaunchctl,
      FAKE_LAUNCHCTL_LOG: launchctlLog,
    };

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
    assert.equal(execFileSync('git', ['-C', siteRepo, 'config', '--local', '--get', 'maintenance.strategy'], { encoding: 'utf8' }).trim(), 'none');
    assert.match(readFileSync(launchctlLog, 'utf8'), /bootstrap gui\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
