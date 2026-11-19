#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverGit, readProcesses } from './agent-orphan-reaper.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = resolve(SCRIPT_DIR, '..');
const GIB = 1024 ** 3;
const SIX_HOURS_S = 6 * 60 * 60;
const THREE_DAYS_S = 72 * 60 * 60;
const NOTIFY_COOLDOWN_S = SIX_HOURS_S;
const HEALTH_FIELDS = [
  'updated_epoch',
  'repo',
  'last_space_recovery_epoch',
  'last_consolidation_epoch',
  'last_skip_step',
  'last_skip_reason',
  'pack_count',
  'pack_bytes',
  'git_version',
];
export const TSV_HEADER = [
  'timestamp_utc',
  'free_bytes',
  'swap_used_bytes',
  'swap_total_bytes',
  'memory_pressure',
  'site_pack_count',
  'site_pack_bytes',
  'multi_pack_index_mtime_utc',
  ...HEALTH_FIELDS.map((field) => `health_${field}`),
];

function command(commandPath, args, options = {}) {
  const result = spawnSync(commandPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function trimOutput(value) {
  return String(value || '').trim();
}

function parseByteSize(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)B?\s*$/i.exec(String(value));
  if (!match) return null;
  const scale = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2].toUpperCase()];
  return Math.round(Number(match[1]) * scale);
}

export function parseSwapUsage(value) {
  const total = /\btotal\s*=\s*([\d.]+\s*[KMGT]?B?)/i.exec(value)?.[1];
  const used = /\bused\s*=\s*([\d.]+\s*[KMGT]?B?)/i.exec(value)?.[1];
  return { totalBytes: parseByteSize(total), usedBytes: parseByteSize(used) };
}

function findRepoCommonDir(repo, gitBin, runCommand) {
  const result = runCommand(gitBin, ['-C', repo, 'rev-parse', '--git-common-dir']);
  if (result.status !== 0) return null;
  return resolve(repo, trimOutput(result.stdout));
}

function listRepositories(workspaceRoot) {
  return [
    workspaceRoot,
    join(workspaceRoot, 'frontaliere-si-o-no'),
    join(workspaceRoot, 'frontaliere-articles'),
    join(workspaceRoot, 'frontaliere-reddit-devvit'),
  ];
}

function runGitVersion(gitBin, runCommand) {
  const result = runCommand(gitBin, ['--version']);
  const match = result.status === 0 && /git version (\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(version, major, minor) {
  return Boolean(version && (version[0] > major || (version[0] === major && version[1] >= minor)));
}

function measureFreeBytes(root, runCommand, dfBin = '/bin/df') {
  const result = runCommand(dfBin, ['-kP', root]);
  if (result.status !== 0) return null;
  const rows = result.stdout.trim().split(/\r?\n/);
  const fields = rows.at(-1)?.trim().split(/\s+/) || [];
  const availableBlocks = Number(fields[3]);
  return Number.isFinite(availableBlocks) && availableBlocks >= 0 ? availableBlocks * 1024 : null;
}

function measureSwap(runCommand, sysctlBin = '/usr/sbin/sysctl') {
  const result = runCommand(sysctlBin, ['-n', 'vm.swapusage']);
  return result.status === 0 ? parseSwapUsage(result.stdout) : { totalBytes: null, usedBytes: null };
}

function measureMemoryPressure(runCommand, memoryPressureBin = '/usr/bin/memory_pressure') {
  const result = runCommand(memoryPressureBin, []);
  if (result.status !== 0) return '';
  const freePercent = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(result.stdout)?.[1];
  if (freePercent === undefined) return trimOutput(result.stdout).split(/\r?\n/)[0] || '';
  const pressurePercent = Math.max(0, Math.min(100, 100 - Number(freePercent)));
  return `pressure=${pressurePercent}% free=${freePercent}%`;
}

function measureSitePacks(workspaceRoot, gitBin, runCommand, fs) {
  const repo = join(workspaceRoot, 'frontaliere-si-o-no');
  const commonDir = findRepoCommonDir(repo, gitBin, runCommand);
  if (!commonDir) return { count: null, bytes: null, multiPackIndexMtime: '' };
  const packDir = join(commonDir, 'objects', 'pack');
  let names;
  try { names = fs.readdirSync(packDir); } catch { return { count: null, bytes: null, multiPackIndexMtime: '' }; }
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!/^pack-[^.]+\.pack$/.test(name)) continue;
    try {
      const stat = fs.statSync(join(packDir, name));
      if (!stat.isFile()) continue;
      count++;
      bytes += stat.size;
    } catch {
      // A pack may be replaced by Git while the inexpensive directory scan runs.
    }
  }
  let multiPackIndexMtime = '';
  try {
    const stat = fs.statSync(join(packDir, 'multi-pack-index'));
    multiPackIndexMtime = new Date(stat.mtimeMs).toISOString();
  } catch {
    // A repository without a multi-pack-index has no timestamp to report.
  }
  return { count, bytes, multiPackIndexMtime };
}

