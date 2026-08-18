#!/usr/bin/env node
/**
 * Crea un branch remoto via API git-data, senza `git push`.
 *
 * Su questo clone (shallow, 53 pack disgiunti) pack-objects muore di OOM anche
 * coi flag anti-pianto di CLAUDE.md: `--no-thin --force` gli chiede di spedire
 * un albero che non ha basi comuni utili. L'API non ha quel problema perche'
 * spedisce solo i blob che nomino io.
 *
 * Uso: node push-via-api.mjs <worktree> <repo> <branch> <baseSha> <messaggio-file> <file...>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [worktree, repo, branch, baseSha, msgFile, ...files] = process.argv.slice(2);
if (!files.length) {
  console.error('uso: push-via-api.mjs <worktree> <repo> <branch> <baseSha> <msgFile> <file...>');
  process.exit(2);
}

const api = (args, input) => {
  const out = execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : null;
};

const baseCommit = api([`repos/${repo}/git/commits/${baseSha}`]);
console.log(`base ${baseSha.slice(0, 9)} → tree ${baseCommit.tree.sha.slice(0, 9)}`);

const tree = [];
for (const rel of files) {
  const content = readFileSync(join(worktree, rel));
  const blob = api(
    [`repos/${repo}/git/blobs`, '--method', 'POST', '--input', '-'],
    JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  );
  // 100755 per i file eseguibili, altrimenti 100644 — leggo il bit da git
  // invece di indovinarlo dall'estensione.
  const mode = execFileSync('git', ['-C', worktree, 'ls-files', '-s', '--', rel], { encoding: 'utf8' })
    .trim().split(/\s+/)[0] || '100644';
  tree.push({ path: rel, mode, type: 'blob', sha: blob.sha });
  console.log(`  blob ${blob.sha.slice(0, 9)} ${mode} ${rel} (${content.length} B)`);
}

const newTree = api(
  [`repos/${repo}/git/trees`, '--method', 'POST', '--input', '-'],
  JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
);
console.log(`tree ${newTree.sha.slice(0, 9)}`);

const commit = api(
  [`repos/${repo}/git/commits`, '--method', 'POST', '--input', '-'],
  JSON.stringify({ message: readFileSync(msgFile, 'utf8'), tree: newTree.sha, parents: [baseSha] }),
);
console.log(`commit ${commit.sha.slice(0, 9)}`);

let ref;
try {
  ref = api(
    [`repos/${repo}/git/refs`, '--method', 'POST', '--input', '-'],
    JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  );
} catch {
  ref = api(
    [`repos/${repo}/git/refs/heads/${branch}`, '--method', 'PATCH', '--input', '-'],
    JSON.stringify({ sha: commit.sha, force: true }),
  );
}
console.log(`ref ${ref.ref} → ${ref.object.sha.slice(0, 9)}`);
