import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  persistCredentials,
  RC_CACHE_MAX_AGE_MS,
  readCachedCredentials,
  rcCacheAvailable,
} from '../bin/github-coordinator-rc-cache.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(ROOT, 'bin', 'github-coordinator-launcher');

function fakeKeychain() {
  const items = new Map();
  const calls = [];
  const exec = (_file, args) => {
    calls.push(args[0]);
    const service = args[args.indexOf('-s') + 1];
    const account = args[args.indexOf('-a') + 1];
    const key = `${service}/${account}`;
    if (args[0] === 'find-generic-password') {
      if (!items.has(key)) throw Object.assign(new Error('not found'), { status: 44 });
      return `${items.get(key)}\n`;
    }
    if (args[0] === 'add-generic-password') {
      items.set(key, args[args.indexOf('-w') + 1]);
      return '';
    }
    throw new Error(`unexpected security command ${args[0]}`);
  };
  return { items, calls, exec };
}

const options = (keychain, environment = {}, extra = {}) => ({
  available: true,
  exec: keychain.exec,
  service: 'test-service',
  environment,
  ...extra,
});

test('salva solo i valori indicati, separando le identità e conservando la data', () => {
  const keychain = fakeKeychain();
  const environment = {
    GITHUB_PAT: 'rc-default-token',
    GITHUB_PAT_NANAKO: 'rc-nanako-token',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'rc-webhook-secret',
  };
  assert.equal(persistCredentials('default', {
    ...options(keychain, environment, { nowMs: 1_000 }),
    only: ['FRONTALIERE_GH_TOKEN'],
  }), 1, 'il secret non richiesto non viene salvato');
  assert.equal(persistCredentials('nanako', {
    ...options(keychain, environment, { nowMs: 2_000 }),
    only: ['FRONTALIERE_GH_TOKEN_NANAKO', 'FRONTALIERE_GH_WEBHOOK_SECRET'],
  }), 2);
  assert.deepEqual(JSON.parse(keychain.items.get('test-service/token-default')), { value: 'rc-default-token', storedAt: 1_000 });
  assert.deepEqual(JSON.parse(keychain.items.get('test-service/token-nanako')), { value: 'rc-nanako-token', storedAt: 2_000 });
  assert.equal(JSON.parse(keychain.items.get('test-service/webhook-secret')).value, 'rc-webhook-secret');

  const defaults = readCachedCredentials('default', options(keychain, {}, { nowMs: 5_000 }));
  assert.deepEqual(defaults, {
    values: { FRONTALIERE_GH_TOKEN: 'rc-default-token', FRONTALIERE_GH_WEBHOOK_SECRET: 'rc-webhook-secret' },
    complete: true,
    fresh: true,
  });
  const nanako = readCachedCredentials('nanako', options(keychain, {}, { nowMs: 5_000 }));
  assert.equal(nanako.values.FRONTALIERE_GH_TOKEN_NANAKO, 'rc-nanako-token');
  assert.equal(nanako.values.FRONTALIERE_GH_TOKEN, undefined);
});

test('rilegge solo ciò che manca e distingue voce assente e voce scaduta', () => {
  const keychain = fakeKeychain();
  persistCredentials('default', {
    ...options(keychain, { GITHUB_PAT: 'cached-token', FRONTALIERE_GH_WEBHOOK_SECRET: 'cached-secret' }, { nowMs: 0 }),
    only: ['FRONTALIERE_GH_TOKEN', 'FRONTALIERE_GH_WEBHOOK_SECRET'],
  });
  const withOverride = readCachedCredentials('default', options(keychain, { FRONTALIERE_GH_TOKEN: 'explicit' }, { nowMs: 10 }));
  assert.deepEqual(withOverride.values, { FRONTALIERE_GH_WEBHOOK_SECRET: 'cached-secret' }, 'un valore esplicito non viene sostituito');

  const stale = readCachedCredentials('default', options(keychain, {}, { nowMs: RC_CACHE_MAX_AGE_MS + 1 }));
  assert.equal(stale.complete, true);
  assert.equal(stale.fresh, false);
  assert.equal(readCachedCredentials('default', options(keychain, {}, { nowMs: RC_CACHE_MAX_AGE_MS + 1, maxAgeMs: Infinity })).fresh, true);

  keychain.items.set('test-service/webhook-secret', 'not json');
  assert.equal(readCachedCredentials('default', options(keychain, {}, { nowMs: 10 })).complete, false);
  keychain.items.delete('test-service/token-default');
  assert.equal(readCachedCredentials('default', options(keychain, {}, { nowMs: 10 })).complete, false);
});