export function readHealthFile(filePath, fs = { readFileSync }) {
  let contents;
  try { contents = fs.readFileSync(filePath, 'utf8'); } catch { return { present: false, fields: {} }; }
  const fields = {};
  for (const line of String(contents).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (HEALTH_FIELDS.includes(key)) fields[key] = line.slice(separator + 1).trim();
  }
  return { present: true, fields };
}

function validOid(value) {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function readPromisorRefs(promisorPath, fs) {
  let contents;
  try { contents = fs.readFileSync(promisorPath, 'utf8'); } catch { return null; }
  const lines = String(contents).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 1) return null;
  const refs = lines[0].trim().split(/\s+/);
  if (refs.length !== 2 || !refs.every(validOid)) return null;
  return refs;
}

export function scanLazyFetchPacks({ workspaceRoot, gitBin, runCommand = command, fs = { existsSync, readdirSync, readFileSync, statSync } }) {
  if (!gitBin) return [];
  const version = runGitVersion(gitBin, runCommand);
  if (!versionAtLeast(version, 2, 44)) return [];
  const findings = [];
  for (const repo of listRepositories(workspaceRoot)) {
    if (!fs.existsSync(repo)) continue;
    const commonDir = findRepoCommonDir(repo, gitBin, runCommand);
    if (!commonDir) continue;
    const packDir = join(commonDir, 'objects', 'pack');
    let names;
    try { names = fs.readdirSync(packDir); } catch { continue; }
    for (const name of names) {
      if (!/^pack-[^.]+\.promisor$/.test(name)) continue;
      const promisorPath = join(packDir, name);
      const refs = readPromisorRefs(promisorPath, fs);
      if (!refs) continue;
      const packPath = join(packDir, `${name.slice(0, -'.promisor'.length)}.pack`);
      let promisorStat;
      let packStat;
      try {
        promisorStat = fs.statSync(promisorPath);
        packStat = fs.statSync(packPath);
      } catch {
        continue;
      }
      if (!packStat.isFile()) continue;
      const type = runCommand(gitBin, ['--no-lazy-fetch', '-C', repo, 'cat-file', '-t', refs[0]]);
      if (type.status !== 0 || trimOutput(type.stdout) !== 'commit') continue;
      const messageResult = runCommand(gitBin, ['--no-lazy-fetch', '-C', repo, 'show', '-s', '--format=%B', refs[0]]);
      const message = messageResult.status === 0 ? messageResult.stdout.trim() : '';
      findings.push({
        repo,
        packPath,
        promisorPath,
        oid: refs[0],
        message,
        fingerprint: `${repo}\0${name}\0${refs[0]}\0${packStat.size}\0${packStat.mtimeMs}\0${promisorStat.mtimeMs}`,
      });
    }
  }
  return findings;
}

function sanitizeText(value, limit = 4000) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/[\t\r]/g, ' ')
    .slice(0, limit);
}

function sanitizeCommand(value) {
  return sanitizeText(value, 500)
    .replace(/(token|password|secret|authorization)([=: ]+)\S+/gi, '$1$2[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@');
}

function processSnapshot({ processes, uid }) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const interesting = processes.filter((entry) => entry.uid === uid && /(?:^|[\s/])(?:git|codex|claude)(?:\s|$|-)/i.test(entry.command));
  const lines = [];
  const emitted = new Set();
  for (const process of interesting) {
    const chain = [];
    let current = process;
    const visited = new Set();
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      chain.push(current);
      current = byPid.get(current.ppid);
    }
    for (const item of chain) {
      if (emitted.has(item.pid)) continue;
      emitted.add(item.pid);
      lines.push(`pid=${item.pid} ppid=${item.ppid} uid=${item.uid} ${sanitizeCommand(item.command)}`);
    }
    lines.push(`chain_for=${process.pid}: ${chain.map((item) => item.pid).join(' <- ')}`);
  }
  return lines.length ? lines.join('\n') : '(nessun processo git/codex/claude dello stesso utente)';
}

function readState(statePath, fs) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      lastNotifications: state.lastNotifications && typeof state.lastNotifications === 'object' ? state.lastNotifications : {},
      seenLazyFetch: Array.isArray(state.seenLazyFetch) ? state.seenLazyFetch : [],
    };
  } catch {
    return { lastNotifications: {}, seenLazyFetch: [] };
  }
}

function writeState(statePath, state, fs) {
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, statePath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* rename already consumed it */ }
  }
}

