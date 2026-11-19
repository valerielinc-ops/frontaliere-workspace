#!/usr/bin/env node

import { appendFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = resolve(SCRIPT_DIR, '..');
const BROKER_MIN_AGE_S = 2 * 60 * 60;
const PROCESS_MIN_AGE_S = 2 * 60 * 60;
const FSMONITOR_MIN_AGE_S = 24 * 60 * 60;
const TEMP_PACK_MIN_AGE_MS = 6 * 60 * 60 * 1000;
const BROKER_SAMPLE_GAP_MS = 30_000;
const TERM_GRACE_MS = 15_000;

export function elapsedSeconds(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export function parseProcessTable(output) {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*\S)?\s*$/.exec(line);
    if (!match) continue;
    const ageSeconds = elapsedSeconds(match[3]);
    if (ageSeconds === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsed: match[3],
      ageSeconds,
      uid: Number(match[4]),
      command: match[5] || '',
    });
  }
  return rows;
}

export function isBroker(process) {
  return /app-server-broker\.mjs\s+serve(?:\s|$)/.test(process.command);
}

// The Codex app-server daemon is also a `codex app-server` with ppid 1 (started
// by launchd) and legitimately lives for weeks: `.../app-server-daemon/.../codex
// app-server daemon pid-update-loop`, and its child `... app-server
// --remote-control ...`. Measured on the agent host on 2026-11-19 (50 days old).
export function isCodexAppServerDaemon(command) {
  return /\/\.codex\/packages\/[^/]+\/releases\/[^/]+\//.test(command)
    || /\/app-server-daemon\//.test(command)
    || /(?:^|[\s/])codex\s+app-server\s+daemon(?:\s|$)/.test(command)
    || /\s--remote-control(?:\s|$)/.test(command);
}

export function isOrphanMcpOrAppServer(process) {
  const command = process.command;
  return /context7-mcp/i.test(command)
    || /firebase(?:-tools)?(?:@[^\s]+)?[^\n]*\bmcp\b/i.test(command)
    || (/(?:^|[\s/])codex\s+app-server(?:\s|$)/i.test(command) && !isCodexAppServerDaemon(command));
}

export function isFsmonitor(process) {
  return /(?:^|[\s/])git\s+fsmonitor--daemon\s+run(?:\s|$)/.test(process.command);
}

export function descendantsOf(rootPid, processes) {
  const children = new Map();
  for (const process of processes) {
    const list = children.get(process.ppid) || [];
    list.push(process);
    children.set(process.ppid, list);
  }
  const found = [];
  const visited = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(parent) || []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export function readProcesses({ psBin = '/bin/ps', runCommand = run } = {}) {
  const result = runCommand(psBin, ['-axo', 'pid=,ppid=,etime=,uid=,command=']);
  if (result.status !== 0) throw new Error(`ps exit ${result.status}`);
  return parseProcessTable(result.stdout);
}

function socketCount(pid, { lsofBin, runCommand }) {
  if (!lsofBin) return null;
  const result = runCommand(lsofBin, ['-nP', '-a', '-U', '-p', String(pid)]);
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.status !== 0 && !(result.status === 1 && !stdout.trim() && !stderr.trim())) return null;
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 0 ? lines.length - 1 : 0;
}

function processCwd(pid, { lsofBin, runCommand }) {
  if (!lsofBin) return null;
  const result = runCommand(lsofBin, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (result.status !== 0) return null;
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('n'));
  return line ? line.slice(1) : null;
}

function ownProcessTree(processes, ownPid) {
  return new Set([ownPid, ...descendantsOf(ownPid, processes).map((process) => process.pid)]);
}

function isTargetOwner(process, uid, excluded) {
  return process.uid === uid && !excluded.has(process.pid);
}

