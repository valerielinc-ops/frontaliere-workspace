import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isGitCredentialCommand } from '../bin/github-coordinator-client.mjs';

const ROOT = join(import.meta.dirname, '..');
const CREDENTIAL = 'protocol=https\nhost=github.com\nusername=x\npassword=y\n';

function fakeGh(dir) {
  const path = join(dir, 'gh');
  // Stampa la credenziale solo se git le passa la richiesta su stdin, come il gh reale.
  writeFileSync(path, [
    '#!/bin/sh',
    'if [ "$1" = auth ] && [ "$2" = git-credential ] && [ "$3" = get ]; then',
    '  cat >/dev/null',
    `  printf '${CREDENTIAL.replace(/\n/g, '\\n')}'`,
    '  exit 0',
    'fi',
    'echo "fake gh: comando inatteso $*" >&2',
    'exit 9',
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

test('auth git-credential get va diretto al gh reale, senza toccare il socket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-shim-cred-'));
  const state = join(dir, 'state');
  try {
    const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'gh-frontaliere'), 'auth', 'git-credential', 'get'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        FRONTALIERE_REAL_GH: fakeGh(dir),
        FRONTALIERE_GH_STATE_DIR: state,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, CREDENTIAL);
    // Nessun socket, lock o daemon avviato: la directory di stato non e' stata nemmeno creata o e' vuota.
    let entries = [];
    try { entries = readdirSync(state); } catch { /* assente: ok */ }
    assert.deepEqual(entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('solo auth git-credential get/store/erase usano la via diretta', () => {
  for (const op of ['get', 'store', 'erase']) {
    assert.equal(isGitCredentialCommand(['auth', 'git-credential', op]), true, op);
  }
  assert.equal(isGitCredentialCommand(['auth', 'token']), false);
  assert.equal(isGitCredentialCommand(['auth', 'status']), false);
  assert.equal(isGitCredentialCommand(['auth', 'login']), false);
  assert.equal(isGitCredentialCommand(['auth', 'git-credential']), false);
  assert.equal(isGitCredentialCommand(['pr', 'list']), false);
});
