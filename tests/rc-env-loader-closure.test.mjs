import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  INCOMPLETE_EXIT_CODE,
  inspectLoaderClosure,
  relativeSpecifiersIn,
} from '../bin/rc-loader-closure.mjs';

// Il checkout principale del corpus e' sparse e il suo elenco si allunga a
// mano. Due volte un file del loader di Remote Config e' rimasto fuori dal
// disco (il loader stesso il 2026-09-17, un modulo che importa il 2026-10-08)
// e due volte rc-env.sh l'ha raccontato come un problema di auth.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RC_ENV = join(ROOT, 'bin', 'rc-env.sh');
const CLOSURE = join(ROOT, 'bin', 'rc-loader-closure.mjs');
const GH_NANAKO = join(ROOT, 'bin', 'gh-nanako');

const LOADER = 'generator/scripts/load-rc-env.mjs';
const GUARD = 'generator/scripts/lib/guard.mjs';
const SHARED = 'generator/scripts/lib/deep/shared.mjs';
const TOKEN = 'generator/scripts/lib/token.mjs';

// Come il loader vero: un import statico, uno dinamico, gli export su stdout e
// lo stato su stderr.
const LOADER_SOURCE = `import { MODE } from './lib/guard.mjs';

if (process.env.FAKE_LOADER_CRASH === '1') throw new SyntaxError('loader rotto di proposito');
if (process.env.FAKE_LOADER_SILENT === '1') process.exit(0);
const { token } = await import('./lib/token.mjs');
console.error('📦 Remote Config: 2 params available');
console.log(\`export FAKE_RC_SECRET='\${MODE}+\${token}'\`);
`;

const SOURCE_AND_REPORT = '. "$RC_ENV"; status=$?; printf "status=%s secret=%s\\n" "$status" "${FAKE_RC_SECRET:-}"';

/**
 * Workspace finto: `frontaliere-articles/` e' un repo git con il loader e i
 * suoi tre moduli. `sparse` e' l'elenco del checkout sparse (oltre al README);
 * `null` lascia il checkout completo.
 */
function corpusFixture({ sparse = [`/${LOADER}`] } = {}) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'frontaliere-rc-env-')));
  const corpus = join(workspace, 'frontaliere-articles');
  const write = (rel, content) => {
    mkdirSync(dirname(join(corpus, rel)), { recursive: true });
    writeFileSync(join(corpus, rel), content);
  };
  write('README.md', '# corpus di prova\n');
  write(LOADER, LOADER_SOURCE);
  write(GUARD, "export { MODE } from './deep/shared.mjs';\n");
  write(SHARED, "export const MODE = 'guard';\n");
  write(TOKEN, "export const token = 'token';\n");

  const env = {
    PATH: process.env.PATH,
    HOME: workspace,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-C', corpus, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'corpus di prova');
  if (sparse) git('sparse-checkout', 'set', '--no-cone', '/README.md', ...sparse);

  const serviceAccount = join(workspace, 'service-account.json');
  writeFileSync(serviceAccount, '{}\n');
  const bash = (script, extraEnv = {}) => spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...env,
      WORKSPACE: workspace,
      GOOGLE_APPLICATION_CREDENTIALS: serviceAccount,
      RC_ENV,
      ...extraEnv,
    },
  });
  return {
    workspace,
    corpus,
    env,
    git,
    bash,
    loader: join(corpus, LOADER),
    onDisk: (rel) => existsSync(join(corpus, rel)),
    sparseList: () => readFileSync(join(corpus, git('rev-parse', '--git-path', 'info/sparse-checkout')), 'utf8'),
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

test('riconosce import statici, dinamici, riesportazioni e import per soli effetti', () => {
  const source = `
import fs from 'node:fs';
import { a,
  b } from './lib/a.mjs';
export { c } from "../shared/c.mjs";
import './effects.mjs';
const { d } = await import('./lib/d.mjs');
const admin = await import('firebase-admin/app');
`;
  assert.deepEqual(relativeSpecifiersIn(source).sort(), [
    '../shared/c.mjs',
    './effects.mjs',
    './lib/a.mjs',
    './lib/d.mjs',
  ]);
});

test('un modulo importato dal loader e rimasto fuori dal checkout sparse torna sul disco e i secret si caricano', () => {
  const fixture = corpusFixture();
  try {
    // Il guasto: il loader c'e', cio' che importa no.
    const broken = spawnSync('node', [fixture.loader], { encoding: 'utf8', env: fixture.env });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /ERR_MODULE_NOT_FOUND/);

    // La catena intera, anche il modulo raggiunto attraverso uno che manca.
    assert.deepEqual(
      inspectLoaderClosure(fixture.loader).missing.map((entry) => [entry.rel, entry.sparse]),
      [[GUARD, true], [TOKEN, true], [SHARED, true]],
    );

    const loaded = fixture.bash(SOURCE_AND_REPORT);
    assert.equal(loaded.stdout.trim().split('\n').at(-1), 'status=0 secret=guard+token', loaded.stderr);
    assert.match(loaded.stderr, /generator\/scripts\/lib\/guard\.mjs aggiunto al checkout sparse di frontaliere-articles/);
    for (const rel of [GUARD, SHARED, TOKEN]) assert.ok(fixture.onDisk(rel), `${rel} sul disco`);
    assert.equal(fixture.git('status', '--porcelain'), '', 'nessun contenuto e nessuna voce di indice cambiati');
    assert.match(fixture.sparseList(), /^\/generator\/scripts\/lib\/deep\/shared\.mjs$/m);

    // Il giro dopo non trova niente da riparare e non lo dice.
    const again = fixture.bash(SOURCE_AND_REPORT);
    assert.equal(again.stdout.trim().split('\n').at(-1), 'status=0 secret=guard+token');
    assert.doesNotMatch(again.stderr, /aggiunto al checkout sparse/);
  } finally {
    fixture.cleanup();
  }
});

