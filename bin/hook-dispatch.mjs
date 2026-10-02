#!/usr/bin/env node
/**
 * Un solo processo node per gli hook Bash di Claude Code e Codex.
 *
 * Prima ogni comando Bash di un agente avviava 8 hook PreToolUse e 2
 * PostToolUse, ciascuno nel proprio processo node (con `sh -c` e, per gli
 * script del sito, `bin/site-hook` + `bin/site-hooks-refresh`): circa 30
 * processi per comando. Sul Mac host agenti (2 core, 2026-10-02) un node vuoto
 * impiega ~330 ms ad avviarsi, cioe' ~3 s di CPU per comando e ~16.500
 * comandi al giorno. Qui gli stessi script girano invariati, uno per worker
 * thread, nello stesso processo.
 *
 * Gli hook non sanno di girare in un worker. Il bootstrap del worker:
 * - risponde a readFileSync(0) e readFileSync('/dev/stdin') con il payload e
 *   sincronizza gli export ESM dei builtin, cosi' vale anche per
 *   `import { readFileSync } from 'node:fs'`;
 * - sostituisce process.stdin con uno stream che contiene il payload;
 * - imposta process.argv[1] sullo script: le guardie "se eseguito
 *   direttamente" lo confrontano con import.meta.url (senza, due gate di
 *   sicurezza uscivano 0 in silenzio).
 * process.exit() e process.exitCode chiudono il worker con quel codice.
 *
 * Esito aggregato come Claude Code combina hook paralleli: un exit 2 di un
 * hook non advisory blocca con lo stderr di chi ha bloccato; altrimenti gli
 * stdout JSON vengono uniti. Se il dispatcher stesso fallisce, gli stessi
 * hook girano come processi separati (mai un gate saltato per un bug qui).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_MS = 60_000;
const REFRESH_STAMP_MAX_AGE_MS = 15 * 60 * 1000;

const WORKER_BOOTSTRAP = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const payload = Buffer.from(workerData.payload);
const readFileSync = fs.readFileSync;
fs.readFileSync = function patchedReadFileSync(file, ...rest) {
  if (file === 0 || file === '/dev/stdin') {
    const options = rest[0];
    const encoding = typeof options === 'string' ? options : options && options.encoding;
    return encoding ? payload.toString(encoding) : Buffer.from(payload);
  }
  return readFileSync.call(this, file, ...rest);
};
require('node:module').syncBuiltinESMExports();
process.argv[1] = workerData.script;
const { Readable } = require('node:stream');
Object.defineProperty(process, 'stdin', {
  configurable: true,
  value: Readable.from([Buffer.from(payload)], { objectMode: false }),
});
import(require('node:url').pathToFileURL(workerData.script).href);
`;

function envBase(env, cwd, { withCodex = true } = {}) {
  return env.WORKSPACE || (withCodex && env.CODEX_PROJECT_DIR) || env.CLAUDE_PROJECT_DIR || cwd;
}

function fileIn(dir, rel) {
  const candidate = path.join(dir, rel);
  return existsSync(candidate) ? candidate : undefined;
}

// `[ -f "$d/<rel>" ] || d="$d/.."`
function workspaceOrParent(rel) {
  return ({ env, cwd }) => {
    const base = envBase(env, cwd);
    return fileIn(base, rel) ?? fileIn(path.resolve(base, '..'), rel);
  };
}

// `[ -f "$d/<rel>" ] || exit 0`
function workspaceOnly(rel) {
  return ({ env, cwd }) => fileIn(envBase(env, cwd), rel);
}

// Come github-api-policy: risale dalla cartella corrente, poi dagli env.
function findUp(rel) {
  return ({ env, cwd }) => {
    for (const start of [cwd, env.WORKSPACE, env.CODEX_PROJECT_DIR, env.CLAUDE_PROJECT_DIR]) {
      if (!start) continue;
      let dir = path.resolve(start);
      for (;;) {
        const found = fileIn(dir, rel);
        if (found) return found;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return undefined;
  };
}

// `[ -f "$d/<rel>" ] || d="$d/frontaliere-si-o-no"`
function workspaceOrSite(rel) {
  return ({ env, cwd }) => {
    const base = envBase(env, cwd);
    return fileIn(base, rel) ?? fileIn(path.join(base, 'frontaliere-si-o-no'), rel);
  };
}

function siteLayout({ env, cwd }) {
  let w = envBase(env, cwd);
  if (!existsSync(path.join(w, 'bin', 'site-hook'))) w = path.resolve(w, '..');
  if (!existsSync(path.join(w, 'bin', 'site-hook'))) return undefined;
  let ws = env.WORKSPACE;
  if (!ws || !existsSync(path.join(ws, 'frontaliere-si-o-no'))) ws = w;
  const site = path.join(ws, 'frontaliere-si-o-no');
  const hooksDir = env.FRONTALIERE_SITE_HOOKS_DIR || path.join(site, '.claude', 'worktrees', 'hooks-main');
  return { ws, site, hooksDir };
}

// Come bin/site-hook: prima il worktree hooks-main, poi il checkout del sito.
function siteHook(rel) {
  const resolve = (context) => {
    const layout = siteLayout(context);
    if (!layout) return undefined;
    return fileIn(layout.hooksDir, rel) ?? fileIn(layout.site, rel);
  };
  resolve.site = true;
  return resolve;
}

export const MANIFEST = {
  'pre-bash': [
    { name: 'github-api-policy', resolve: findUp('bin/github-api-policy.mjs') },
    { name: 'pii-blocklist-policy', resolve: workspaceOrParent('bin/pii-blocklist-policy.mjs') },
    { name: 'agent-resource-guard', resolve: workspaceOrParent('bin/agent-resource-guard.mjs'), args: ['--pre'], timeoutMs: 360_000 },
    { name: 'run-mutation-gate', resolve: siteHook('scripts/ci/run-mutation-gate.mjs') },
    { name: 'pr-body-write-gate', resolve: siteHook('scripts/ci/pr-body-write-gate.mjs') },
    { name: 'pr-gate-cache', resolve: workspaceOnly('bin/pr-gate-cache.mjs') },
    { name: 'pr-body-check-gate', resolve: siteHook('scripts/ci/pr-body-check-gate.mjs') },
    { name: 'pr-collision-precheck', resolve: workspaceOrSite('scripts/ci/pr-collision-precheck.mjs'), advisory: true, timeoutMs: 25_000 },
  ],
  'post-bash': [
    { name: 'agent-resource-guard', resolve: workspaceOrParent('bin/agent-resource-guard.mjs'), args: ['--post'] },
    { name: 'pr-watch-register', resolve: siteHook('scripts/ci/pr-watch-register.mjs') },
  ],
};

/** Gli hook dell'evento con lo script risolto; quelli senza script si saltano, come prima. */
export function resolveHooks(hooks, context) {
  return hooks.flatMap((hook) => {
    const script = hook.resolve(context);
    return script ? [{ ...hook, script, site: Boolean(hook.resolve.site) }] : [];
  });
}

