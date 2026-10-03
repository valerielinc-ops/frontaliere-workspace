// bin/workspace-autoupdate: ogni 15 minuti avanza il checkout root a
// origin/main e rilascia il coordinator se sono cambiati bin/ o config/.
// Qui si fissa che avanzi solo in fast-forward e senza toccare modifiche
// locali, che rilasci il coordinator solo quando serve e che un deploy
// rifiutato non fermi niente. Git e' vero, su repository temporanei; il
// release tool e' finto e registra le chiamate.
import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(import.meta.dirname, '..', 'bin', 'workspace-autoupdate');
const RELEASE = resolve(import.meta.dirname, '..', 'bin', 'github-coordinator-release');

const FAKE_RELEASE = `#!/bin/sh
echo "$*" >>"$FAKE_LOG"
exit "\${FAKE_DEPLOY_EXIT:-0}"
`;

let dir;
let env;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitOnOrigin(file, content) {
  const seed = join(dir, 'seed');
  git(seed, 'pull', '-q', 'origin', 'main');
  mkdirSync(join(seed, file, '..'), { recursive: true });
  writeFileSync(join(seed, file), content);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', `tocca ${file}`);
  git(seed, 'push', '-q', 'origin', 'main');
  return git(seed, 'rev-parse', 'HEAD');
}

function run(extraEnv = {}) {
  return spawnSync('/bin/bash', [SCRIPT, 'run'], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
}

// Una directory PATH con solo i comandi elencati: node non c'e' su nessuna
// piattaforma, come sotto un launch agent con il PATH di sistema.
function toolsWithout(names) {
  const tools = join(dir, 'tools');
  mkdirSync(tools, { recursive: true });
  for (const name of names) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).stdout.trim();
    assert.ok(found.startsWith('/'), `${name} non trovato nel PATH dei test`);
    symlinkSync(found, join(tools, name));
  }
  return tools;
}

const log = () => (existsSync(join(dir, 'logs', 'workspace-autoupdate.log')) ? readFileSync(join(dir, 'logs', 'workspace-autoupdate.log'), 'utf8') : '');
const deploys = () => (existsSync(join(dir, 'deploys')) ? readFileSync(join(dir, 'deploys'), 'utf8').trim().split('\n').filter(Boolean) : []);

