// bin/hook-dispatch.mjs: gli hook Bash girano in worker thread di un solo
// processo invece che in un processo node ciascuno. Un errore qui spegne un
// gate di sicurezza senza segnali (il primo prototipo faceva uscire 0
// github-api-policy e pii-blocklist-policy), quindi il contratto e' la parita':
// per ogni hook e ogni comando, stesso codice d'uscita e stesso stderr che
// con un processo separato.
//
// Le fixture riproducono ogni modo in cui gli hook reali leggono l'input ed
// escono; il secondo blocco confronta gli hook reali del workspace e si salta
// dove il worktree hooks-main del sito non c'e' (CI del repo root).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MANIFEST, aggregate, refreshSiteHooksIfStale, resolveHooks, runHooks } from '../bin/hook-dispatch.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const FIXTURES = {
  // readFileSync(0) con import nominato, come github-api-policy.
  'fd0.mjs': `import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(0, 'utf8'));
if (p.tool_input.command.includes('BLOCK-FD0')) { process.stderr.write('fd0 bloccato\\n'); process.exit(2); }`,
  // /dev/stdin e default import.
  'devstdin.mjs': `import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync('/dev/stdin').toString());
if (p.tool_input.command.includes('BLOCK-DEV')) { console.error('devstdin bloccato'); process.exit(2); }`,
  // Guardia "se eseguito direttamente" su argv[1], come pii-blocklist-policy.
  'maincheck.mjs': `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = JSON.parse(readFileSync(0, 'utf8'));
  if (p.tool_input.command.includes('BLOCK-MAIN')) { process.stderr.write('main bloccato\\n'); process.exitCode = 2; }
}`,
  // process.stdin a eventi con Buffer.concat, come lib/hook-stdin.mjs.
  'stream.mjs': `const chunks = [];
process.stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
process.stdin.on('end', () => {
  const p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (p.tool_input.command.includes('BLOCK-STREAM')) { process.stderr.write('stream bloccato\\n'); process.exit(2); }
  if (p.tool_input.command.includes('CTX')) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'dallo stream' } }));
});`,
  // exitCode impostato dopo un await, come agent-resource-guard e pr-gate-cache.
  'async.mjs': `import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(0, 'utf8'));
await new Promise((r) => setTimeout(r, 20));
if (p.tool_input.command.includes('BLOCK-ASYNC')) { process.stderr.write('async bloccato\\n'); process.exitCode = 2; }
if (p.tool_input.command.includes('CTX')) process.stdout.write(JSON.stringify({ systemMessage: 'avviso', hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'da async' } }));`,
  // Advisory: esce 2 ma conta come `|| true`.
  'advisory.mjs': `process.stderr.write('solo un avviso\\n'); process.exit(2);`,
  'crash.mjs': `import { readFileSync } from 'node:fs';
if (readFileSync(0, 'utf8').includes('CRASH')) throw new Error('esploso');`,
  'hang.mjs': `setInterval(() => {}, 1000);`,
};

const COMMANDS = ['echo ok', 'BLOCK-FD0', 'BLOCK-DEV', 'BLOCK-MAIN', 'BLOCK-STREAM', 'BLOCK-ASYNC', 'CTX', 'CRASH'];

function payload(command, event = 'PreToolUse') {
  return JSON.stringify({ session_id: 'test-hook-dispatch', cwd: ROOT, hook_event_name: event, tool_name: 'Bash', tool_input: { command } });
}

// Lo stderr conta quando blocca (e' il messaggio che l'agente legge); per un
// crash il worker stampa lo stack senza la riga di sorgente che stampa node.
function summary(results) {
  return results.map((r) => `${r.hook.name}:${r.code}${r.code === 2 ? `:${r.stderr.trim()}` : ''}`);
}

describe('hook-dispatch con fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-dispatch-'));
  const hooks = Object.keys(FIXTURES).filter((f) => f !== 'hang.mjs').map((file) => {
    writeFileSync(join(dir, file), FIXTURES[file]);
    return { name: file.replace('.mjs', ''), script: join(dir, file), advisory: file === 'advisory.mjs' };
  });
  writeFileSync(join(dir, 'hang.mjs'), FIXTURES['hang.mjs']);

  for (const command of COMMANDS) {
    test(`stesso esito per hook in worker e in processi separati: ${command}`, async () => {
      const inWorkers = await runHooks(hooks, payload(command));
      const inProcesses = await runHooks(hooks, payload(command), process.env, { processes: true });
      assert.deepEqual(summary(inWorkers), summary(inProcesses));
      assert.deepEqual(aggregate(inWorkers).code, aggregate(inProcesses).code);
    });
  }

  test('un blocco produce exit 2 con lo stderr di chi ha bloccato', async () => {
    const result = aggregate(await runHooks(hooks, payload('BLOCK-FD0 BLOCK-ASYNC')));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /fd0 bloccato/);
    assert.match(result.stderr, /async bloccato/);
    assert.doesNotMatch(result.stderr, /solo un avviso/, 'l\'advisory non blocca');
  });

  test('gli output JSON di piu\' hook si uniscono', async () => {
    const result = aggregate(await runHooks(hooks, payload('CTX')));
    assert.equal(result.code, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.systemMessage, 'avviso');
    assert.match(out.hookSpecificOutput.additionalContext, /dallo stream/);
    assert.match(out.hookSpecificOutput.additionalContext, /da async/);
  });

  test('un hook che non termina scade come errore non bloccante', async () => {
    const [result] = await runHooks([{ name: 'hang', script: join(dir, 'hang.mjs'), timeoutMs: 300 }], payload('echo ok'));
    assert.equal(result.timedOut, true);
    assert.equal(aggregate([result]).code, 1);
  });

  test('aggregate: deny vince su allow e il primo output solo passa invariato', () => {
    const hook = (name) => ({ name });
    const merged = aggregate([
      { hook: hook('a'), code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }), stderr: '' },
      { hook: hook('b'), code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }), stderr: '' },
    ]);
    assert.equal(JSON.parse(merged.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const single = aggregate([{ hook: hook('a'), code: 0, stdout: 'testo libero\n', stderr: '' }]);
    assert.equal(single.stdout, 'testo libero\n');
  });

  test.after(() => rmSync(dir, { recursive: true, force: true }));
});

