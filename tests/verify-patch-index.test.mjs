import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = path.resolve(fileURLToPath(import.meta.url), '../../bin/verify-patch-index.mjs');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshot(repo, files = ['modify.txt', 'staged.txt', 'mode.sh']) {
  const indexName = git(repo, ['rev-parse', '--git-path', 'index']).trim();
  const indexPath = path.isAbsolute(indexName) ? indexName : path.resolve(repo, indexName);
  return {
    head: git(repo, ['rev-parse', 'HEAD']).trim(),
    index: fs.readFileSync(indexPath),
    status: git(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    files: Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(repo, file))])),
  };
}

function assertSnapshotUnchanged(before, after) {
  assert.equal(after.head, before.head);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.index, before.index);
  assert.deepEqual(after.files, before.files);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-patch-index-test-'));
  const repo = path.join(root, 'repo');
  const tempRoot = path.join(root, 'private-tmp');
  fs.mkdirSync(repo);
  fs.mkdirSync(tempRoot);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Patch verifier test']);
  git(repo, ['config', 'user.email', 'patch-verifier@example.invalid']);
  for (const [file, contents] of [
    ['modify.txt', 'before\n'],
    ['delete.txt', 'remove\n'],
    ['mode.sh', 'echo mode\n'],
    ['staged.txt', 'base staged\n'],
    ['unchanged.txt', 'same\n'],
  ]) {
    fs.writeFileSync(path.join(repo, file), contents);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();

  fs.writeFileSync(path.join(repo, 'modify.txt'), 'worktree-only\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged-change\n');
  git(repo, ['add', 'staged.txt']);

  return {
    root,
    repo,
    base,
    tempRoot,
    before: snapshot(repo),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writePatch(fixtureData, contents, name = 'change.patch') {
  const patchPath = path.join(fixtureData.root, name);
  fs.writeFileSync(patchPath, contents);
  return patchPath;
}

function runHelper(fixtureData, patchPath, expected, base = fixtureData.base) {
  const args = [
    helper,
    '--repo',
    fixtureData.repo,
    '--base',
    base,
    '--patch',
    patchPath,
  ];
  if (expected) args.push('--expected', expected);
  return spawnSync(process.execPath, args, {
    env: { ...process.env, TMPDIR: fixtureData.tempRoot },
    encoding: 'utf8',
  });
}

const addModifyDeleteModePatch = [
  'diff --git a/add.txt b/add.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/add.txt',
  '@@ -0,0 +1 @@',
  '+added',
  'diff --git a/modify.txt b/modify.txt',
  '--- a/modify.txt',
  '+++ b/modify.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  'diff --git a/delete.txt b/delete.txt',
  'deleted file mode 100644',
  '--- a/delete.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-remove',
  'diff --git a/mode.sh b/mode.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/public/new.txt b/public/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/public/new.txt',
  '@@ -0,0 +1 @@',
  '+public',
  'diff --git a/data/new.json b/data/new.json',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/data/new.json',
  '@@ -0,0 +1 @@',
  '+{"ok":true}',
  '',
].join('\n');

test('verifica add/modify/delete/mode e preserva worktree e indice originali', (t) => {
  const data = fixture();
  t.after(data.cleanup);
  const patchPath = writePatch(data, addModifyDeleteModePatch);
  const expectedPath = path.join(data.root, 'expected.json');
  fs.writeFileSync(expectedPath, JSON.stringify({
    'unchanged.txt': sha256('same\n'),
    'add.txt': sha256('added\n'),
  }));

  const result = runHelper(data, patchPath, expectedPath);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.actualBase, data.base);
  assert.match(output.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(output.expectedMismatch, {});
  assert.equal(output.hashes['unchanged.txt'], sha256('same\n'));
  assert.equal(output.hashes['delete.txt'], null);
  assert.equal(output.hashes['public/new.txt'], sha256('public\n'));
  assert.equal(output.hashes['data/new.json'], sha256('{"ok":true}\n'));
  assert.deepEqual(output.changedPaths.find((change) => change.path === 'add.txt'), {
    path: 'add.txt', status: 'A', oldMode: null, mode: '100644',
  });
  assert.deepEqual(output.changedPaths.find((change) => change.path === 'delete.txt'), {
    path: 'delete.txt', status: 'D', oldMode: '100644', mode: null,
  });
  assert.deepEqual(output.changedPaths.find((change) => change.path === 'mode.sh'), {
    path: 'mode.sh', status: 'M', oldMode: '100644', mode: '100755',
  });
  assert.equal(fs.existsSync(path.join(data.repo, 'public')), false);
  assert.equal(fs.existsSync(path.join(data.repo, 'data')), false);
  assertSnapshotUnchanged(data.before, snapshot(data.repo));
  assert.deepEqual(fs.readdirSync(data.tempRoot), []);
});

test('riporta mismatch SHA-256 senza esporre contenuti e conserva l indice', (t) => {
  const data = fixture();
  t.after(data.cleanup);
  const patchPath = writePatch(data, addModifyDeleteModePatch);
  const expectedPath = path.join(data.root, 'expected.json');
  fs.writeFileSync(expectedPath, JSON.stringify({
    'unchanged.txt': '0'.repeat(64),
    'missing.txt': 'f'.repeat(64),
  }));

  const result = runHelper(data, patchPath, expectedPath);
  assert.equal(result.status, 4);
  const output = JSON.parse(result.stdout);
  assert.equal(output.expectedMismatch['unchanged.txt'].expected, '0'.repeat(64));
  assert.equal(output.expectedMismatch['unchanged.txt'].actual, sha256('same\n'));
  assert.deepEqual(output.expectedMismatch['missing.txt'], {
    expected: 'f'.repeat(64),
    actual: null,
  });
  assert.doesNotMatch(result.stdout, /added\n|public\n|remove\n|"ok":true/);
  assertSnapshotUnchanged(data.before, snapshot(data.repo));
  assert.deepEqual(fs.readdirSync(data.tempRoot), []);
  assert.equal(fs.existsSync(path.join(data.repo, 'public')), false);
});

test('fallisce su patch malformata e path traversal ripulendo sempre l indice privato', (t) => {
  const data = fixture();
  t.after(data.cleanup);

  const missing = runHelper(data, path.join(data.root, 'missing.patch'));
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.deepEqual(fs.readdirSync(data.tempRoot), []);
  assertSnapshotUnchanged(data.before, snapshot(data.repo));

  const unresolved = runHelper(data, writePatch(data, 'non è una patch\n', 'unresolved.patch'), undefined, 'missing-base');
  assert.notEqual(unresolved.status, 0);
  assert.equal(unresolved.stdout, '');
  assert.deepEqual(fs.readdirSync(data.tempRoot), []);
  assertSnapshotUnchanged(data.before, snapshot(data.repo));

  const malformed = runHelper(data, writePatch(data, 'non è una patch\n', 'malformed.patch'));
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stdout, '');
  assert.doesNotMatch(malformed.stderr, /non è una patch/);
  assertSnapshotUnchanged(data.before, snapshot(data.repo));
  assert.deepEqual(fs.readdirSync(data.tempRoot), []);

  const traversalPatch = [
    'diff --git a/../escaped.txt b/../escaped.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/../escaped.txt',
    '@@ -0,0 +1 @@',
    '+escaped',
    '',
  ].join('\n');
  const traversal = runHelper(data, writePatch(data, traversalPatch, 'traversal.patch'));
  assert.notEqual(traversal.status, 0);
  assert.equal(traversal.stdout, '');
  assert.equal(fs.existsSync(path.join(data.root, 'escaped.txt')), false);
  assert.deepEqual(fs.readdirSync(data.tempRoot), []);
  assertSnapshotUnchanged(data.before, snapshot(data.repo));
});

test('usa il gitdir di un linked worktree senza checkout o materializzazione di public/data', (t) => {
  const data = fixture();
  t.after(data.cleanup);
  const linked = path.join(data.root, 'linked');
  git(data.repo, ['worktree', 'add', '-q', '--detach', linked, data.base]);
  fs.writeFileSync(path.join(linked, 'modify.txt'), 'linked-dirty\n');
  fs.writeFileSync(path.join(linked, 'staged.txt'), 'linked-staged\n');
  git(linked, ['add', 'staged.txt']);
  const before = snapshot(linked);
  assert.match(fs.readFileSync(path.join(linked, '.git'), 'utf8'), /^gitdir:/);

  const patchPath = writePatch(data, [
    'diff --git a/data/linked.json b/data/linked.json',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/data/linked.json',
    '@@ -0,0 +1 @@',
    '+{"linked":true}',
    '',
  ].join('\n'), 'linked.patch');
  const result = runHelper({ ...data, repo: linked }, patchPath);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hashes['data/linked.json'], sha256('{"linked":true}\n'));
  assert.equal(fs.existsSync(path.join(linked, 'data')), false);
  assert.equal(fs.existsSync(path.join(linked, 'public')), false);
  assert.equal(fs.existsSync(path.join(data.root, 'checkout')), false);
  assertSnapshotUnchanged(before, snapshot(linked));
  assert.deepEqual(fs.readdirSync(data.tempRoot), []);
});
