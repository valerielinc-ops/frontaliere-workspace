import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_NAMES = Object.freeze({
  site: 'frontaliere-si-o-no',
  corpus: 'frontaliere-articles',
});

export const FIX_REPO_BY_MODE = Object.freeze({
  identical: 'site',
  adapted: 'corpus',
  'corpus-only': 'corpus',
  'corpus-only-pending': 'site',
  'not-ported': 'site',
});

const MODE_REASONS = Object.freeze({
  identical: 'Gemello identico: correggere nel sito e lasciare che il trasporto lo porti nel corpus.',
  adapted: 'Gemello adattato: correggere nel corpus.',
  'corpus-only': 'File presente solo nel corpus: correggere nel corpus.',
  'corpus-only-pending': 'Gemello ancora in attesa di porting: la correzione pendente appartiene al sito.',
  'not-ported': 'File deliberatamente non portato: la correzione appartiene al sito.',
});

export class WhereToFixError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WhereToFixError';
    this.code = code;
  }
}

function isDirectory(candidate, fsImpl = fs) {
  try {
    return fsImpl.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function normalizeRepoPath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/'));
  return normalized.replace(/^\.\//, '');
}

export function findWorkspaceRoot(startPath = MODULE_DIR, fsImpl = fs) {
  const resolvedStart = path.resolve(startPath);
  let current = isDirectory(resolvedStart, fsImpl) ? resolvedStart : path.dirname(resolvedStart);

  while (true) {
    if (isDirectory(path.join(current, REPO_NAMES.site), fsImpl) || isDirectory(path.join(current, REPO_NAMES.corpus), fsImpl)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.resolve(MODULE_DIR, '..');
}

function entryPaths(entry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) return null;

  const manifestPath = normalizeRepoPath(entry.path);
  const declaredSitePath = typeof entry.sitePath === 'string' && entry.sitePath.trim()
    ? normalizeRepoPath(entry.sitePath)
    : null;

  if (entry.mode === 'not-ported') {
    return { corpusPath: null, sitePath: declaredSitePath || manifestPath };
  }

  const sitePath = declaredSitePath || (
    entry.mode === 'corpus-only' || entry.mode === 'corpus-only-pending'
      ? null
      : manifestPath
  );
  return { corpusPath: manifestPath, sitePath };
}

export function createManifestIndex(entries) {
  if (!Array.isArray(entries)) {
    throw new WhereToFixError('MANIFEST_SHAPE', 'Il manifest non contiene un array files valido.');
  }

  const byRepo = { site: new Map(), corpus: new Map() };
  for (const entry of entries) {
    const paths = entryPaths(entry);
    if (!paths || typeof entry.mode !== 'string') {
      throw new WhereToFixError('MANIFEST_SHAPE', 'Il manifest contiene una voce senza path o mode.');
    }

    const pathsByRepo = { corpus: paths.corpusPath, site: paths.sitePath };
    for (const [repo, relativePath] of Object.entries(pathsByRepo)) {
      if (!relativePath) continue;
      if (byRepo[repo].has(relativePath)) {
        throw new WhereToFixError('MANIFEST_SHAPE', `Il manifest contiene path duplicato sul lato ${repo}: ${relativePath}`);
      }
      byRepo[repo].set(relativePath, entry);
    }
  }

  return { byRepo };
}

export function loadManifest({ workspaceRoot = findWorkspaceRoot(), manifestPath } = {}) {
  const corpusRoot = path.join(workspaceRoot, REPO_NAMES.corpus);
  if (!isDirectory(corpusRoot)) {
    throw new WhereToFixError(
      'ARTICLES_MISSING',
      `Child repo ${REPO_NAMES.corpus} non trovato sotto ${workspaceRoot}; impossibile leggere loop-sync-manifest.json.`,
    );
  }

  const resolvedManifestPath = manifestPath || process.env.LOOP_SYNC_MANIFEST_PATH || path.join(
    corpusRoot,
    'scripts/ci/loop-sync-manifest.json',
  );

  let raw;
  try {
    raw = fs.readFileSync(resolvedManifestPath, 'utf8');
  } catch (error) {
    throw new WhereToFixError(
      'MANIFEST_UNREADABLE',
      `Manifest non leggibile: ${resolvedManifestPath} (${error.code || error.message}).`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WhereToFixError(
      'MANIFEST_UNREADABLE',
      `Manifest non è JSON valido: ${resolvedManifestPath} (${error.message}).`,
    );
  }

  if (!parsed || !Array.isArray(parsed.files)) {
    throw new WhereToFixError('MANIFEST_SHAPE', `Manifest senza array files: ${resolvedManifestPath}.`);
  }

  return {
    manifestPath: resolvedManifestPath,
    entries: parsed.files,
    index: createManifestIndex(parsed.files),
  };
}

function repoRoots(workspaceRoot) {
  return {
    site: path.join(workspaceRoot, REPO_NAMES.site),
    corpus: path.join(workspaceRoot, REPO_NAMES.corpus),
  };
}

function repoForAbsolute(absolutePath, roots) {
  if (isWithin(roots.corpus, absolutePath)) return 'corpus';
  if (isWithin(roots.site, absolutePath)) return 'site';
  return null;
}

function relativePathInRepo(absolutePath, repo, roots) {
  return normalizeRepoPath(path.relative(roots[repo], absolutePath));
}

function resolveRelativeFromWorkspace(inputPath, { workspaceRoot, roots, index, fsImpl = fs }) {
  const normalized = normalizeRepoPath(inputPath);
  const explicitRepo = normalized.startsWith(`${REPO_NAMES.site}/`)
    ? 'site'
    : normalized.startsWith(`${REPO_NAMES.corpus}/`)
      ? 'corpus'
      : null;

  if (explicitRepo) {
    const relativePath = normalized.slice(REPO_NAMES[explicitRepo].length + 1);
    return {
      repo: explicitRepo,
      absolutePath: path.join(roots[explicitRepo], relativePath),
      relativePath,
    };
  }

  const existingRepos = Object.keys(roots).filter((repo) => fsImpl.existsSync(path.join(roots[repo], normalized)));
  const manifestRepos = Object.keys(index.byRepo).filter((repo) => index.byRepo[repo].has(normalized));
  const candidates = existingRepos.length ? existingRepos : manifestRepos;

  if (candidates.length !== 1) {
    throw new WhereToFixError(
      'PATH_AMBIGUOUS',
      `Path relativo ambiguo o non risolvibile: ${inputPath}. Eseguilo dentro un child repo, usa il prefisso ${REPO_NAMES.site}/ o ${REPO_NAMES.corpus}/, oppure passa un path assoluto.`,
    );
  }

  const repo = candidates[0];
  return { repo, absolutePath: path.join(roots[repo], normalized), relativePath: normalized };
}

function resolveInputPath(inputPath, { cwd, workspaceRoot, index, fsImpl = fs }) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new WhereToFixError('PATH_INVALID', 'Ogni path deve essere una stringa non vuota.');
  }

  const roots = repoRoots(workspaceRoot);
  const resolvedCwd = path.resolve(cwd);
  const cwdRepo = repoForAbsolute(resolvedCwd, roots);

  if (path.isAbsolute(inputPath)) {
    const absolutePath = path.normalize(inputPath);
    const repo = repoForAbsolute(absolutePath, roots);
    if (!repo) {
      throw new WhereToFixError('PATH_OUTSIDE_WORKSPACE', `Path fuori dai child repo: ${inputPath}.`);
    }
    return { repo, absolutePath, relativePath: relativePathInRepo(absolutePath, repo, roots) };
  }

  if (cwdRepo) {
    const absolutePath = path.resolve(resolvedCwd, inputPath);
    const repo = repoForAbsolute(absolutePath, roots);
    if (!repo) {
      throw new WhereToFixError('PATH_OUTSIDE_WORKSPACE', `Path fuori dai child repo: ${inputPath}.`);
    }
    return { repo, absolutePath, relativePath: relativePathInRepo(absolutePath, repo, roots) };
  }

  return resolveRelativeFromWorkspace(inputPath, { workspaceRoot, roots, index, fsImpl });
}

export function resolvePath(inputPath, {
  cwd = process.cwd(),
  workspaceRoot = findWorkspaceRoot(),
  index,
  entries,
  fsImpl = fs,
} = {}) {
  const manifestIndex = index || createManifestIndex(entries || []);
  const resolved = resolveInputPath(inputPath, { cwd, workspaceRoot, index: manifestIndex, fsImpl });
  const entry = manifestIndex.byRepo[resolved.repo].get(resolved.relativePath) || null;
  const mode = entry?.mode || null;
  const fixRepo = mode ? FIX_REPO_BY_MODE[mode] || null : null;
  const paths = entryPaths(entry);
  const otherRepo = resolved.repo === 'site' ? 'corpus' : 'site';
  const correspondingPath = paths ? paths[otherRepo === 'site' ? 'sitePath' : 'corpusPath'] : null;

  return {
    input: inputPath,
    repo: resolved.repo,
    repoName: REPO_NAMES[resolved.repo],
    relativePath: resolved.relativePath,
    mode,
    fixRepo,
    fixRepoName: fixRepo ? REPO_NAMES[fixRepo] : null,
    corresponding: correspondingPath
      ? { repo: otherRepo, repoName: REPO_NAMES[otherRepo], path: correspondingPath }
      : null,
    reason: mode
      ? MODE_REASONS[mode] || `Mode ${mode} non riconosciuto: nessuna destinazione automatica.`
      : 'Nessuna entry nel manifest: nessun vincolo di mirror.',
    manifestReason: entry?.reason || null,
    repoMatchesFix: !fixRepo || fixRepo === resolved.repo,
  };
}

export function formatHuman(report) {
  const status = report.repoMatchesFix ? '✓' : '⚠️';
  const mode = report.mode || 'assente (nessuna entry)';
  const fixRepo = report.fixRepo ? `${report.fixRepo.toUpperCase()} (${report.fixRepoName})` : 'nessun vincolo';
  const corresponding = report.corresponding
    ? `${report.corresponding.repoName}/${report.corresponding.path}`
    : 'nessuno';

  return [
    `${status} ${report.input}`,
    `  lato rilevato: ${report.repo.toUpperCase()} (${report.repoName}) — ${report.relativePath}`,
    `  mode: ${mode}`,
    `  correggere in: ${fixRepo}`,
    `  path corrispondente: ${corresponding}`,
    `  motivo: ${report.reason}`,
  ].join('\n');
}
