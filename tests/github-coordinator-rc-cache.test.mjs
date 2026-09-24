import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheKeyForIdentity,
  persistRemoteConfigCredentials,
  readLaunchdCredentials,
  RC_CACHE_KEYS,
} from '../bin/github-coordinator-rc-cache.mjs';

function fakeLaunchd() {
  const values = new Map();
  const calls = [];
  const exec = (_file, args) => {
    calls.push([...args]);
    if (args[0] === 'print') return '';
    if (args[0] === 'getenv') return values.get(args[1]) || '';
    if (args[0] === 'setenv') {
      values.set(args[1], args[2]);
      return '';
    }
    throw new Error(`unexpected launchctl command: ${args[0]}`);
  };
  return { values, calls, exec };
}

function cacheOptions(fake) {
  return {
    available: true,
    platform: 'darwin',
    userId: 502,
    exec: fake.exec,
  };
}

test('il cache launchd separa default e nanako e non persiste override non RC', () => {
  assert.equal(cacheKeyForIdentity('default'), RC_CACHE_KEYS.defaultToken);
  assert.equal(cacheKeyForIdentity('nanako'), RC_CACHE_KEYS.nanakoToken);
  const fake = fakeLaunchd();

  assert.equal(persistRemoteConfigCredentials('default', {
    FRONTALIERE_GH_TOKEN: 'default-rc-token',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'webhook-rc-secret',
    FRONTALIERE_GH_RC_CACHE_DEFAULT_TOKEN: '1',
    FRONTALIERE_GH_RC_CACHE_WEBHOOK: '1',
  }, cacheOptions(fake)), true);
  assert.equal(persistRemoteConfigCredentials('nanako', {
    FRONTALIERE_GH_TOKEN_NANAKO: 'nanako-rc-token',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'webhook-rc-secret',
    FRONTALIERE_GH_RC_CACHE_NANAKO_TOKEN: '1',
    FRONTALIERE_GH_RC_CACHE_WEBHOOK: '1',
  }, cacheOptions(fake)), true);

  assert.equal(fake.values.get(RC_CACHE_KEYS.defaultToken), 'default-rc-token');
  assert.equal(fake.values.get(RC_CACHE_KEYS.nanakoToken), 'nanako-rc-token');
  assert.equal(fake.values.get(RC_CACHE_KEYS.webhookSecret), 'webhook-rc-secret');
  assert.deepEqual(readLaunchdCredentials('default', cacheOptions(fake)), {
    FRONTALIERE_GH_TOKEN: 'default-rc-token',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'webhook-rc-secret',
  });
  assert.deepEqual(readLaunchdCredentials('nanako', cacheOptions(fake)), {
    FRONTALIERE_GH_TOKEN_NANAKO: 'nanako-rc-token',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'webhook-rc-secret',
  });

  const callsBeforeOverride = fake.calls.length;
  assert.equal(persistRemoteConfigCredentials('default', {
    FRONTALIERE_GH_TOKEN: 'manual-override',
    FRONTALIERE_GH_WEBHOOK_SECRET: 'manual-secret',
  }, cacheOptions(fake)), false);
  assert.equal(fake.calls.length, callsBeforeOverride);
});

test('il cache è disattivato fuori da launchd o con state directory isolata', () => {
  const fake = fakeLaunchd();
  const options = { ...cacheOptions(fake), available: undefined, stateDirectory: '/tmp/test-state' };
  assert.deepEqual(readLaunchdCredentials('default', options), {});
  assert.equal(persistRemoteConfigCredentials('default', {
    FRONTALIERE_GH_TOKEN: 'not-cached',
    FRONTALIERE_GH_RC_CACHE_DEFAULT_TOKEN: '1',
  }, options), false);
  assert.equal(fake.calls.length, 0);
});
