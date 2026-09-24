#!/usr/bin/env node
/**
 * Detached, best-effort observer for a command already admitted by
 * agent-resource-guard.mjs. It records the actual command PID(s), CPU and RSS
 * from `ps`; it never sends signals to the observed command.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const VERSION = 1;
const MAX_RUNTIME_MS = Number(process.env.FRONTALIERE_AGENT_OBSERVER_MAX_MS) || 3 * 60 * 60 * 1000;
const STARTUP_GRACE_MS = 60 * 1000;
const SAMPLE_INTERVAL_MS = 1000;

function argsObject(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? '' : (argv[i + 1] ?? '');
    if (out[key] !== '') i += 1;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandRows() {
  try {
    const raw = execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,etime=,command='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      return [{
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpuPct: Number(match[3].replace(',', '.')),
        rssKb: Number(match[4]),
        elapsed: match[5],
        command: match[6],
      }];
    });
  } catch {
    return [];
  }
}

function matches(row, category, needle, sourceCommand, baselinePids) {
  const text = row.command;
  if (text.includes('agent-command-observer.mjs')) return false;
  if (baselinePids.has(row.pid)) return false;
  if (category === 'git-history') return Boolean(needle) && text.includes(needle) && /\/git\s+(?:log|rev-list|grep)\b/.test(text);
  if (category === 'typecheck') return /(?:^|[\s/])tsc(?:\.js)?(?:\s|$)/.test(text) || text.includes('/typescript/bin/tsc');
  if (category === 'sibling-gate') return text.includes(needle || 'check-sibling-patterns');
  if (category === 'build-or-test') {
    if (needle === 'vite') return /\bvite(?:\.js)?\b.*\bbuild\b/.test(text) || text.includes('vite build');
    if (needle === 'vitest') return text.includes('vitest');
    if (needle === 'playwright') return text.includes('playwright');
    return text.includes('node') && sourceCommand.includes('npm run');
  }
  return false;
}

function append(runtimeDir, value) {
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(runtimeDir, 'commands.jsonl'), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // best effort
  }
}

async function main() {
  const options = argsObject(process.argv.slice(2));
  const runtimeDir = path.resolve(options.runtime || os.tmpdir());
  const id = options.id || `unknown-${process.pid}`;
  const category = options.category || 'unknown';
  const needle = options.needle || '';
  const baselinePids = new Set((options['baseline-pids'] || '').split(',').filter(Boolean).map(Number));
  const sourceCommand = options.command || '';
  const startedAt = Date.now();
  const maxDeadline = startedAt + MAX_RUNTIME_MS;
  let seen = false;
  let missingPrimarySamples = 0;
  let sampleCount = 0;
  let maxCpuPct = 0;
  let maxRssKb = 0;
  let stopRequested = false;
  const pids = new Set();
  const primaryPids = new Set();

  process.on('SIGTERM', () => { stopRequested = true; });

  append(runtimeDir, { type: 'observer_attached', version: VERSION, id, observerPid: process.pid, category, at: startedAt });

  while (!stopRequested && Date.now() < maxDeadline) {
    const rows = commandRows().filter((row) => matches(row, category, needle, sourceCommand, baselinePids));
    if (rows.length) {
      if (!seen) {
        seen = true;
        for (const row of rows) primaryPids.add(row.pid);
      } else if (!rows.some((row) => primaryPids.has(row.pid))) {
        // Do not attach a later, unrelated invocation with the same token.
        // The first observed PID set defines this command's lifetime.
        missingPrimarySamples += 1;
        if (missingPrimarySamples >= 3) break;
      } else {
        missingPrimarySamples = 0;
      }
      sampleCount += 1;
      for (const row of rows) {
        pids.add(row.pid);
        maxCpuPct = Math.max(maxCpuPct, Number.isFinite(row.cpuPct) ? row.cpuPct : 0);
        maxRssKb = Math.max(maxRssKb, Number.isFinite(row.rssKb) ? row.rssKb : 0);
        append(runtimeDir, {
          type: 'process_sample',
          version: VERSION,
          id,
          category,
          at: Date.now(),
          pid: row.pid,
          ppid: row.ppid,
          cpuPct: row.cpuPct,
          rssKb: row.rssKb,
          elapsed: row.elapsed,
        });
      }
    } else if (seen) {
      missingSamples += 1;
      if (missingSamples >= 3) break;
    } else if (Date.now() - startedAt >= STARTUP_GRACE_MS) {
      break;
    }
    await sleep(SAMPLE_INTERVAL_MS);
  }

  append(runtimeDir, {
    type: 'observer_summary',
    version: VERSION,
    id,
    category,
    observerPid: process.pid,
    pids: [...pids].sort((a, b) => a - b),
    wallMs: Date.now() - startedAt,
    maxCpuPct,
    maxRssKb,
    sampleCount,
    seen,
    endedAt: Date.now(),
  });
}

main().catch(() => process.exitCode = 0);