test('anche il loader fuori dal checkout sparse torna sul disco, con il workspace raggiunto da un link', () => {
  const fixture = corpusFixture({ sparse: [] });
  const link = `${fixture.workspace}-link`;
  try {
    assert.equal(fixture.onDisk(LOADER), false);
    symlinkSync(fixture.workspace, link);
    const loaded = fixture.bash(SOURCE_AND_REPORT, { WORKSPACE: link });
    assert.equal(loaded.stdout.trim().split('\n').at(-1), 'status=0 secret=guard+token', loaded.stderr);
    for (const rel of [LOADER, GUARD, SHARED, TOKEN]) assert.ok(fixture.onDisk(rel), `${rel} sul disco`);
  } finally {
    rmSync(link, { force: true });
    fixture.cleanup();
  }
});

test('--check nomina i moduli e il comando, senza toccare il checkout', () => {
  const fixture = corpusFixture();
  try {
    const before = fixture.sparseList();
    const checked = spawnSync('node', [CLOSURE, fixture.loader, '--check'], { encoding: 'utf8', env: fixture.env });
    assert.equal(checked.status, INCOMPLETE_EXIT_CODE);
    const lines = checked.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^generator\/scripts\/lib\/guard\.mjs — tracciato, fuori dal checkout sparse\. Ripristina con: git -C \S+frontaliere-articles sparse-checkout add \/generator\/scripts\/lib\/guard\.mjs$/);
    assert.equal(fixture.onDisk(GUARD), false);
    assert.equal(fixture.sparseList(), before);
  } finally {
    fixture.cleanup();
  }
});