/**
 * bin/site-hook lanciava site-hooks-refresh in background a ogni hook del sito
 * (5 volte per comando), e lo script faceva `git rev-parse` prima di guardare
 * lo stamp. Qui lo stamp si legge una volta e il refresh parte solo se serve.
 */
export function refreshSiteHooksIfStale(context, spawnFn = spawn) {
  const layout = siteLayout(context);
  if (!layout) return false;
  const gitDir = path.join(layout.site, '.git');
  try {
    if (statSync(gitDir).isDirectory()
      && existsSync(path.join(layout.hooksDir, '.git'))
      && Date.now() - statSync(path.join(gitDir, 'hooks-main.stamp')).mtimeMs < REFRESH_STAMP_MAX_AGE_MS) {
      return false;
    }
  } catch {
    // stamp assente o sito non standard: lascia decidere allo script
  }
  const script = path.join(layout.ws, 'bin', 'site-hooks-refresh');
  if (!existsSync(script)) return false;
  try {
    spawnFn('/bin/sh', [script], { detached: true, stdio: 'ignore', env: context.env }).unref();
    return true;
  } catch {
    return false;
  }
}

function runInWorker(hook, payload, env) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      argv: hook.args ?? [],
      workerData: { script: hook.script, payload },
      env,
      stdout: true,
      stderr: true,
    });
    worker.stdout.on('data', (chunk) => stdout.push(chunk));
    worker.stderr.on('data', (chunk) => stderr.push(chunk));
    worker.on('error', (error) => stderr.push(Buffer.from(`${error?.stack ?? error}\n`)));
    const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      stderr.push(Buffer.from(`${hook.name}: timeout dopo ${Math.round(timeoutMs / 1000)}s\n`));
      worker.terminate();
    }, timeoutMs);
    // L'output puo' arrivare dopo 'exit': si chiude solo quando anche stdout e
    // stderr sono finiti (con un limite, se un flusso non si chiudesse mai).
    let exitCode;
    let open = 2;
    const finish = () => {
      if (settled || exitCode === undefined || (open > 0 && !finish.forced)) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        hook,
        code: timedOut ? 1 : exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    };
    for (const stream of [worker.stdout, worker.stderr]) stream.once('end', () => { open -= 1; finish(); });
    worker.on('exit', (code) => {
      exitCode = code;
      finish();
      setTimeout(() => { finish.forced = true; finish(); }, 1000).unref();
    });
  });
}

