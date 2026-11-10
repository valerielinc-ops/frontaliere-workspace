import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// .claude/settings.json e .codex/config.toml sono condivisi fra i Mac del
// proprietario: un path /Users/<utente> vale su una macchina sola. I valori
// per-macchina arrivano da bin/session-env.sh (Claude) e dal
// ~/.codex/config.toml dell'utente (Codex).
const SCRIPT = path.resolve('bin/session-env.sh');

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'session-env-')));
  const ws = path.join(root, 'ws');
  mkdirSync(path.join(ws, 'bin'), { recursive: true });
  mkdirSync(path.join(ws, 'frontaliere-si-o-no'));
  writeFileSync(path.join(ws, 'bin', 'session-env.sh'), readFileSync(SCRIPT));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.config', 'frontaliere'), { recursive: true });
  const envFile = path.join(root, 'claude-env');
  writeFileSync(envFile, '');
  return { root, ws, home, envFile };
}

function run({ ws, home, envFile }, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_ENV_FILE: envFile, ...extra };
  execFileSync('sh', [path.join(ws, 'bin', 'session-env.sh')], { env });
  const exported = execFileSync('sh', ['-c', `. "${envFile}"; printf '%s\\n%s' "\${WORKSPACE:-}" "\${GOOGLE_APPLICATION_CREDENTIALS:-}"`], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  const [workspace, credentials] = exported.split('\n');
  return { workspace, credentials, raw: readFileSync(envFile, 'utf8') };
}

test('esporta WORKSPACE dalla posizione dello script e la chiave da $HOME', () => {
  const f = fixture();
  const sa = path.join(f.home, '.config', 'frontaliere', 'sa-frontaliere-ticino.json');
  writeFileSync(sa, '{}');
  const out = run(f);
  assert.equal(out.workspace, f.ws);
  assert.equal(out.credentials, sa);
});

test('un valore gia presente vince, e una chiave assente non viene esportata', () => {
  const f = fixture();
  const out = run(f, { WORKSPACE: f.ws, GOOGLE_APPLICATION_CREDENTIALS: '/altrove/sa.json' });
  assert.equal(out.raw, '');
  const missing = run(fixture());
  assert.equal(missing.credentials, '');
});

test('un WORKSPACE che non e un workspace viene sostituito', () => {
  const f = fixture();
  const out = run(f, { WORKSPACE: path.join(f.root, 'inesistente') });
  assert.equal(out.workspace, f.ws);
});

test('senza CLAUDE_ENV_FILE non scrive niente ed esce 0', () => {
  const f = fixture();
  execFileSync('sh', [path.join(f.ws, 'bin', 'session-env.sh')], { env: { PATH: process.env.PATH, HOME: f.home } });
  assert.equal(readFileSync(f.envFile, 'utf8'), '');
});

for (const file of ['.claude/settings.json', '.codex/config.toml', '.codex/hooks.json']) {
  test(`${file} non contiene path assoluti di un utente`, () => {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\/Users\/[^/"'\s]+/);
  });
}

test('.claude/settings.json esegue session-env.sh a SessionStart', () => {
  const config = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
  const hooks = config.hooks.SessionStart.flatMap((entry) => entry.hooks);
  assert.ok(hooks.some((hook) => hook.command.includes('bin/session-env.sh')));
});
