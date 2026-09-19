// bin/site-hook: gli hook della root eseguono gli script del sito dal
// worktree che segue origin/main, non dal checkout principale (che il
// 2026-09-19 era fermo da 9 giorni e girava ancora il filtro `claude[bot]`
// dello Stop hook ore dopo il merge di #9272).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const SITE_HOOK = join(ROOT, 'bin', 'site-hook');
const SITE_SCRIPTS = [
  'run-mutation-gate.mjs',
  'pr-body-write-gate.mjs',
  'pr-body-check-gate.mjs',
  'pr-watch-register.mjs',
  'pr-watch-gate.mjs',
];

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

for (const config of ['.claude/settings.json', '.codex/hooks.json']) {
  test(`${config} routes every site gate through bin/site-hook`, () => {
    const text = readFileSync(join(ROOT, config), 'utf8');
    const commands = [];
    const walk = (o) => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') {
        if (typeof o.command === 'string') commands.push(o.command);
        Object.values(o).forEach(walk);
      }
    };
    walk(JSON.parse(text));
    for (const name of SITE_SCRIPTS) {
      const hits = commands.filter((c) => c.includes(`scripts/ci/${name}`));
      assert.ok(hits.length > 0, `${name} assente da ${config}`);
      for (const c of hits) assert.match(c, /bin\/site-hook" scripts\/ci\//, `${name} non passa da site-hook in ${config}`);
    }
  });
}
