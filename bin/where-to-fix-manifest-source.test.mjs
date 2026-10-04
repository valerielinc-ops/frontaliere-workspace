import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MANIFEST_GIT_REF,
  loadManifest,
  resolvePath,
} from './where-to-fix-lib.mjs';

// Il manifest che decide e' quello di `origin/main` del corpus: il checkout
// condiviso puo' essere fermo da settimane (il 2026-10-04: 925 commit dietro)
// e rispondere «nessun vincolo» su un gemello `identical` aggiunto dopo.

const MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';
const TWIN = 'scripts/ci/new-twin.mjs';

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  },
}).trim();

function writeManifest(corpusRoot, files) {
  const target = path.join(corpusRoot, MANIFEST_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ files }, null, 2)}\n`);
}

/**
 * Workspace finto: `frontaliere-articles/` e' un repo git con la copia di
 * lavoro ferma al manifest vecchio e `origin/main` che punta al nuovo.
 */
function staleWorkspace({ withOriginMain = true } = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'where-to-fix-'));
  const corpusRoot = path.join(workspaceRoot, 'frontaliere-articles');
  fs.mkdirSync(path.join(workspaceRoot, 'frontaliere-si-o-no'), { recursive: true });
  fs.mkdirSync(corpusRoot, { recursive: true });
  git(corpusRoot, 'init', '-q', '-b', 'main');

  writeManifest(corpusRoot, []);
  git(corpusRoot, 'add', MANIFEST_REL);
  git(corpusRoot, 'commit', '-q', '-m', 'manifest vecchio');
  const oldSha = git(corpusRoot, 'rev-parse', 'HEAD');

  writeManifest(corpusRoot, [{ path: TWIN, mode: 'identical', sitePath: TWIN }]);
  git(corpusRoot, 'add', MANIFEST_REL);
  git(corpusRoot, 'commit', '-q', '-m', 'manifest nuovo');
  const newSha = git(corpusRoot, 'rev-parse', 'HEAD');

  if (withOriginMain) git(corpusRoot, 'update-ref', 'refs/remotes/origin/main', newSha);
  git(corpusRoot, 'reset', '-q', '--hard', oldSha);
  return { workspaceRoot, corpusRoot };
}

test('legge il manifest da origin/main, non dalla copia di lavoro ferma', (t) => {
  const { workspaceRoot, corpusRoot } = staleWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const previous = process.env.LOOP_SYNC_MANIFEST_PATH;
  delete process.env.LOOP_SYNC_MANIFEST_PATH;
  t.after(() => { if (previous !== undefined) process.env.LOOP_SYNC_MANIFEST_PATH = previous; });

  const manifest = loadManifest({ workspaceRoot });
  assert.match(manifest.source, new RegExp(`^frontaliere-articles ${MANIFEST_GIT_REF} @ [0-9a-f]{7,} \\d{4}-\\d{2}-\\d{2}$`));
  assert.equal(manifest.entries.length, 1);
  assert.deepEqual(manifest.index.warnings, []);

  // Con la copia di lavoro la risposta sarebbe «nessun vincolo»: e' il difetto.
  const report = resolvePath(path.join(corpusRoot, TWIN), { workspaceRoot, index: manifest.index });
  assert.equal(report.mode, 'identical');
  assert.equal(report.fixRepo, 'site');
  assert.equal(report.repoMatchesFix, false);
});

test('senza origin/main ripiega sulla copia di lavoro e lo dichiara', (t) => {
  const { workspaceRoot, corpusRoot } = staleWorkspace({ withOriginMain: false });
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const previous = process.env.LOOP_SYNC_MANIFEST_PATH;
  delete process.env.LOOP_SYNC_MANIFEST_PATH;
  t.after(() => { if (previous !== undefined) process.env.LOOP_SYNC_MANIFEST_PATH = previous; });

  const manifest = loadManifest({ workspaceRoot });
  assert.equal(manifest.source, `copia di lavoro ${path.join(corpusRoot, MANIFEST_REL)}`);
  assert.equal(manifest.entries.length, 0);
  assert.equal(manifest.index.warnings.length, 1);
  assert.match(manifest.index.warnings[0], /origin\/main del corpus non leggibile: uso la copia di lavoro/);
});

test('un manifestPath esplicito vince e non passa da git', (t) => {
  const { workspaceRoot, corpusRoot } = staleWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const explicit = path.join(corpusRoot, MANIFEST_REL);
  let gitCalls = 0;
  const manifest = loadManifest({
    workspaceRoot,
    manifestPath: explicit,
    gitShow: () => { gitCalls += 1; return '{"files":[]}'; },
  });
  assert.equal(gitCalls, 0);
  assert.equal(manifest.source, `file ${explicit}`);
  assert.equal(manifest.entries.length, 0);
});