describe('workspace-autoupdate', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-autoupdate-'));
    writeFileSync(join(dir, 'gitconfig'), '[user]\n\tname = test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
    env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      AU_WORKSPACE: join(dir, 'ws'),
      AU_LOG_DIR: join(dir, 'logs'),
      FRONTALIERE_GH_RELEASE_ROOT: join(dir, 'releases-root'),
      FAKE_LOG: join(dir, 'deploys'),
    };
    git(dir, 'init', '-q', '--bare', 'origin.git');
    git(dir, 'clone', '-q', join(dir, 'origin.git'), 'seed');
    const seed = join(dir, 'seed');
    mkdirSync(join(seed, 'bin'));
    writeFileSync(join(seed, 'bin', 'github-coordinator-release'), FAKE_RELEASE, { mode: 0o755 });
    writeFileSync(join(seed, 'README.md'), 'v1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'inizio');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(dir, 'clone', '-q', '-b', 'main', join(dir, 'origin.git'), 'ws');
    const first = git(seed, 'rev-parse', 'HEAD');
    mkdirSync(join(dir, 'releases-root', 'releases', first), { recursive: true });
    symlinkSync(`releases/${first}`, join(dir, 'releases-root', 'current'));
  });

  test('senza novita\' non tocca niente e non rilascia', () => {
    assert.equal(run().status, 0);
    assert.deepEqual(deploys(), []);
    assert.equal(log(), '');
  });

  test('una modifica fuori da bin/ e config/ avanza il checkout senza deploy', () => {
    const sha = commitOnOrigin('docs/nota.md', 'testo\n');
    assert.equal(run().status, 0);
    assert.equal(git(join(dir, 'ws'), 'rev-parse', 'HEAD'), sha);
    assert.deepEqual(deploys(), []);
    assert.match(log(), /checkout root \w{8} -> \w{8}/);
  });

  test('una modifica a bin/ rilascia il coordinator alla stessa commit', () => {
    const sha = commitOnOrigin('bin/strumento.mjs', 'export {};\n');
    assert.equal(run().status, 0);
    assert.deepEqual(deploys(), [`deploy --ref ${sha}`]);
    assert.match(log(), /coordinator \w{8} -> \w{8}/);
  });

  test('un deploy rifiutato resta nel log e si ritenta al giro dopo', () => {
    commitOnOrigin('config/routing.json', '{}\n');
    assert.equal(run({ FAKE_DEPLOY_EXIT: '1' }).status, 0);
    assert.match(log(), /deploy ritentato al prossimo giro/);
    assert.equal(run().status, 0);
    assert.equal(deploys().length, 2);
  });

  test('una modifica locale in conflitto ferma il checkout senza perderla', () => {
    writeFileSync(join(dir, 'ws', 'README.md'), 'locale\n');
    const before = git(join(dir, 'ws'), 'rev-parse', 'HEAD');
    commitOnOrigin('README.md', 'v2\n');
    assert.equal(run().status, 0);
    assert.equal(git(join(dir, 'ws'), 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(dir, 'ws', 'README.md'), 'utf8'), 'locale\n');
    assert.match(log(), /checkout root fermo a/);
  });

  test('fuori da main il checkout non avanza', () => {
    git(join(dir, 'ws'), 'switch', '-q', '-c', 'lavoro');
    const before = git(join(dir, 'ws'), 'rev-parse', 'HEAD');
    commitOnOrigin('docs/altro.md', 'x\n');
    assert.equal(run().status, 0);
    assert.equal(git(join(dir, 'ws'), 'rev-parse', 'HEAD'), before);
    assert.match(log(), /su 'lavoro': nessun avanzamento/);
  });

  test('install genera un plist valido con il workspace di questa macchina', () => {
    const agents = join(dir, 'agents');
    const r = spawnSync('/bin/bash', [SCRIPT, 'install'], { env: { ...env, AU_LAUNCH_AGENTS_DIR: agents, AU_NO_LAUNCHCTL: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(join(agents, 'ch.frontaliere.workspace-autoupdate.plist'), 'utf8');
    assert.match(plist, new RegExp(`<string>${join(dir, 'ws').replaceAll('/', '\\/')}/bin/workspace-autoupdate</string>`));
    assert.match(plist, /<integer>900<\/integer>/);
    assert.match(plist, /<string>Background<\/string>/);
  });

  // launchd non eredita il PATH della shell: col PATH fisso di sistema il
  // deploy del coordinator falliva a ogni giro con `node: command not found`.
  test('il plist generato porta la directory di node nel PATH', () => {
    const agents = join(dir, 'agents');
    const nodeDir = dirname(process.execPath);
    const r = spawnSync('/bin/bash', [SCRIPT, 'install'], {
      env: { ...env, PATH: `${nodeDir}:/usr/bin:/bin`, AU_LAUNCH_AGENTS_DIR: agents, AU_NO_LAUNCHCTL: '1' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(join(agents, 'ch.frontaliere.workspace-autoupdate.plist'), 'utf8');
    const path = plist.match(/<key>PATH<\/key><string>([^<]*)<\/string>/)?.[1] ?? '';
    const entries = path.split(':');
    assert.ok(entries.includes(nodeDir), `PATH del plist senza ${nodeDir}: ${path}`);
    assert.ok(entries.includes(join(dir, '.local', 'bin')), path);
    assert.equal(new Set(entries).size, entries.length, `PATH con duplicati: ${path}`);
  });

  test('install senza node nel PATH fallisce e non scrive il plist', () => {
    const agents = join(dir, 'agents');
    const r = spawnSync('/bin/bash', [SCRIPT, 'install'], {
      env: { ...env, PATH: toolsWithout([]), AU_LAUNCH_AGENTS_DIR: agents, AU_NO_LAUNCHCTL: '1' },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /node/);
    assert.equal(existsSync(join(agents, 'ch.frontaliere.workspace-autoupdate.plist')), false);
  });

  test('run con PATH senza node dichiara node assente', () => {
    // Il release tool vero, non quello finto: e' lui che deve dire la causa.
    const seed = join(dir, 'seed');
    copyFileSync(RELEASE, join(seed, 'bin', 'github-coordinator-release'));
    writeFileSync(join(seed, 'bin', 'github-coordinator.mjs'), 'export {};\n');
    mkdirSync(join(seed, 'config'));
    writeFileSync(join(seed, 'config', 'github-event-routing.json'), '{}\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'release vero');
    git(seed, 'push', '-q', 'origin', 'main');
    assert.equal(run({ PATH: toolsWithout(['git', 'dirname', 'basename', 'id', 'mkdir', 'rm', 'tar', 'date', 'mv', 'chmod']) }).status, 0);
    assert.match(log(), /node non nel PATH/);
    assert.doesNotMatch(log(), /sintassi non valida/);
  });
});