test('la cache resta spenta fuori da macOS, se disattivata o per un daemon di test', () => {
  const keychain = fakeKeychain();
  assert.equal(rcCacheAvailable({ platform: 'linux', environment: {} }), false);
  assert.equal(rcCacheAvailable({ platform: 'darwin', environment: { FRONTALIERE_GH_RC_CACHE: '0' } }), false);
  assert.equal(rcCacheAvailable({ platform: 'darwin', environment: { FRONTALIERE_GH_STATE_DIR: '/tmp/state' } }), false);
  const isolated = { exec: keychain.exec, platform: 'darwin', environment: { FRONTALIERE_GH_STATE_DIR: '/tmp/state', GITHUB_PAT: 'x' } };
  assert.equal(persistCredentials('default', { ...isolated, only: ['FRONTALIERE_GH_TOKEN'] }), 0);
  assert.deepEqual(readCachedCredentials('default', isolated).values, {});
  assert.deepEqual(keychain.calls, [], 'il portachiavi del proprietario non viene nemmeno interrogato');
});

// --- the real launcher, with fake `security`, Remote Config and coordinator ---

function launcherFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'frontaliere-rc-cache-launcher-'));
  const store = join(directory, 'keychain');
  const security = join(directory, 'security');
  writeFileSync(security, `#!/bin/bash
store=${JSON.stringify(store)}
mkdir -p "$store"
command="$1"; shift
service=""; account=""; value=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -s) service="$2"; shift 2 ;;
    -a) account="$2"; shift 2 ;;
    # Like the real tool: \`-w VALUE\` stores, a trailing \`-w\` prints the value.
    -w) if [ "$#" -ge 2 ]; then value="$2"; shift 2; else shift; fi ;;
    -l) shift 2 ;;
    *) shift ;;
  esac
done
echo "$command $account" >> "$store/calls.log"
file="$store/$service--$account"
case "$command" in
  find-generic-password) [ -f "$file" ] || exit 44; cat "$file" ;;
  add-generic-password) printf '%s' "$value" > "$file" ;;
  *) exit 2 ;;
esac
`);
  chmodSync(security, 0o700);
  const rcEnv = join(directory, 'rc-env.sh');
  writeFileSync(rcEnv, `echo loaded >> ${JSON.stringify(join(directory, 'rc-loads.log'))}
if [ "\${FAKE_RC_FAIL:-}" = "1" ]; then return 1; fi
export GITHUB_PAT='rc-default-token'
export GITHUB_PAT_NANAKO='rc-nanako-token'
export FRONTALIERE_GH_WEBHOOK_SECRET='rc-webhook-secret'
export UNRELATED_RC_SECRET='rc-unrelated'
`);
  const entry = join(directory, 'coordinator.mjs');
  writeFileSync(entry, `const pick = (name) => process.env[name] || null;
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  token: pick('FRONTALIERE_GH_TOKEN'),
  nanakoToken: pick('FRONTALIERE_GH_TOKEN_NANAKO'),
  webhookSecret: pick('FRONTALIERE_GH_WEBHOOK_SECRET'),
  unrelated: pick('UNRELATED_RC_SECRET'),
}));
`);
  const run = (args = ['serve', '--identity', 'default'], extraEnv = {}) => {
    const result = spawnSync(LAUNCHER, args, {
      encoding: 'utf8',
      env: {
        HOME: directory,
        PATH: process.env.PATH,
        FRONTALIERE_SECURITY_BIN: security,
        FRONTALIERE_GH_RC_CACHE_SERVICE: 'test-rc-cache',
        FRONTALIERE_GH_RC_ENV_SCRIPT: rcEnv,
        FRONTALIERE_GH_COORDINATOR_ENTRY: entry,
        ...extraEnv,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const rcLoads = () => (existsSync(join(directory, 'rc-loads.log'))
    ? readFileSync(join(directory, 'rc-loads.log'), 'utf8').trim().split('\n').length
    : 0);
  const item = (account) => {
    const file = join(store, `test-rc-cache--${account}`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const age = (account, milliseconds) => {
    const file = join(store, `test-rc-cache--${account}`);
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...entry, storedAt: entry.storedAt - milliseconds }));
  };
  return { directory, store, run, rcLoads, item, age, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('il launcher parte dalla cache senza Remote Config e la rinnova dopo un giorno', { skip: process.platform !== 'darwin' }, () => {
  const fixture = launcherFixture();
  try {
    const first = fixture.run();
    assert.equal(fixture.rcLoads(), 1);
    assert.equal(first.token, 'rc-default-token');
    assert.equal(first.webhookSecret, 'rc-webhook-secret');
    assert.deepEqual(first.args, ['serve', '--identity', 'default']);
    assert.equal(fixture.item('token-default').value, 'rc-default-token');
    assert.equal(fixture.item('webhook-secret').value, 'rc-webhook-secret');

    const cached = fixture.run();
    assert.equal(fixture.rcLoads(), 1, 'nessun caricamento di Remote Config');
    assert.equal(cached.token, 'rc-default-token');
    assert.equal(cached.webhookSecret, 'rc-webhook-secret');
    assert.equal(cached.unrelated, null, 'dalla cache arrivano solo le credenziali del coordinator');

    // A day later with Remote Config down: the stale entry keeps it running.
    fixture.age('token-default', RC_CACHE_MAX_AGE_MS + 60_000);
    const storedAt = fixture.item('token-default').storedAt;
    const fallback = fixture.run(undefined, { FAKE_RC_FAIL: '1' });
    assert.equal(fixture.rcLoads(), 2);
    assert.equal(fallback.token, 'rc-default-token');
    assert.equal(fallback.webhookSecret, 'rc-webhook-secret');
    assert.equal(fixture.item('token-default').storedAt, storedAt, 'niente da rinnovare');

    // Remote Config back: the entry is refreshed.
    const refreshed = fixture.run();
    assert.equal(fixture.rcLoads(), 3);
    assert.equal(refreshed.token, 'rc-default-token');
    assert.ok(fixture.item('token-default').storedAt > storedAt);
  } finally {
    fixture.cleanup();
  }
});

test('refresh esplicito, override e identità nanako', { skip: process.platform !== 'darwin' }, () => {
  const fixture = launcherFixture();
  try {
    fixture.run();
    const refreshed = fixture.run(['serve', '--refresh-remote-config', '--identity', 'default']);
    assert.equal(fixture.rcLoads(), 2, 'la cache fresca viene saltata');
    assert.deepEqual(refreshed.args, ['serve', '--identity', 'default'], 'il flag non arriva al coordinator');
    fixture.run(undefined, { FRONTALIERE_GH_RC_REFRESH: '1' });
    assert.equal(fixture.rcLoads(), 3);

    const callsBefore = readFileSync(join(fixture.store, 'calls.log'), 'utf8');
    const explicit = fixture.run(undefined, { FRONTALIERE_GH_TOKEN: 'manual-token', FRONTALIERE_GH_WEBHOOK_SECRET: 'manual-secret' });
    assert.equal(explicit.token, 'manual-token');
    assert.equal(fixture.rcLoads(), 3);
    assert.equal(readFileSync(join(fixture.store, 'calls.log'), 'utf8'), callsBefore, 'un override non tocca il portachiavi');

    const nanako = fixture.run(['serve', '--identity', 'nanako']);
    assert.equal(nanako.nanakoToken, 'rc-nanako-token');
    assert.equal(fixture.item('token-nanako').value, 'rc-nanako-token');
    assert.equal(fixture.rcLoads(), 4, 'il token nanako mancava: Remote Config una volta');
    fixture.run(['serve', '--identity', 'nanako']);
    assert.equal(fixture.rcLoads(), 4);
    assert.deepEqual(readdirSync(fixture.store).filter((name) => name.startsWith('test-rc-cache--')).sort(), [
      'test-rc-cache--token-default',
      'test-rc-cache--token-nanako',
      'test-rc-cache--webhook-secret',
    ]);
  } finally {
    fixture.cleanup();
  }
});