test('un modulo tracciato cancellato dal disco viene nominato e non ripristinato', () => {
  const fixture = corpusFixture({ sparse: null });
  try {
    rmSync(join(fixture.corpus, TOKEN));
    const failed = fixture.bash(SOURCE_AND_REPORT);
    assert.equal(failed.stdout.trim(), 'status=1 secret=');
    assert.match(failed.stderr, /✖ Il loader di Remote Config non e' caricabile: mancano moduli tracciati\./);
    assert.match(failed.stderr, /generator\/scripts\/lib\/token\.mjs — tracciato, cancellato dal disco\. Ripristina con: git -C \S+ checkout -- generator\/scripts\/lib\/token\.mjs/);
    assert.doesNotMatch(failed.stderr, /controlla l'auth/);
    assert.equal(fixture.onDisk(TOKEN), false, 'la cancellazione e\' di qualcuno: resta com\'e\'');

    // Con `set -e` nel chiamante la shell esce: la causa deve essere gia' fuori.
    const strict = fixture.bash('set -e; . "$RC_ENV"; echo NON-RAGGIUNTO');
    assert.equal(strict.status, 1);
    assert.doesNotMatch(strict.stdout, /NON-RAGGIUNTO/);
    assert.match(strict.stderr, /generator\/scripts\/lib\/token\.mjs — tracciato, cancellato dal disco/);
  } finally {
    fixture.cleanup();
  }
});

test('un loader che muore non viene raccontato come un problema di auth', () => {
  const fixture = corpusFixture({ sparse: null });
  try {
    const crashed = fixture.bash(SOURCE_AND_REPORT, { FAKE_LOADER_CRASH: '1' });
    assert.equal(crashed.stdout.trim(), 'status=1 secret=');
    assert.match(crashed.stderr, /SyntaxError: loader rotto di proposito/);
    assert.match(crashed.stderr, /✖ Il loader di Remote Config e' uscito con stato 1: l'errore di node e' qui sopra\./);
    assert.doesNotMatch(crashed.stderr, /controlla l'auth/);

    const strict = fixture.bash('set -e; . "$RC_ENV"; echo NON-RAGGIUNTO', { FAKE_LOADER_CRASH: '1' });
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /uscito con stato 1/);

    // Il loader vero esce 0 anche senza secret: quello resta un problema di auth.
    const silent = fixture.bash(SOURCE_AND_REPORT, { FAKE_LOADER_SILENT: '1' });
    assert.equal(silent.stdout.trim(), 'status=1 secret=');
    assert.match(silent.stderr, /✖ Remote Config non ha restituito nessun secret — controlla l'auth\./);
  } finally {
    fixture.cleanup();
  }
});

// --- gh-nanako vero, con rc-env.sh e gh finti accanto ---

function nanakoFixture(rcEnvSource) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'frontaliere-gh-nanako-')));
  const bin = join(directory, 'bin');
  const temporary = join(directory, 'tmp');
  mkdirSync(bin);
  mkdirSync(temporary);
  copyFileSync(GH_NANAKO, join(bin, 'gh-nanako'));
  chmodSync(join(bin, 'gh-nanako'), 0o755);
  writeFileSync(join(bin, 'rc-env.sh'), rcEnvSource);
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\nprintf "token=%s identity=%s args=%s\\n" "$GH_TOKEN" "$FRONTALIERE_GH_IDENTITY" "$*"\n');
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    run: (args, extraEnv = {}) => spawnSync(join(bin, 'gh-nanako'), args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: temporary, ...extraEnv },
    }),
    leftovers: () => readdirSync(temporary),
    sourced: () => existsSync(join(directory, 'sourced')),
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('gh-nanako riporta la causa detta da rc-env.sh e l\'errore di node, non il resto', () => {
  const fixture = nanakoFixture(`echo "📦 Remote Config: 0 params available" >&2
echo "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'lib/guard.mjs'" >&2
echo "    at finalizeResolution (node:internal/modules/esm/resolve:274:11)" >&2
echo "✖ Il loader di Remote Config e' uscito con stato 1: l'errore di node e' qui sopra." >&2
return 1
`);
  try {
    const failed = fixture.run(['api', 'user']);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /^✖ GITHUB_PAT_NANAKO non disponibile\.$/m);
    assert.match(failed.stderr, /^ {2}Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module 'lib\/guard\.mjs'$/m);
    assert.match(failed.stderr, /^ {2}✖ Il loader di Remote Config e' uscito con stato 1/m);
    assert.doesNotMatch(failed.stderr, /params available|finalizeResolution|non ha risposto/);
    assert.deepEqual(fixture.leftovers(), [], 'nessun file temporaneo lasciato');
  } finally {
    fixture.cleanup();
  }
});

test('gh-nanako senza una causa dichiarata tiene il messaggio generico, e con il PAT passa a gh', () => {
  const mute = nanakoFixture('return 1\n');
  const loading = nanakoFixture(`touch "$HOME/sourced"
export GITHUB_PAT_NANAKO='pat-di-prova'
`);
  try {
    const failed = mute.run(['api', 'user']);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^ {2}Remote Config non ha risposto\. Prova: source bin\/rc-env\.sh$/m);
    assert.deepEqual(mute.leftovers(), []);

    const loaded = loading.run(['api', 'repos/x']);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.stdout, 'token=pat-di-prova identity=nanako args=api repos/x\n');
    assert.deepEqual(loading.leftovers(), []);
    assert.ok(loading.sourced());

    rmSync(join(loading.directory, 'sourced'));
    const preset = loading.run(['api', 'repos/x'], { GITHUB_PAT_NANAKO: 'gia-in-ambiente' });
    assert.equal(preset.stdout, 'token=gia-in-ambiente identity=nanako args=api repos/x\n');
    assert.equal(loading.sourced(), false, 'un PAT gia\' in ambiente non passa da rc-env.sh');
  } finally {
    mute.cleanup();
    loading.cleanup();
  }
});
