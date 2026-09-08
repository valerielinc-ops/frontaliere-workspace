import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findWorkspaceRoot,
  loadManifest,
  resolvePath,
} from './where-to-fix-lib.mjs';

const workspaceRoot = findWorkspaceRoot(fileURLToPath(import.meta.url));
const manifest = loadManifest({
  workspaceRoot,
  manifestPath: path.join(workspaceRoot, 'frontaliere-articles/scripts/ci/loop-sync-manifest.json'),
});

const repoRoot = (repo) => path.join(workspaceRoot, repo === 'site' ? 'frontaliere-si-o-no' : 'frontaliere-articles');
const absolute = (repo, relativePath) => path.join(repoRoot(repo), relativePath);

test('risolve i path corpus e sito rispettando sitePath e mode', () => {
  const identical = manifest.entries.find((entry) => entry.mode === 'identical' && entry.sitePath);
  assert.ok(identical, 'serve una entry identical con sitePath');

  const fromCorpus = resolvePath(absolute('corpus', identical.path), { workspaceRoot, index: manifest.index });
  assert.equal(fromCorpus.repo, 'corpus');
  assert.equal(fromCorpus.mode, 'identical');
  assert.equal(fromCorpus.fixRepo, 'site');
  assert.deepEqual(fromCorpus.corresponding, {
    repo: 'site',
    repoName: 'frontaliere-si-o-no',
    path: identical.sitePath,
  });
  assert.equal(fromCorpus.repoMatchesFix, false);

  const fromSite = resolvePath(absolute('site', identical.sitePath), { workspaceRoot, index: manifest.index });
  assert.equal(fromSite.repo, 'site');
  assert.equal(fromSite.mode, 'identical');
  assert.equal(fromSite.fixRepo, 'site');
  assert.deepEqual(fromSite.corresponding, {
    repo: 'corpus',
    repoName: 'frontaliere-articles',
    path: identical.path,
  });
  assert.equal(fromSite.repoMatchesFix, true);
});

test('risolve adapted dal lato corpus e corpus-only senza gemello', () => {
  const adapted = manifest.entries.find((entry) => entry.mode === 'adapted' && entry.sitePath);
  assert.ok(adapted, 'serve una entry adapted con sitePath');
  const adaptedReport = resolvePath(absolute('corpus', adapted.path), { workspaceRoot, index: manifest.index });
  assert.equal(adaptedReport.mode, 'adapted');
  assert.equal(adaptedReport.fixRepo, 'corpus');
  assert.equal(adaptedReport.corresponding.path, adapted.sitePath);
  assert.equal(adaptedReport.repoMatchesFix, true);

  const corpusOnly = manifest.entries.find((entry) => entry.mode === 'corpus-only' && !entry.sitePath);
  assert.ok(corpusOnly, 'serve una entry corpus-only senza sitePath');
  const corpusOnlyReport = resolvePath(absolute('corpus', corpusOnly.path), { workspaceRoot, index: manifest.index });
  assert.equal(corpusOnlyReport.mode, 'corpus-only');
  assert.equal(corpusOnlyReport.fixRepo, 'corpus');
  assert.equal(corpusOnlyReport.corresponding, null);
  assert.equal(corpusOnlyReport.repoMatchesFix, true);
});

test('un path non dichiarato è esplicitamente senza vincolo', () => {
  const report = resolvePath(absolute('site', 'README.md'), { workspaceRoot, index: manifest.index });
  assert.equal(report.mode, null);
  assert.equal(report.fixRepo, null);
  assert.equal(report.corresponding, null);
  assert.equal(report.repoMatchesFix, true);
});