function runInProcess(hook, payload, env) {
  const result = spawnSync(process.execPath, [hook.script, ...(hook.args ?? [])], {
    input: payload,
    env,
    encoding: 'utf8',
    timeout: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    hook,
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? `${hook.name}: ${result.error.message}\n` : ''}`,
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

export async function runHooks(hooks, payload, env = process.env, options = {}) {
  if (options.processes) return hooks.map((hook) => runInProcess(hook, payload, env));
  return Promise.all(hooks.map((hook) => runInWorker(hook, payload, env)));
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const DECISION_RANK = { deny: 3, ask: 2, allow: 1 };

function mergeJson(objects) {
  const merged = {};
  const join = (key, values, separator) => {
    const kept = values.filter((v) => typeof v === 'string' && v.length);
    if (kept.length) merged[key] = kept.join(separator);
  };
  if (objects.some((o) => o.continue === false)) merged.continue = false;
  join('stopReason', objects.map((o) => o.stopReason), '\n');
  if (objects.some((o) => o.suppressOutput === true)) merged.suppressOutput = true;
  join('systemMessage', objects.map((o) => o.systemMessage), '\n');
  const blocks = objects.filter((o) => o.decision === 'block');
  if (blocks.length) {
    merged.decision = 'block';
    join('reason', blocks.map((o) => o.reason), '\n');
  }
  const specific = objects.map((o) => o.hookSpecificOutput).filter((o) => o && typeof o === 'object');
  if (specific.length) {
    const out = { hookEventName: specific.find((o) => o.hookEventName)?.hookEventName };
    const decisions = specific.filter((o) => DECISION_RANK[o.permissionDecision]);
    if (decisions.length) {
      const strongest = decisions.reduce((a, b) => (DECISION_RANK[b.permissionDecision] > DECISION_RANK[a.permissionDecision] ? b : a));
      out.permissionDecision = strongest.permissionDecision;
      const reasons = decisions.filter((o) => o.permissionDecision === strongest.permissionDecision)
        .map((o) => o.permissionDecisionReason).filter(Boolean);
      if (reasons.length) out.permissionDecisionReason = reasons.join('\n');
    }
    const contexts = specific.map((o) => o.additionalContext).filter((v) => typeof v === 'string' && v.length);
    if (contexts.length) out.additionalContext = contexts.join('\n\n');
    const updated = specific.find((o) => o.updatedInput);
    if (updated) out.updatedInput = updated.updatedInput;
    merged.hookSpecificOutput = out;
  }
  return merged;
}

/**
 * Esito unico: { code, stdout, stderr }. Gli hook advisory valgono come
 * `node ... || true`: il loro codice e' sempre 0, l'output resta.
 */
export function aggregate(results) {
  const normalized = results.map((r) => ({ ...r, code: r.hook.advisory ? 0 : r.code }));
  const stderrOf = (list) => list.map((r) => r.stderr.trimEnd()).filter(Boolean).join('\n\n');
  const blocking = normalized.filter((r) => r.code === 2);
  if (blocking.length) return { code: 2, stdout: '', stderr: `${stderrOf(blocking)}\n` };

  const errors = normalized.filter((r) => r.code !== 0);
  const withOutput = normalized.filter((r) => r.stdout.trim());
  const allStderr = stderrOf(normalized);
  if (withOutput.length === 1 && !errors.length) {
    return { code: 0, stdout: withOutput[0].stdout, stderr: allStderr ? `${allStderr}\n` : '' };
  }
  const objects = [];
  const texts = [];
  for (const r of withOutput) {
    const parsed = parseObject(r.stdout.trim());
    if (parsed) objects.push(parsed);
    else texts.push(r.stdout.trimEnd());
  }
  const errorText = errors.map((r) => `${r.hook.name}: ${r.stderr.trim() || `exit ${r.code}`}`).join('\n');
  if (!objects.length) {
    return {
      code: errors.length ? 1 : 0,
      stdout: texts.length ? `${texts.join('\n')}\n` : '',
      stderr: errors.length ? `${errorText}\n` : (allStderr ? `${allStderr}\n` : ''),
    };
  }
  const merged = mergeJson(objects);
  if (errors.length) merged.systemMessage = [merged.systemMessage, `hook in errore: ${errorText}`].filter(Boolean).join('\n');
  const stderr = [allStderr, ...texts].filter(Boolean).join('\n');
  return { code: 0, stdout: `${JSON.stringify(merged)}\n`, stderr: stderr ? `${stderr}\n` : '' };
}

export async function dispatch(event, payload, context, options = {}) {
  const hooks = resolveHooks(MANIFEST[event] ?? [], context);
  if (hooks.some((hook) => hook.site)) refreshSiteHooksIfStale(context, options.spawn);
  try {
    return aggregate(await runHooks(hooks, payload, context.env, options));
  } catch (error) {
    // Un bug del dispatcher non deve spegnere i gate: stessi hook, processi separati.
    const fallback = aggregate(await runHooks(hooks, payload, context.env, { processes: true }));
    return { ...fallback, stderr: `hook-dispatch: fallback a processi separati (${error?.message ?? error})\n${fallback.stderr}` };
  }
}

async function main() {
  const event = process.argv[2];
  if (!MANIFEST[event]) {
    process.stderr.write(`uso: hook-dispatch.mjs ${Object.keys(MANIFEST).join('|')}\n`);
    return 0;
  }
  const payload = readFileSync(0, 'utf8');
  const result = await dispatch(event, payload, { env: process.env, cwd: process.cwd() });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`hook-dispatch: ${error?.stack ?? error}\n`);
    process.exitCode = 0;
  });
}
