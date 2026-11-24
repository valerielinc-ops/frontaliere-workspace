import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REFRESH = join(ROOT, 'bin', 'site-hooks-refresh');

function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Workspace usa-e-getta: bare "origin", clone del sito, bin/site-hooks-refresh.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'site-hooks-refresh-'));
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = fixture\n\temail = fixture@example.invalid\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.FRONTALIERE_SITE_HOOKS_DIR;
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  git(root, ['init', '-q', '--bare', '--initial-branch', 'main', origin], env);
  git(root, ['clone', '-q', origin, seed], env);
  mkdirSync(join(seed, 'scripts'));
  writeFileSync(join(seed, 'scripts', 'hook.mjs'), 'export const version = 1;\n');
  writeFileSync(join(seed, 'package.json'), '{}\n');
  mkdirSync(join(seed, '.githooks'));
  writeFileSync(join(seed, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  mkdirSync(join(seed, 'data'));
  writeFileSync(join(seed, 'data', 'big.json'), '{}\n');
  git(seed, ['add', '.'], env);
  git(seed, ['commit', '-q', '-m', 'v1'], env);
  git(seed, ['push', '-q', 'origin', 'HEAD:main'], env);
  const ws = join(root, 'ws');
  mkdirSync(join(ws, 'bin'), { recursive: true });
  copyFileSync(REFRESH, join(ws, 'bin', 'site-hooks-refresh'));
  git(ws, ['clone', '-q', origin, join(ws, 'frontaliere-si-o-no')], env);
  return { root, ws, seed, env };
}

function refresh(fx) {
  return spawnSync('/bin/sh', [join(fx.ws, 'bin', 'site-hooks-refresh'), '--force'], {
    cwd: fx.ws, env: { ...fx.env, WORKSPACE: fx.ws }, encoding: 'utf8',
  });
}

test('hooks-main con una modifica locale viene riallineato e il diff salvato', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const site = join(fx.ws, 'frontaliere-si-o-no');
  const wt = join(site, '.claude', 'worktrees', 'hooks-main');

  assert.equal(refresh(fx).status, 0);
  assert.equal(readFileSync(join(wt, 'scripts', 'hook.mjs'), 'utf8'), 'export const version = 1;\n');

  // Un agente corregge lo script dentro hooks-main; la stessa riga cambia su main.
  writeFileSync(join(wt, 'scripts', 'hook.mjs'), 'export const version = 1; // patch locale\n');
  writeFileSync(join(fx.seed, 'scripts', 'hook.mjs'), 'export const version = 2;\n');
  git(fx.seed, ['commit', '-q', '-am', 'v2'], fx.env);
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main'], fx.env);

  const result = refresh(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(wt, 'scripts', 'hook.mjs'), 'utf8'), 'export const version = 2;\n', 'hooks-main segue origin/main');
  assert.match(result.stderr, /hooks-main aveva modifiche locali, salvate in /);
  const gitdir = git(site, ['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.env);
  const patches = readdirSync(gitdir).filter((name) => name.startsWith('hooks-main-dirty-') && name.endsWith('.patch'));
  assert.equal(patches.length, 1);
  assert.match(readFileSync(join(gitdir, patches[0]), 'utf8'), /\+export const version = 1; \/\/ patch locale/);
});

test('hooks-main pulito: nessun file di patch', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const site = join(fx.ws, 'frontaliere-si-o-no');
  assert.equal(refresh(fx).status, 0);
  writeFileSync(join(fx.seed, 'scripts', 'hook.mjs'), 'export const version = 3;\n');
  git(fx.seed, ['commit', '-q', '-am', 'v3'], fx.env);
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main'], fx.env);
  const result = refresh(fx);
  assert.equal(result.status, 0, result.stderr);
  const gitdir = git(site, ['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.env);
  assert.equal(readdirSync(gitdir).some((name) => name.startsWith('hooks-main-dirty-')), false);
  assert.equal(existsSync(join(site, '.claude', 'worktrees', 'hooks-main', 'scripts', 'hook.mjs')), true);
});

test('hooks-main materializza .githooks/ e riallinea un set sparse precedente', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const site = join(fx.ws, 'frontaliere-si-o-no');
  const wt = join(site, '.claude', 'worktrees', 'hooks-main');
  assert.equal(refresh(fx).status, 0);
  assert.equal(existsSync(join(wt, '.githooks', 'pre-push')), true, 'hooks-main nuovo contiene .githooks/');
  assert.equal(existsSync(join(wt, 'data', 'big.json')), false, 'il resto del repo resta fuori');

  // hooks-main nato col set di prima (solo scripts/ e package.json).
  execFileSync('git', ['-C', wt, 'sparse-checkout', 'set', '--no-cone', '/scripts/', '/package.json'], { env: fx.env, stdio: 'ignore' });
  assert.equal(existsSync(join(wt, '.githooks', 'pre-push')), false);
  const result = refresh(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(wt, '.githooks', 'pre-push')), true, 'il set precedente viene riallineato');
  assert.equal(existsSync(join(wt, 'data', 'big.json')), false);
});
