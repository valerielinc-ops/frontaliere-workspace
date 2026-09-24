import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireHeavyLease,
  classifyCommand,
  cleanupRuntime,
  guardPost,
  guardPre,
  invocationId,
  parsePayload,
  pressureDecision,
  redactCommand,
  runtimeDirectory,
} from './agent-resource-guard.mjs';

test('classifica la ricerca Git senza limite come job pesante non delimitato', () => {
  const result = classifyCommand("git log --all -S'Rewarded service VAST' --oneline");
  assert.equal(result.kind, 'git-history');
  assert.equal(result.heavy, true);
  assert.equal(result.unbounded, true);
});

test('un git grep mirato resta serializzato ma non viene rifiutato come full scan', () => {
  const result = classifyCommand('git grep -n Rewarded -- scripts/ci/check-sibling-patterns.mjs');
  assert.equal(result.kind, 'git-history');
  assert.equal(result.heavy, true);
  assert.equal(result.unbounded, false);
});

test('classifica il typecheck diretto e riconosce il wrapper incrementale', () => {
  assert.equal(classifyCommand('npm exec tsc -- --noEmit').unbounded, true);
  assert.equal(classifyCommand('tsc --noEmit --incremental').unbounded, false);
  assert.equal(classifyCommand('node "$WORKSPACE/bin/codex-typecheck.mjs" --changed').heavy, false);
});

test('la pressione memoria blocca sotto la soglia e lascia passare sopra', () => {
  assert.equal(pressureDecision({ freePercent: 7, swapUsedBytes: 1, swapTotalBytes: 10 }).blocked, true);
  assert.equal(pressureDecision({ freePercent: 20, swapUsedBytes: 1, swapTotalBytes: 10 }).blocked, false);
  assert.equal(pressureDecision({ freePercent: 20, swapUsedBytes: 9, swapTotalBytes: 10 }).blocked, true);
});

test('il lease atomico ammette un solo job pesante', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  try {
    const first = { id: 'first', category: 'typecheck', startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const second = { id: 'second', category: 'git-history', startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    assert.equal(acquireHeavyLease(runtime, first).acquired, true);
    const blocked = acquireHeavyLease(runtime, second);
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.current.id, 'first');
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('cleanup senza sessione non libera il lease di un altro agente', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  try {
    const lease = { id: 'other', sessionId: 'other-session', category: 'build', startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    assert.equal(acquireHeavyLease(runtime, lease).acquired, true);
    cleanupRuntime(runtime);
    assert.equal(acquireHeavyLease(runtime, { id: 'local', sessionId: 'local-session', category: 'test', startedAt: Date.now(), expiresAt: Date.now() + 60_000 }).acquired, false);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('un post senza pre pendente non libera un lease ancora attivo', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  const previous = process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
  process.env.FRONTALIERE_AGENT_RUNTIME_DIR = runtime;
  try {
    const info = { payload: {}, command: 'npm run typecheck', cwd: process.cwd(), sessionId: 'same-session', toolCallId: '' };
    const lease = {
      id: invocationId(info),
      sessionId: info.sessionId,
      category: 'typecheck',
      commandHash: 'not-used-by-the-guard-without-pending',
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    assert.equal(acquireHeavyLease(runtime, lease).acquired, true);
    guardPost(info, process.cwd());
    assert.equal(acquireHeavyLease(runtime, { ...lease, id: 'next' }).acquired, false);
  } finally {
    if (previous === undefined) delete process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
    else process.env.FRONTALIERE_AGENT_RUNTIME_DIR = previous;
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('telemetria e redazione usano lo stesso id tra pre e post', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-guard-test-'));
  const previous = process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
  const previousWorkspace = process.env.WORKSPACE;
  process.env.FRONTALIERE_AGENT_RUNTIME_DIR = runtime;
  process.env.WORKSPACE = path.resolve('.');
  try {
    const raw = JSON.stringify({
      session_id: 'test-session',
      cwd: process.cwd(),
      tool_input: { command: 'printf ok' },
    });
    const info = parsePayload(raw);
    const pre = guardPre(info, process.cwd());
    assert.equal(pre.allowed, true);
    guardPost({ ...info, payload: { ...info.payload, tool_response: { exit_code: 0 } } }, process.cwd());
    const lines = readFileSync(path.join(runtime, 'commands.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.filter((line) => line.type === 'command_start').length, 1);
    assert.equal(lines.filter((line) => line.type === 'command_end').length, 1);
    assert.match(redactCommand('gh --token github_pat_1234567890'), /<redacted>/);
  } finally {
    if (previous === undefined) delete process.env.FRONTALIERE_AGENT_RUNTIME_DIR;
    else process.env.FRONTALIERE_AGENT_RUNTIME_DIR = previous;
    if (previousWorkspace === undefined) delete process.env.WORKSPACE;
    else process.env.WORKSPACE = previousWorkspace;
    rmSync(runtime, { recursive: true, force: true });
  }
});
