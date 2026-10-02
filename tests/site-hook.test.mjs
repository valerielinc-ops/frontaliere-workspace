// bin/site-hook: gli hook della root eseguono gli script del sito dal
// worktree che segue origin/main, non dal checkout principale (che il
// 2026-09-19 era fermo da 9 giorni e girava ancora il filtro `claude[bot]`
// dello Stop hook ore dopo il merge di #9272).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { MANIFEST } from '../bin/hook-dispatch.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SITE_HOOK = join(ROOT, 'bin', 'site-hook');
// Gate del sito lanciati da bin/hook-dispatch.mjs (pre/post Bash): li risolve
// il suo `siteHook()`, con lo stesso ordine di bin/site-hook.
const DISPATCHED_SITE_SCRIPTS = [
  'run-mutation-gate.mjs',
  'pr-body-write-gate.mjs',
  'pr-body-check-gate.mjs',
  'pr-watch-register.mjs',
];
// Script del sito lanciati direttamente dalle configurazioni degli hook.
const CONFIG_SITE_SCRIPTS = [
  'scripts/ci/pr-watch-gate.mjs',
  // Il 2026-10-02 lo sweep dei worktree girava ancora dal checkout principale,
  // 7802 commit dietro origin/main: nessuna delle sue fix arrivava agli hook.
  'scripts/prune-merged-worktrees.mjs',
];

function hookCommands(config) {
  const commands = [];
  const walk = (o, event) => {
    if (Array.isArray(o)) o.forEach((x) => walk(x, event));
    else if (o && typeof o === 'object') {
      if (typeof o.command === 'string') commands.push({ event, command: o.command });
      for (const [key, value] of Object.entries(o)) walk(value, event ?? (key === 'hooks' ? undefined : key));
    }
  };
  walk(JSON.parse(readFileSync(join(ROOT, config), 'utf8')).hooks);
  return commands;
}