describe('hook-dispatch con gli hook reali del workspace', () => {
  const hooksMain = join(ROOT, 'frontaliere-si-o-no', '.claude', 'worktrees', 'hooks-main');
  const workspace = existsSync(hooksMain) ? ROOT : resolve(ROOT, '..', '..', '..');
  const available = existsSync(join(workspace, 'frontaliere-si-o-no', '.claude', 'worktrees', 'hooks-main'));
  const runtime = mkdtempSync(join(tmpdir(), 'hook-dispatch-runtime-'));
  const env = {
    ...process.env,
    WORKSPACE: workspace,
    CLAUDE_PROJECT_DIR: workspace,
    FRONTALIERE_AGENT_RUNTIME_DIR: runtime,
    FRONTALIERE_RESOURCE_QUEUE_MS: '0',
  };
  const context = { env, cwd: workspace };
  const pii = ['.git', 'info', 'pii-blocklist.txt'].join('/');
  const LIVE = [
    ['echo hi', []],
    ['curl -s https://api.github.com/repos/x/y', ['github-api-policy']],
    [`grep -f ${pii} README.md`, ['pii-blocklist-policy']],
    ['gh run cancel 12345 --repo valerielinc-ops/frontaliere-si-o-no', ['run-mutation-gate']],
    // Il guard blocca con process.exitCode = 2, non con process.exit.
    ["git log --all -S'Rewarded service VAST' --oneline", ['agent-resource-guard']],
    ['gh pr create --repo valerielinc-ops/frontaliere-workspace --base main --head x --title t --body "solo testo"', ['pr-body-check-gate']],
  ];

  for (const [command, expectedBlockers] of LIVE) {
    test(`hook reali, stessa decisione: ${command.slice(0, 40)}`, { skip: !available && 'worktree hooks-main assente' }, async () => {
      const hooks = resolveHooks(MANIFEST['pre-bash'], context);
      assert.ok(hooks.length >= 6, `risolti ${hooks.map((h) => h.name).join(',')}`);
      const inWorkers = await runHooks(hooks, payload(command), env);
      const inProcesses = await runHooks(hooks, payload(command), env, { processes: true });
      const codes = (rs) => rs.map((r) => `${r.hook.name}:${r.hook.advisory ? 0 : r.code}`);
      assert.deepEqual(codes(inWorkers), codes(inProcesses));
      const blockers = inWorkers.filter((r) => !r.hook.advisory && r.code === 2).map((r) => r.hook.name);
      assert.deepEqual(blockers, expectedBlockers);
      for (const r of inWorkers.filter((x) => x.code === 2)) {
        const twin = inProcesses.find((x) => x.hook.name === r.hook.name);
        assert.equal(r.stderr.trim(), twin.stderr.trim(), `stderr di ${r.hook.name}`);
      }
    });
  }

  test('hook reali PostToolUse, stesso esito', { skip: !available && 'worktree hooks-main assente' }, async () => {
    const hooks = resolveHooks(MANIFEST['post-bash'], context);
    assert.deepEqual(hooks.map((h) => h.name), ['agent-resource-guard', 'pr-watch-register']);
    const post = payload('echo hi', 'PostToolUse');
    const codes = (rs) => rs.map((r) => `${r.hook.name}:${r.code}`);
    assert.deepEqual(codes(await runHooks(hooks, post, env)), codes(await runHooks(hooks, post, env, { processes: true })));
  });

  test('il refresh degli hook del sito non riparte con lo stamp fresco', { skip: !available && 'worktree hooks-main assente' }, () => {
    let spawned = 0;
    const fakeSpawn = () => { spawned += 1; return { unref() {} }; };
    refreshSiteHooksIfStale(context, fakeSpawn);
    refreshSiteHooksIfStale(context, fakeSpawn);
    assert.ok(spawned <= 1, `refresh avviati: ${spawned}`);
  });

  test.after(() => rmSync(runtime, { recursive: true, force: true }));
});
