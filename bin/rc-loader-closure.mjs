#!/usr/bin/env node

/**
 * Is the Remote Config loader loadable from this checkout?
 *
 * bin/rc-env.sh runs frontaliere-articles/generator/scripts/load-rc-env.mjs
 * from the main corpus checkout, which is sparse and whose path list grows by
 * hand. A module the loader starts importing is tracked but not on disk: node
 * dies with ERR_MODULE_NOT_FOUND before it reads Remote Config, and rc-env.sh
 * reported that as "no secret, check the auth". It happened to the loader
 * itself on 2026-09-17 and to lib/source-copy-guard.mjs on 2026-10-08, the
 * second time hidden for a day by the coordinator's keychain cache.
 *
 * This walks the loader's relative imports, static and dynamic, and looks for
 * every module on disk. One that the sparse checkout left out is added to it
 * with `git sparse-checkout add`: a tracked file appears, no content and no
 * index entry changes. Whatever that cannot bring back is named on stdout with
 * the command that restores it.
 *
 *   node bin/rc-loader-closure.mjs <loader> [--check]
 *
 * Exit 0: every module is on disk, possibly after a repair. Exit 3: at least
 * one is still missing. `--check` reports and never touches the checkout.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INCOMPLETE_EXIT_CODE = 3;

// `from './x'`, `import './x'` and `import('./x')`. An import inside a comment
// or a string matches too. That can only widen the walk to one more tracked
// file: a path git does not know is never reported, node says so if it matters.
const RELATIVE_SPECIFIER = /\b(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g;

/** The relative module specifiers a source file names. */
export function relativeSpecifiersIn(source) {
  return [...new Set([...String(source).matchAll(RELATIVE_SPECIFIER)].map((match) => match[2]))];
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// The path node and git both mean: symbolic links resolved up to the nearest
// folder that exists (the loader, or its folder, may be what is missing).
// Without it a workspace reached through a link (/var on macOS) compares
// unequal to the root git reports and every module looks foreign.
function canonicalPath(file) {
  let existing = resolve(file);
  const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return resolve(file);
  }
}

function repositoryRoot(file) {
  let directory = dirname(file);
  while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
  const answer = git(directory, ['rev-parse', '--show-toplevel']);
  return answer.ok ? answer.stdout.trim() : null;
}

function trackedModule(root, file) {
  const rel = relative(root, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const listed = git(root, ['ls-files', '-t', '-z', '--', rel]).stdout;
  if (!listed) return null;
  const source = git(root, ['show', `:${rel}`]);
  return {
    rel,
    // `S` is the skip-worktree bit: the sparse checkout left the file out.
    // Anything else is a tracked file somebody removed from the disk.
    sparse: listed.startsWith('S '),
    source: source.ok ? source.stdout : '',
  };
}

/**
 * The modules the loader reaches by relative import that are tracked and not
 * on disk. Read-only. Imports of a missing module are followed through the
 * copy in the index, so one repair brings back the whole chain.
 */
export function inspectLoaderClosure(loaderPath) {
  const loader = canonicalPath(loaderPath);
  // Resolved on the first missing module: a complete checkout starts no git.
  let root;
  const missing = [];
  const seen = new Set([loader]);
  const queue = [loader];
  while (queue.length > 0) {
    const file = queue.shift();
    let source;
    if (existsSync(file)) {
      source = readFileSync(file, 'utf8');
    } else {
      if (root === undefined) root = repositoryRoot(loader);
      const tracked = root ? trackedModule(root, file) : null;
      if (!tracked) continue;
      missing.push(tracked);
      source = tracked.source;
    }
    for (const specifier of relativeSpecifiersIn(source)) {
      const target = resolve(dirname(file), specifier);
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return { loader, root: root ?? null, missing };
}

/**
 * Adds the modules the sparse checkout left out. Returns what is on disk
 * afterwards and, when git refused, its first line of explanation.
 */
export function materializeSparseModules(root, missing) {
  const sparse = missing.filter((entry) => entry.sparse);
  if (sparse.length === 0) return { materialized: [], error: null };
  const cone = git(root, ['config', '--bool', 'core.sparseCheckoutCone']).stdout.trim() === 'true';
  // Cone mode lists directories; the other mode takes the file, anchored at
  // the root so the pattern cannot match a namesake deeper in the tree.
  const targets = [...new Set(sparse.map((entry) => (cone ? dirname(entry.rel) : `/${entry.rel}`)))];
  const added = git(root, ['sparse-checkout', 'add', ...targets]);
  return {
    materialized: sparse.filter((entry) => existsSync(join(root, entry.rel))),
    error: added.ok ? null : (added.stderr.trim().split('\n')[0] || 'git sparse-checkout add failed'),
  };
}

function restoreCommand(root, entry) {
  return entry.sparse
    ? `git -C ${root} sparse-checkout add /${entry.rel}`
    : `git -C ${root} checkout -- ${entry.rel}`;
}

function main(argv) {
  const loaderArgument = argv.find((argument) => !argument.startsWith('--'));
  if (!loaderArgument) {
    process.stderr.write('uso: rc-loader-closure.mjs <loader> [--check]\n');
    return 2;
  }
  const { root, missing } = inspectLoaderClosure(loaderArgument);
  let unresolved = missing;
  let refusal = null;
  if (missing.length > 0 && !argv.includes('--check')) {
    const { materialized, error } = materializeSparseModules(root, missing);
    refusal = error;
    for (const entry of materialized) {
      process.stderr.write(
        `ℹ️  rc-env: ${entry.rel} aggiunto al checkout sparse di ${basename(root)} `
        + '(lo importa il loader di Remote Config).\n',
      );
    }
    unresolved = missing.filter((entry) => !existsSync(join(root, entry.rel)));
  }
  for (const entry of unresolved) {
    const why = entry.sparse ? 'tracciato, fuori dal checkout sparse' : 'tracciato, cancellato dal disco';
    process.stdout.write(`${entry.rel} — ${why}. Ripristina con: ${restoreCommand(root, entry)}\n`);
  }
  if (refusal && unresolved.some((entry) => entry.sparse)) {
    process.stdout.write(`git sparse-checkout add non e' riuscito: ${refusal}\n`);
  }
  return unresolved.length > 0 ? INCOMPLETE_EXIT_CODE : 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