function fixture() {
  const ws = mkdtempSync(join(tmpdir(), 'site-hook-'));
  const site = join(ws, 'frontaliere-si-o-no');
  const hooks = join(ws, 'hooks-main');
  for (const base of [site, hooks]) mkdirSync(join(base, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(ws, 'bin'));
  // refresh finto: il test non deve fare fetch ne' creare worktree.
  writeFileSync(join(ws, 'bin', 'site-hooks-refresh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const script = (base, tag) => writeFileSync(
    join(base, 'scripts', 'ci', 'probe.mjs'),
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('${tag}:'+s.trim());process.exit(3)});`,
  );
  return { ws, site, hooks, script };
}

function run(ws, hooks, rel, input) {
  return spawnSync('sh', [SITE_HOOK, rel], {
    input,
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE: ws, FRONTALIERE_SITE_HOOKS_DIR: hooks },
  });
}

test('prefers the origin/main worktree and passes stdin and exit code through', () => {
  const { ws, site, hooks, script } = fixture();
  try {
    script(site, 'stale');
    script(hooks, 'main');
    const r = run(ws, hooks, 'scripts/ci/probe.mjs', '{"x":1}');
    assert.equal(r.stdout.trim(), 'main:{"x":1}');
    assert.equal(r.status, 3);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('falls back to the main checkout when the worktree does not exist yet', () => {
  const { ws, site, hooks, script } = fixture();
  try {
    script(site, 'stale');
    rmSync(hooks, { recursive: true, force: true });
    const r = run(ws, hooks, 'scripts/ci/probe.mjs', 'in');
    assert.equal(r.stdout.trim(), 'stale:in');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('fails open when the script exists nowhere', () => {
  const { ws, hooks } = fixture();
  try {
    const r = run(ws, hooks, 'scripts/ci/missing.mjs', '');
    assert.equal(r.status, 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('hook-dispatch resolves every site gate like bin/site-hook', () => {
  const entries = [...MANIFEST['pre-bash'], ...MANIFEST['post-bash']];
  for (const name of DISPATCHED_SITE_SCRIPTS) {
    const entry = entries.find((e) => e.name === name.replace(/\.mjs$/, ''));
    assert.ok(entry, `${name} assente dal MANIFEST di hook-dispatch`);
    assert.equal(entry.resolve.site, true, `${name} non passa da siteHook()`);
  }
});

for (const config of ['.claude/settings.json', '.codex/hooks.json']) {
  test(`${config} routes every site script through bin/site-hook`, () => {
    const commands = hookCommands(config).map((c) => c.command);
    for (const rel of CONFIG_SITE_SCRIPTS) {
      const hits = commands.filter((c) => c.includes(rel));
      assert.ok(hits.length > 0, `${rel} assente da ${config}`);
      for (const c of hits) assert.ok(c.includes(`bin/site-hook" ${rel}`), `${rel} non passa da site-hook in ${config}`);
    }
  });

  // Lo sweep gira nel sito e poi nel corpus (2026-10-02: nel corpus non c'era
  // nessuno sweep e si erano accumulati 45 worktree, 10,7 GiB). In sequenza,
  // non in parallelo, per non raddoppiare il carico; SessionStart non aspetta.
  for (const withCorpus of [true, false]) {
    test(`${config}: SessionStart prunes ${withCorpus ? 'site then corpus' : 'only the site without a corpus'} in background, SessionEnd only orphans`, async () => {
      const commands = hookCommands(config).filter((c) => c.command.includes('prune-merged-worktrees.mjs'));
      const start = commands.find((c) => c.event === 'SessionStart');
      const end = commands.find((c) => c.event === 'SessionEnd');
      assert.ok(start && end, `prune assente da SessionStart/SessionEnd in ${config}`);

      const ws = realpathSync(mkdtempSync(join(tmpdir(), 'prune-hook-')));
      try {
        const site = join(ws, 'frontaliere-si-o-no');
        const corpus = join(ws, 'frontaliere-articles');
        const hooks = join(ws, 'hooks-main');
        mkdirSync(join(ws, 'bin'));
        copyFileSync(SITE_HOOK, join(ws, 'bin', 'site-hook'));
        writeFileSync(join(ws, 'bin', 'site-hooks-refresh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        for (const base of [site, hooks]) mkdirSync(join(base, 'scripts'), { recursive: true });
        if (withCorpus) mkdirSync(join(corpus, '.git'), { recursive: true });
        const log = join(ws, 'calls.log');
        // Lo sweep finto dura piu' di quanto l'hook debba bloccare la sessione.
        const probe = (tag, delayMs) => `import { appendFileSync } from 'node:fs';
setTimeout(() => appendFileSync(${JSON.stringify(log)}, '${tag} ' + process.cwd() + ' ' + process.argv.slice(2).join(' ') + '\\n'), ${delayMs});`;
        writeFileSync(join(hooks, 'scripts', 'prune-merged-worktrees.mjs'), probe('main', 1500));
        writeFileSync(join(site, 'scripts', 'prune-merged-worktrees.mjs'), probe('stale', 0));
        writeFileSync(join(site, 'scripts', 'sync-main-checkout.mjs'), probe('sync', 0));
        const env = {
          ...process.env,
          WORKSPACE: ws,
          CLAUDE_PROJECT_DIR: ws,
          CODEX_PROJECT_DIR: ws,
          FRONTALIERE_SITE_HOOKS_DIR: hooks,
        };

        const expected = [`main ${site} --apply`, `sync ${site}`];
        if (withCorpus) expected.push(`main ${corpus} --apply`);
        const t0 = Date.now();
        const r = spawnSync('sh', ['-c', start.command], { env, encoding: 'utf8', timeout: 10_000 });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(Date.now() - t0 < 1200, `SessionStart ha aspettato lo sweep (${Date.now() - t0} ms)`);
        const done = () => existsSync(log) && readFileSync(log, 'utf8').trim().split('\n').length >= expected.length;
        for (let i = 0; i < 80 && !done(); i++) await sleep(100);
        if (!withCorpus) await sleep(300); // nessuna riga in piu' deve arrivare
        const lines = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => l.trimEnd());
        assert.deepEqual(lines(), expected);

        rmSync(log);
        const e = spawnSync('sh', ['-c', end.command], { env, encoding: 'utf8', timeout: 10_000 });
        assert.equal(e.status, 0, e.stderr);
        const endExpected = [`main ${site} --apply --orphans-only`];
        if (withCorpus) endExpected.push(`main ${corpus} --apply --orphans-only`);
        assert.deepEqual(lines(), endExpected);
      } finally { rmSync(ws, { recursive: true, force: true }); }
    });
  }
}