function quoteLogValue(value) {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function appendAction(logPath, action) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...action })}\n`);
}

function record(actions, logPath, action) {
  actions.push(action);
  if (logPath) appendAction(logPath, action);
}

function findExecutable(name, { pathValue = process.env.PATH || '', extra = [] } = {}) {
  const candidates = [...extra, ...pathValue.split(':').filter(Boolean).map((entry) => join(entry, name))];
  for (const candidate of candidates) {
    try {
      if (isAbsolute(candidate) && existsSync(candidate) && (statSync(candidate).mode & 0o111)) return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }
  return null;
}

export function discoverGit({ home = homedir(), pathValue = process.env.PATH || '', runCommand = run, fs = { readdirSync } } = {}) {
  const candidates = new Set();
  for (const dir of pathValue.split(':').filter(Boolean)) candidates.add(join(dir, 'git'));
  candidates.add(join(home, '.local', 'bin', 'git'));
  candidates.add('/opt/homebrew/bin/git');
  candidates.add('/usr/local/bin/git');
  candidates.add('/usr/bin/git');
  try {
    for (const entry of fs.readdirSync(join(home, '.local'))) {
      if (/^git[-.]/.test(entry)) candidates.add(join(home, '.local', entry, 'bin', 'git'));
    }
  } catch {
    // The optional per-user tool directory may not exist.
  }

  const versions = [];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !(statSync(candidate).mode & 0o111)) continue;
      const result = runCommand(candidate, ['--version']);
      const match = result.status === 0 && /git version (\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
      if (!match) continue;
      versions.push({
        path: candidate,
        version: match.slice(1).map(Number),
      });
    } catch {
      // An unusable shim or stale install does not prevent trying other Git binaries.
    }
  }
  versions.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
    return 0;
  });
  return versions[0]?.path || null;
}

function commonPackDirectories({ workspaceRoot, gitBin, runCommand, exists = existsSync }) {
  const repositories = [
    workspaceRoot,
    join(workspaceRoot, 'frontaliere-si-o-no'),
    join(workspaceRoot, 'frontaliere-articles'),
    join(workspaceRoot, 'frontaliere-reddit-devvit'),
  ];
  const directories = new Set();
  for (const repo of repositories) {
    if (!exists(repo)) continue;
    const result = runCommand(gitBin, ['-C', repo, 'rev-parse', '--git-common-dir']);
    if (result.status !== 0) continue;
    const commonDir = resolve(repo, result.stdout.trim());
    directories.add(join(commonDir, 'objects', 'pack'));
  }
  return [...directories];
}

function openedByProcess(filePath, { lsofBin, runCommand }) {
  if (!lsofBin) return null;
  const result = runCommand(lsofBin, ['-nP', '-t', filePath]);
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.status === 0) return stdout.trim() ? true : null;
  if (result.status === 1 && !stdout.trim() && !stderr.trim()) return false;
  return null;
}

function listOldTemporaryPacks(packDirectories, { nowMs, fs = { readdirSync, lstatSync }, openedFile }) {
  const candidates = [];
  for (const packDir of packDirectories) {
    let names;
    try {
      names = fs.readdirSync(packDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^tmp_(?:pack|idx)_/.test(name)) continue;
      const filePath = join(packDir, name);
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || nowMs - stat.mtimeMs <= TEMP_PACK_MIN_AGE_MS) continue;
        const isOpen = openedFile(filePath);
        if (isOpen !== false) continue;
        candidates.push({ filePath, name, ageMs: nowMs - stat.mtimeMs });
      } catch {
        // A file can disappear between readdir and lstat; leave it alone.
      }
    }
  }
  return candidates;
}

function parseReleaseVersion(name) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(name);
  if (!match) return null;
  return { name, version: match.slice(1, 4).map(Number) };
}

function compareReleaseVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left.version[index] !== right.version[index]) return right.version[index] - left.version[index];
  }
  if (left.name === right.name) return 0;
  return left.name < right.name ? 1 : -1;
}

function releaseUsedByProcess(releasePath, processes, uid) {
  const marker = `${releasePath}/`;
  return processes.some((process) => process.uid === uid
    && (process.command === releasePath || String(process.command).includes(marker)));
}

function codexReleaseCandidates(homeDir, processes, uid, fs) {
  const candidates = [];
  const readLink = fs.readlinkSync || readlinkSync;
  for (const packageName of ['standalone', 'app-server-daemon']) {
    const packageDir = join(homeDir, '.codex', 'packages', packageName);
    const releaseDir = join(packageDir, 'releases');
    const currentPath = join(packageDir, 'current');
    let names;
    try { names = fs.readdirSync(releaseDir); } catch { continue; }

    let currentTarget = '';
    try { currentTarget = resolve(packageDir, readLink(currentPath)); } catch {
      // Keep operating when no current symlink exists; named live releases stay protected below.
    }

    const releases = [];
    for (const name of names) {
      const version = parseReleaseVersion(name);
      if (!version) continue;
      const path = join(releaseDir, name);
      try {
        if (!fs.lstatSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      releases.push({ packageName, path, name, version });
    }
    releases.sort(compareReleaseVersions);
    const newest = new Set(releases.slice(0, 2).map((release) => release.path));
    for (const release of releases) {
      if (release.path === currentTarget || newest.has(release.path)) continue;
      if (releaseUsedByProcess(release.path, processes, uid)) continue;
      candidates.push({ ...release, target: 'codex_release', reason: 'unused_old_codex_release' });
    }
  }
  return candidates;
}

function processCandidates(processes, uid, excluded, cwdReader, pathExists) {
  const candidates = [];
  for (const process of processes) {
    if (process.ppid !== 1 || !isTargetOwner(process, uid, excluded)) continue;
    if (isOrphanMcpOrAppServer(process) && process.ageSeconds >= PROCESS_MIN_AGE_S) {
      candidates.push({ process, reason: 'orphan_mcp_or_app_server' });
      continue;
    }
    if (isFsmonitor(process)) {
      const cwd = cwdReader(process.pid);
      const missingWorktree = Boolean(cwd && !pathExists(cwd));
      if (process.ageSeconds >= FSMONITOR_MIN_AGE_S || missingWorktree) {
        candidates.push({ process, reason: missingWorktree ? 'fsmonitor_worktree_missing' : 'orphan_fsmonitor_age', cwd });
      }
    }
  }
  return candidates;
}

async function stopTree(candidate, { apply, processes, uid, excluded, listProcesses, signal, sleep, logPath, actions }) {
  const root = candidate.process;
  const original = [root, ...descendantsOf(root.pid, processes)]
    .filter((process) => process.uid === uid && !excluded.has(process.pid));
  if (!apply) {
    record(actions, logPath, {
      action: 'would_signal',
      signal: 'SIGTERM',
      pid: root.pid,
      reason: candidate.reason,
      command: quoteLogValue(root.command),
    });
    for (const process of original.slice(1)) {
      record(actions, logPath, {
        action: 'would_signal_after_grace',
        signal: 'SIGKILL',
        pid: process.pid,
        reason: candidate.reason,
        command: quoteLogValue(process.command),
      });
    }
    record(actions, logPath, {
      action: 'would_signal_after_grace',
      signal: 'SIGKILL',
      pid: root.pid,
      reason: candidate.reason,
      command: quoteLogValue(root.command),
    });
    return;
  }

  try {
    signal(root.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      record(actions, logPath, { action: 'skip', reason: 'process_already_exited', pid: root.pid, target: candidate.reason });
      return;
    }
    throw error;
  }
  record(actions, logPath, {
    action: 'signal',
    signal: 'SIGTERM',
    pid: root.pid,
    reason: candidate.reason,
    command: quoteLogValue(root.command),
  });
  await sleep(TERM_GRACE_MS);
  let after = [];
  try {
    after = listProcesses();
  } catch {
    // If the process table cannot be read, never guess which PIDs survived.
    return;
  }
  const byPid = new Map(after.filter((process) => process.uid === uid && !excluded.has(process.pid)).map((process) => [process.pid, process]));
  const currentDescendants = new Set(descendantsOf(root.pid, after).map((process) => process.pid));
  const survivors = new Set(currentDescendants);
  for (const old of original) {
    const current = byPid.get(old.pid);
    if (current && current.command === old.command) survivors.add(old.pid);
  }
  const ordered = [...survivors].filter((pid) => byPid.has(pid));
  for (const pid of ordered) {
    const current = byPid.get(pid);
    try {
      signal(pid, 'SIGKILL');
    } catch (error) {
      if (error?.code === 'ESRCH') {
        record(actions, logPath, { action: 'skip', reason: 'process_already_exited', pid, target: candidate.reason });
        continue;
      }
      throw error;
    }
    record(actions, logPath, {
      action: 'signal',
      signal: 'SIGKILL',
      pid,
      reason: candidate.reason,
      command: quoteLogValue(current.command),
    });
  }
}

export async function runReaper(options = {}) {
  const homeDir = options.homeDir || homedir();
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const nowMs = options.nowMs ?? Date.now();
  const apply = Boolean(options.apply);
  const logPath = options.logPath || join(homeDir, 'Library', 'Logs', 'frontaliere', 'agent-orphan-reaper.log');
  const stateDir = options.stateDir || join(homeDir, '.local', 'state', 'frontaliere');
  const disabledPath = options.disabledPath || join(stateDir, 'agent-orphan-reaper.disabled');
  const actions = [];
  const fs = options.fs || { existsSync, readdirSync, lstatSync, readlinkSync, rmSync };
  if (fs.existsSync(disabledPath)) return { optedOut: true, actions };

  const runCommand = options.runCommand || run;
  const gitBin = options.gitBin || discoverGit({ home: homeDir, runCommand });
  const psBin = options.psBin || findExecutable('ps', { extra: ['/bin/ps'] });
  const lsofBin = options.lsofBin || findExecutable('lsof', { extra: ['/usr/sbin/lsof', '/usr/bin/lsof'] });
  const listProcesses = options.listProcesses || (() => readProcesses({ psBin, runCommand }));
  const readSocketCount = options.readSocketCount || ((pid) => socketCount(pid, { lsofBin, runCommand }));
  const readCwd = options.readCwd || ((pid) => processCwd(pid, { lsofBin, runCommand }));
  const sleep = options.sleep || ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const signal = options.signal || ((pid, sig) => process.kill(pid, sig));
  const pathExists = options.pathExists || existsSync;
  let firstProcesses;
  try {
    firstProcesses = listProcesses();
  } catch (error) {
    record(actions, logPath, { action: 'abort', reason: 'process_table_unavailable', detail: quoteLogValue(error.message) });
    return { optedOut: false, actions };
  }
  const excluded = ownProcessTree(firstProcesses, options.ownPid ?? process.pid);
  const brokersFirst = firstProcesses.filter((process) => process.ppid === 1
    && process.ageSeconds >= BROKER_MIN_AGE_S
    && isBroker(process)
    && isTargetOwner(process, uid, excluded));
  const sampledFirst = [];
  for (const broker of brokersFirst) {
    const count = readSocketCount(broker.pid);
    if (count !== null && count <= 4) sampledFirst.push({ process: broker, socketCount: count });
  }

  const brokerCandidates = [];
  if (sampledFirst.length) {
    await sleep(BROKER_SAMPLE_GAP_MS);
    let secondProcesses = [];
    try {
      secondProcesses = listProcesses();
    } catch {
      secondProcesses = [];
    }
    const secondByPid = new Map(secondProcesses.map((process) => [process.pid, process]));
    for (const first of sampledFirst) {
      const second = secondByPid.get(first.process.pid);
      if (!second || second.ppid !== 1 || second.uid !== uid || !isBroker(second)
        || second.ageSeconds < BROKER_MIN_AGE_S || second.command !== first.process.command || excluded.has(second.pid)) continue;
      const count = readSocketCount(second.pid);
      if (count !== null && count <= 4) brokerCandidates.push({ process: second, reason: 'inactive_orphan_broker', socketCount: count });
    }
  }

  const signalFn = options.signal || ((pid, sig) => process.kill(pid, sig));
  let currentProcesses = firstProcesses;
  for (const candidate of brokerCandidates) {
    await stopTree(candidate, {
      apply,
      processes: currentProcesses,
      uid,
      excluded,
      listProcesses,
      signal: signalFn,
      sleep,
      logPath,
      actions,
    });
    if (apply) {
      try { currentProcesses = listProcesses(); } catch { /* retain the prior safe snapshot */ }
    }
  }

  try { currentProcesses = listProcesses(); } catch { /* retain the last complete snapshot */ }
  const targets = processCandidates(currentProcesses, uid, excluded, readCwd, pathExists);
  for (const candidate of targets) {
    await stopTree(candidate, {
      apply,
      processes: currentProcesses,
      uid,
      excluded,
      listProcesses,
      signal: signalFn,
      sleep,
      logPath,
      actions,
    });
    if (apply) {
      try { currentProcesses = listProcesses(); } catch { /* retain the prior safe snapshot */ }
    }
  }

  if (!gitBin) {
    record(actions, logPath, { action: 'skip', reason: 'git_not_found_for_temp_pack_scan' });
  } else {
    const packDirectories = commonPackDirectories({ workspaceRoot, gitBin, runCommand, exists: fs.existsSync });
    const temporaryPacks = listOldTemporaryPacks(packDirectories, {
      nowMs,
      fs,
      openedFile: (filePath) => openedByProcess(filePath, { lsofBin, runCommand }),
    });
    for (const candidate of temporaryPacks) {
      if (apply) {
        let stillEligible = false;
        try {
          const stat = fs.lstatSync(candidate.filePath);
          stillEligible = stat.isFile()
            && nowMs - stat.mtimeMs > TEMP_PACK_MIN_AGE_MS
            && openedByProcess(candidate.filePath, { lsofBin, runCommand }) === false;
        } catch {
          stillEligible = false;
        }
        if (!stillEligible) {
          record(actions, logPath, { action: 'skip', target: 'temporary_git_pack', reason: 'changed_open_or_unverifiable', file: candidate.filePath });
          continue;
        }
      }
      record(actions, logPath, {
        action: apply ? 'delete' : 'would_delete',
        target: 'temporary_git_pack',
        file: candidate.filePath,
        age_ms: candidate.ageMs,
      });
      if (apply) {
        try { fs.rmSync(candidate.filePath); } catch (error) {
          record(actions, logPath, { action: 'delete_failed', file: candidate.filePath, detail: quoteLogValue(error.message) });
        }
      }
    }
  }
  let releaseProcesses;
  try {
    releaseProcesses = listProcesses();
  } catch (error) {
    record(actions, logPath, {
      action: 'skip',
      target: 'codex_release',
      reason: 'process_table_unavailable',
      detail: quoteLogValue(error.message),
    });
    return { optedOut: false, actions };
  }
  const oldReleases = codexReleaseCandidates(homeDir, releaseProcesses, uid, fs);
  for (const candidate of oldReleases) {
    if (apply) {
      let currentProcessesForRelease;
      try {
        currentProcessesForRelease = listProcesses();
      } catch (error) {
        record(actions, logPath, {
          action: 'skip',
          target: 'codex_release',
          reason: 'process_table_unavailable',
          package: candidate.packageName,
          release: candidate.name,
          detail: quoteLogValue(error.message),
        });
        continue;
      }
      const stillEligible = codexReleaseCandidates(homeDir, currentProcessesForRelease, uid, fs)
        .some((entry) => entry.path === candidate.path);
      if (!stillEligible) {
        record(actions, logPath, {
          action: 'skip',
          target: 'codex_release',
          reason: 'became_current_in_use_or_recent',
          package: candidate.packageName,
          release: candidate.name,
          path: candidate.path,
        });
        continue;
      }
      try {
        const stat = fs.lstatSync(candidate.path);
        if (!stat.isDirectory()) {
          record(actions, logPath, {
            action: 'skip',
            target: 'codex_release',
            reason: 'release_not_directory',
            package: candidate.packageName,
            release: candidate.name,
            path: candidate.path,
          });
          continue;
        }
        fs.rmSync(candidate.path, { recursive: true });
      } catch (error) {
        record(actions, logPath, {
          action: 'delete_failed',
          target: 'codex_release',
          package: candidate.packageName,
          release: candidate.name,
          path: candidate.path,
          detail: quoteLogValue(error.message),
        });
        continue;
      }
    }
    record(actions, logPath, {
      action: apply ? 'delete' : 'would_delete',
      target: 'codex_release',
      reason: candidate.reason,
      package: candidate.packageName,
      release: candidate.name,
      path: candidate.path,
    });
  }
  return { optedOut: false, actions };
}

function usage() {
  return 'uso: agent-orphan-reaper [--apply] [--help]\nDefault: dry-run; --apply abilita segnali e rimozione dei soli residui verificati.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (args.some((arg) => arg !== '--apply')) {
    process.stderr.write(`${usage()}\n`);
    process.exit(64);
  }
  const result = await runReaper({ apply: args.includes('--apply') });
  const mode = args.includes('--apply') ? 'apply' : 'dry-run';
  process.stdout.write(`agent-orphan-reaper mode=${mode} opted_out=${result.optedOut} actions=${result.actions.length}\n`);
  for (const action of result.actions) {
    if (action.target !== 'codex_release' || !['would_delete', 'delete'].includes(action.action)) continue;
    process.stdout.write(`codex-release action=${action.action} package=${action.package} release=${action.release} path=${action.path}\n`);
  }
}