function tsvValue(value) {
  return sanitizeText(value).replace(/[\t\r\n]/g, ' ');
}

function appendSample(tsvPath, timestamp, metrics, health, fs) {
  mkdirSync(dirname(tsvPath), { recursive: true });
  const hasFile = fs.existsSync(tsvPath) && fs.statSync(tsvPath).size > 0;
  if (hasFile) {
    const firstLine = fs.readFileSync(tsvPath, 'utf8').split(/\r?\n/, 1)[0];
    if (firstLine !== TSV_HEADER.join('\t')) throw new Error(`header non riconosciuto in ${tsvPath}`);
  } else {
    appendFileSync(tsvPath, `${TSV_HEADER.join('\t')}\n`);
  }
  const cells = [
    timestamp,
    metrics.freeBytes,
    metrics.swapUsedBytes,
    metrics.swapTotalBytes,
    metrics.memoryPressure,
    metrics.sitePackCount,
    metrics.sitePackBytes,
    metrics.multiPackIndexMtime,
    ...HEALTH_FIELDS.map((field) => health.fields[field] ?? ''),
  ].map(tsvValue);
  appendFileSync(tsvPath, `${cells.join('\t')}\n`);
}

export function deriveAlerts({ metrics, health, newLazyFindings, nowEpoch }) {
  const alerts = [];
  if (Number.isFinite(metrics.freeBytes) && metrics.freeBytes < 10 * GIB) {
    alerts.push({ type: 'free_space', summary: `spazio libero ${metrics.freeBytes} byte (< 10 GiB)` });
  }
  if (Number.isFinite(metrics.swapUsedBytes) && Number.isFinite(metrics.swapTotalBytes)
    && metrics.swapTotalBytes > 0 && metrics.swapUsedBytes / metrics.swapTotalBytes > 0.75) {
    alerts.push({ type: 'swap', summary: `swap usato ${metrics.swapUsedBytes}/${metrics.swapTotalBytes} byte (> 75%)` });
  }
  if (newLazyFindings.length) {
    alerts.push({ type: 'lazy_fetch', summary: `${newLazyFindings.length} nuovo pack promisor con commit` });
  }
  if (health.present) {
    const spaceValue = health.fields.last_space_recovery_epoch;
    const spaceEpoch = Number(spaceValue);
    if (String(spaceValue ?? '').trim() !== '' && Number.isFinite(spaceEpoch) && nowEpoch - spaceEpoch > SIX_HOURS_S) {
      alerts.push({ type: 'space_recovery_stale', summary: `ultimo recupero spazio ${nowEpoch - spaceEpoch} secondi fa` });
    }
    const consolidationValue = health.fields.last_consolidation_epoch;
    const consolidationEpoch = Number(consolidationValue);
    if (String(consolidationValue ?? '').trim() !== '' && Number.isFinite(consolidationEpoch)
      && nowEpoch - consolidationEpoch > THREE_DAYS_S) {
      alerts.push({ type: 'consolidation_stale', summary: `ultima consolidazione ${nowEpoch - consolidationEpoch} secondi fa` });
    }
  }
  return alerts;
}

function defaultNotify(type, message, runCommand) {
  const escapeAppleScript = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
  const script = `display notification "${escapeAppleScript(message)}" with title "Disk sentinel: ${escapeAppleScript(type)}"`;
  const result = runCommand('/usr/bin/osascript', ['-e', script]);
  return result.status === 0;
}

function collectProcessSnapshot(psBin, runCommand, uid) {
  try {
    const processes = readProcesses({ psBin, runCommand });
    return processSnapshot({ processes, uid });
  } catch {
    return '(tabella processi non disponibile)';
  }
}

function collectMetrics({ workspaceRoot, homeDir, gitBin, runCommand, fs, psBin, dfBin, sysctlBin, memoryPressureBin }) {
  const site = gitBin
    ? measureSitePacks(workspaceRoot, gitBin, runCommand, fs)
    : { count: null, bytes: null, multiPackIndexMtime: '' };
  const swap = measureSwap(runCommand, sysctlBin);
  const health = readHealthFile(join(homeDir, '.local', 'state', 'frontaliere', 'git-maintenance-health'), fs);
  return {
    freeBytes: measureFreeBytes(workspaceRoot, runCommand, dfBin),
    swapUsedBytes: swap.usedBytes,
    swapTotalBytes: swap.totalBytes,
    memoryPressure: measureMemoryPressure(runCommand, memoryPressureBin),
    sitePackCount: site.count,
    sitePackBytes: site.bytes,
    multiPackIndexMtime: site.multiPackIndexMtime,
    health,
    lazyFindings: gitBin ? scanLazyFetchPacks({ workspaceRoot, gitBin, runCommand, fs }) : [],
    psBin,
  };
}

export async function runDiskSentinel(options = {}) {
  const fs = options.fs || {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
  };
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE;
  const homeDir = options.homeDir || homedir();
  const logDir = options.logDir || join(homeDir, 'Library', 'Logs', 'frontaliere');
  const tsvPath = options.tsvPath || join(logDir, 'disk-sentinel.tsv');
  const alertPath = options.alertPath || join(logDir, 'disk-sentinel.alert');
  const statePath = options.statePath || join(logDir, 'disk-sentinel.state.json');
  const runCommand = options.runCommand || command;
  const gitBin = options.gitBin || discoverGit({ home: homeDir, runCommand });
  const psBin = options.psBin || '/bin/ps';
  const nowEpoch = options.nowEpoch ?? Math.floor(Date.now() / 1000);
  const timestamp = new Date(nowEpoch * 1000).toISOString();
  const state = readState(statePath, fs);
  const measured = options.metrics || collectMetrics({
    workspaceRoot,
    homeDir,
    gitBin,
    runCommand,
    fs,
    psBin,
    dfBin: options.dfBin,
    sysctlBin: options.sysctlBin,
    memoryPressureBin: options.memoryPressureBin,
  });
  const health = measured.health || { present: false, fields: {} };
  const findings = options.lazyFindings || measured.lazyFindings || [];
  const seen = new Set(state.seenLazyFetch);
  const newLazyFindings = findings.filter((finding) => !seen.has(finding.fingerprint));
  for (const finding of findings) seen.add(finding.fingerprint);
  const nowMetrics = {
    freeBytes: measured.freeBytes ?? null,
    swapUsedBytes: measured.swapUsedBytes ?? null,
    swapTotalBytes: measured.swapTotalBytes ?? null,
    memoryPressure: measured.memoryPressure ?? '',
    sitePackCount: measured.sitePackCount ?? null,
    sitePackBytes: measured.sitePackBytes ?? null,
    multiPackIndexMtime: measured.multiPackIndexMtime ?? '',
  };
  appendSample(tsvPath, timestamp, nowMetrics, health, fs);

  const alerts = deriveAlerts({ metrics: nowMetrics, health, newLazyFindings, nowEpoch });
  const notify = options.notify || ((type, message) => defaultNotify(type, message, runCommand));
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  let processDetails = '';
  if (newLazyFindings.length) {
    processDetails = options.processSnapshot || collectProcessSnapshot(psBin, runCommand, uid);
  }
  const notificationResults = [];
  for (const alert of alerts) {
    const last = Number(state.lastNotifications[alert.type]);
    if (Number.isFinite(last) && nowEpoch - last < NOTIFY_COOLDOWN_S) {
      notificationResults.push({ type: alert.type, status: 'throttled' });
      continue;
    }
    const success = await notify(alert.type, alert.summary);
    if (success) {
      state.lastNotifications[alert.type] = nowEpoch;
      notificationResults.push({ type: alert.type, status: 'sent' });
    } else {
      notificationResults.push({ type: alert.type, status: 'failed' });
    }
  }

  if (alerts.length) {
    const lines = [`DISK SENTINEL ALERT ${timestamp}`];
    for (const alert of alerts) {
      const result = notificationResults.find((entry) => entry.type === alert.type);
      lines.push(`- ${alert.type}: ${alert.summary} [notification=${result?.status || 'unknown'}]`);
      if (alert.type === 'lazy_fetch') {
        for (const finding of newLazyFindings) {
          lines.push(`  repo: ${finding.repo}`);
          lines.push(`  pack: ${finding.packPath}`);
          lines.push(`  oid: ${finding.oid}`);
          lines.push(`  commit message: ${sanitizeText(finding.message, 4000) || '(vuoto)'}`);
        }
        lines.push('  process snapshot:');
        lines.push(...processDetails.split(/\r?\n/).map((line) => `    ${line}`));
      }
    }
    mkdirSync(dirname(alertPath), { recursive: true });
    writeFileSync(alertPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  }

  state.seenLazyFetch = [...seen].slice(-1000);
  writeState(statePath, state, fs);
  return { timestamp, metrics: nowMetrics, alerts, newLazyFindings, notificationResults, tsvPath, alertPath };
}

function usage() {
  return 'uso: disk-sentinel [--help]\nRegistra una misura TSV e aggiorna gli allarmi locali; non modifica Git o processi.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (args.length) {
    process.stderr.write(`${usage()}\n`);
    process.exit(64);
  }
  const result = await runDiskSentinel();
  process.stdout.write(`disk-sentinel timestamp=${result.timestamp} alerts=${result.alerts.map((alert) => alert.type).join(',') || 'none'}\n`);
}
