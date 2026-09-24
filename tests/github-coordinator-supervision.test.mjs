import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  socketEndpointVerdict,
  standbyForCoordinatorOwner,
  supervisedStandbyEnabled,
} from '../bin/github-coordinator.mjs';
import { GitHubEventBroker, workflowSelectorMatchesRun } from '../bin/github-event-broker.mjs';
import { waitForCoordinatorStop } from '../bin/github-coordinator-client.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function startServe(stateDirectory, identity, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'github-coordinator.mjs'), 'serve', '--identity', identity], {
    cwd: ROOT,
    env: {
      ...process.env,
      FRONTALIERE_GH_STATE_DIR: stateDirectory,
      FRONTALIERE_GH_IDENTITY: identity,
      FRONTALIERE_GH_TOKEN: 'test-token-not-real',
      FRONTALIERE_REAL_GH: '/bin/echo',
      FRONTALIERE_GH_WEBHOOK_SECRET: 'supervision-secret',
      FRONTALIERE_GH_SUPERVISED: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderrText = '';
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  child.exited = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  return child;
}

async function waitUntil(predicate, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timeout: ${describe()}`);
}

function ownerPid(stateDirectory, identity) {
  try {
    return JSON.parse(readFileSync(join(stateDirectory, `github-coordinator-${identity}.sock.owner`), 'utf8')).pid;
  } catch {
    return null;
  }
}

// A raw ping: the client helpers auto-start a daemon through the launcher,
// which would load Remote Config and race the process under test.
function pingOk(identity) {
  const socket = join(process.env.FRONTALIERE_GH_STATE_DIR, `github-coordinator-${identity}.sock`);
  return new Promise((resolvePromise) => {
    const connection = createConnection(socket);
    let buffer = '';
    const timer = setTimeout(() => { connection.destroy(); resolvePromise(false); }, 2_000);
    connection.on('connect', () => connection.write(`${JSON.stringify({ type: 'ping' })}\n`));
    connection.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      connection.end();
      try {
        resolvePromise(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))).ok === true);
      } catch {
        resolvePromise(false);
      }
    });
    connection.on('error', () => { clearTimeout(timer); resolvePromise(false); });
  });
}

function withStateDirectory(prefix, body) {
  return async () => {
    const stateDirectory = mkdtempSync(`/tmp/${prefix}-`);
    const previous = process.env.FRONTALIERE_GH_STATE_DIR;
    process.env.FRONTALIERE_GH_STATE_DIR = stateDirectory;
    const children = [];
    try {
      await body(stateDirectory, children);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      if (previous === undefined) delete process.env.FRONTALIERE_GH_STATE_DIR;
      else process.env.FRONTALIERE_GH_STATE_DIR = previous;
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  };
}

test('lo standby supervisionato si attiva solo con FRONTALIERE_GH_SUPERVISED=1', () => {
  assert.equal(supervisedStandbyEnabled({ FRONTALIERE_GH_SUPERVISED: '1' }), true);
  assert.equal(supervisedStandbyEnabled({ FRONTALIERE_GH_SUPERVISED: '' }), false);
  assert.equal(supervisedStandbyEnabled({}), false);
});

test('socketEndpointVerdict distingue endpoint presente, assente e sostituito', () => {
  const socketStat = (ino) => () => ({ ino, isSocket: () => true });
  assert.equal(socketEndpointVerdict('/x', 7, socketStat(7)), 'ok');
  assert.equal(socketEndpointVerdict('/x', 7, socketStat(8)), 'replaced');
  assert.equal(socketEndpointVerdict('/x', 7, () => ({ ino: 7, isSocket: () => false })), 'replaced');
  assert.equal(socketEndpointVerdict('/x', 7, () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  }), 'missing');
  // A transient stat failure other than ENOENT must not take the daemon down.
  assert.equal(socketEndpointVerdict('/x', 7, () => {
    throw Object.assign(new Error('busy'), { code: 'EIO' });
  }), 'ok');
});

test('standbyForCoordinatorOwner attende e subentra una sola volta', async () => {
  let attempts = 0;
  const claimed = [];
  const lines = [];
  const standby = standbyForCoordinatorOwner({
    identity: 'unit',
    socket: '/nonexistent/unit.sock',
    lockPath: '/nonexistent/unit.sock.owner',
    pollMs: 10,
    claim: () => {
      attempts += 1;
      if (attempts === 2) throw new Error('transient');
      return attempts >= 4 ? { fd: -1, ownerId: 'lock' } : null;
    },
    onClaimed: (lock) => claimed.push(lock),
    log: (line) => lines.push(line),
    describeOwner: () => null,
  });
  await waitUntil(() => claimed.length === 1, 2_000, () => `attempts=${attempts}`);
  await sleep(50);
  assert.equal(claimed.length, 1);
  assert.equal(attempts, 4);
  assert.equal(standby.isWaiting(), false);
  assert.ok(lines.some((line) => line.includes('standby claim failed: transient')));
  assert.ok(lines.some((line) => line.includes('standby over')));
});

test('workflowSelectorMatchesRun riconosce il nome visualizzato di un run REST', () => {
  const run = { name: 'Deploy to GitHub Pages', path: '.github/workflows/deploy.yml', workflow_id: 42 };
  assert.equal(workflowSelectorMatchesRun(run, 'Deploy to GitHub Pages'), true);
  assert.equal(workflowSelectorMatchesRun(run, 'deploy.yml'), true);
  assert.equal(workflowSelectorMatchesRun(run, 'tests.yml'), false);
});

test('senza supervisione un secondo serve esce subito lasciando il socket al primo', withStateDirectory(
  'frontaliere-coordinator-unsupervised',
  async (stateDirectory, children) => {
    const identity = `unsupervised-${process.pid}`;
    const first = startServe(stateDirectory, identity);
    children.push(first);
    await waitUntil(() => pingOk(identity), 8_000, () => first.stderrText);
    const second = startServe(stateDirectory, identity);
    children.push(second);
    const exit = await Promise.race([second.exited, sleep(5_000).then(() => 'still-running')]);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(ownerPid(stateDirectory, identity), first.pid);
    assert.equal(await pingOk(identity), true);
    first.kill('SIGTERM');
    await first.exited;
  },
));

test('il processo supervisionato resta in standby e subentra quando l owner termina', withStateDirectory(
  'frontaliere-coordinator-standby',
  async (stateDirectory, children) => {
    const identity = `standby-${process.pid}`;
    const external = startServe(stateDirectory, identity);
    children.push(external);
    await waitUntil(() => pingOk(identity), 8_000, () => external.stderrText);

    const supervised = startServe(stateDirectory, identity, { FRONTALIERE_GH_SUPERVISED: '1' });
    children.push(supervised);
    await waitUntil(
      () => supervised.stderrText.includes('standby;'),
      5_000,
      () => supervised.stderrText,
    );
    await sleep(2_500);
    assert.equal(supervised.exitCode, null, 'lo standby non deve uscire (niente respawn launchd)');
    assert.equal(ownerPid(stateDirectory, identity), external.pid);
    assert.match(supervised.stderrText, new RegExp(`owned by pid ${external.pid}`));

    external.kill('SIGTERM');
    await external.exited;
    await waitUntil(
      async () => ownerPid(stateDirectory, identity) === supervised.pid && await pingOk(identity),
      10_000,
      () => supervised.stderrText,
    );
    assert.match(supervised.stderrText, /standby over/);

    supervised.kill('SIGTERM');
    assert.deepEqual(await supervised.exited, { code: 0, signal: null });
    assert.equal(existsSync(join(stateDirectory, `github-coordinator-${identity}.sock`)), false);
  },
));

test('uno standby senza lock esce subito su SIGTERM', withStateDirectory(
  'frontaliere-coordinator-standby-term',
  async (stateDirectory, children) => {
    const identity = `standby-term-${process.pid}`;
    const external = startServe(stateDirectory, identity);
    children.push(external);
    await waitUntil(() => pingOk(identity), 8_000, () => external.stderrText);
    const supervised = startServe(stateDirectory, identity, { FRONTALIERE_GH_SUPERVISED: '1' });
    children.push(supervised);
    await waitUntil(() => supervised.stderrText.includes('standby;'), 5_000, () => supervised.stderrText);
    supervised.kill('SIGTERM');
    assert.deepEqual(await supervised.exited, { code: 0, signal: null });
    assert.equal(ownerPid(stateDirectory, identity), external.pid);
    assert.equal(await pingOk(identity), true);
    external.kill('SIGTERM');
    await external.exited;
  },
));

test('un endpoint rimosso o sostituito restituisce l identita a launchd senza toccare il file altrui', withStateDirectory(
  'frontaliere-coordinator-endpoint',
  async (stateDirectory, children) => {
    const identity = `endpoint-${process.pid}`;
    const socket = join(stateDirectory, `github-coordinator-${identity}.sock`);
    const child = startServe(stateDirectory, identity);
    children.push(child);
    await waitUntil(() => pingOk(identity), 8_000, () => child.stderrText);
    unlinkSync(socket);
    writeFileSync(socket, 'placeholder owned by someone else');
    const exit = await Promise.race([child.exited, sleep(12_000).then(() => 'still-running')]);
    assert.deepEqual(exit, { code: 1, signal: null }, child.stderrText);
    assert.match(child.stderrText, /socket_endpoint_lost/);
    assert.equal(readFileSync(socket, 'utf8'), 'placeholder owned by someone else');
    assert.equal(existsSync(`${socket}.owner`), false);
    await waitForCoordinatorStop(identity, 1_000);
  },
));

test('github-coordinator-release riscrive i plist verso la release corrente in dry-run', () => {
  const sandbox = mkdtempSync('/tmp/frontaliere-coordinator-release-');
  try {
    const releaseRoot = join(sandbox, 'release-root');
    const agents = join(sandbox, 'LaunchAgents');
    mkdirSync(join(releaseRoot, 'releases', 'abc123', 'bin'), { recursive: true });
    mkdirSync(agents, { recursive: true });
    symlinkSync('releases/abc123', join(releaseRoot, 'current'));
    const label = 'ch.frontaliere.github-coordinator-default';
    const workspace = spawnSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
    }).stdout.trim().replace(/\/\.git$/, '');
    const plistJson = join(sandbox, 'input.json');
    writeFileSync(plistJson, JSON.stringify({
      Label: label,
      ProgramArguments: [`${workspace}/bin/github-coordinator-launcher`, 'serve', '--identity', 'default'],
      EnvironmentVariables: { HOME: '/Users/example', PATH: '/usr/bin:/bin' },
      KeepAlive: true,
      ThrottleInterval: 10,
    }));
    const convert = spawnSync('plutil', ['-convert', 'xml1', '-o', join(agents, `${label}.plist`), plistJson]);
    if (convert.status !== 0) {
      // plutil is macOS-only; the launchd migration is too.
      return;
    }
    const result = spawnSync(join(ROOT, 'bin', 'github-coordinator-release'), [
      'migrate-launchd', '--dry-run', '--label', label,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FRONTALIERE_GH_RELEASE_ROOT: releaseRoot,
        FRONTALIERE_LAUNCH_AGENTS_DIR: agents,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\+\\s*<string>${releaseRoot}/current/bin/github-coordinator-launcher</string>`));
    assert.match(result.stdout, /\+\s*<key>FRONTALIERE_GH_SUPERVISED<\/key>/);
    assert.match(result.stdout, /\+\s*<key>WORKSPACE<\/key>/);
    // Background clamps the control plane to priority 4: never render it.
    assert.match(result.stdout, /\+\s*<key>ProcessType<\/key>\s*\n\+\s*<string>Interactive<\/string>/);
    assert.doesNotMatch(result.stdout, /\+\s*<string>Background<\/string>/);
    // Dry-run never touches the installed plist.
    const installed = spawnSync('plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', join(agents, `${label}.plist`)], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.equal(installed, `${workspace}/bin/github-coordinator-launcher`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('unsubscribe con agentId stacca solo quell agente da una subscription condivisa', () => {
  const directory = mkdtempSync('/tmp/frontaliere-broker-unsubscribe-');
  try {
    const broker = new GitHubEventBroker({ stateFile: join(directory, 'events.json'), webhookSecret: 'secret' });
    const spec = { repo: 'owner/repo', resource: 'pull_request', number: 7, waitFor: ['merged'], shared: true };
    const first = broker.subscribe({ ...spec, agentId: 'agent-a' });
    const joined = broker.subscribe({ ...spec, agentId: 'agent-b' });
    assert.equal(joined.id, first.id);
    assert.equal(joined.sharedJoin, true);

    const detached = broker.unsubscribe(first.id, { agentId: 'agent-b' });
    assert.equal(detached.removed, false);
    assert.equal(detached.detached, true);
    assert.ok(broker.getSubscriptionRecord(first.id), 'la subscription resta per agent-a');

    const last = broker.unsubscribe(first.id, { agentId: 'agent-a' });
    assert.equal(last.removed, true);
    assert.equal(broker.getSubscriptionRecord(first.id), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('il broker del worker di load non riscrive lo stato migrato', () => {
  const directory = mkdtempSync('/tmp/frontaliere-broker-loader-');
  try {
    const stateFile = join(directory, 'events.json');
    const seed = new GitHubEventBroker({ stateFile, webhookSecret: 'secret' });
    seed.subscribe({ repo: 'owner/repo', resource: 'pull_request', number: 1, waitFor: ['merged'], agentId: 'a' });
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    state.migratedLegacyFiles = ['/legacy/github-events-test.json'];
    writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
    const before = statSync(stateFile).mtimeMs;
    const bytes = readFileSync(stateFile, 'utf8');
    const loaded = new GitHubEventBroker({
      stateFile,
      webhookSecret: null,
      canPersist: () => false,
      deferMigrationPersist: true,
    });
    assert.equal(loaded.state.subscriptions.length, 1);
    assert.equal(statSync(stateFile).mtimeMs, before);
    assert.equal(readFileSync(stateFile, 'utf8'), bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function rawRequest(identity, request, timeoutMs = 5_000) {
  const socket = join(process.env.FRONTALIERE_GH_STATE_DIR, `github-coordinator-${identity}.sock`);
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const connection = createConnection(socket);
    let buffer = '';
    const timer = setTimeout(() => {
      connection.destroy();
      rejectPromise(new Error(`timeout ${request.type}`));
    }, timeoutMs);
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      connection.end();
      const line = buffer.slice(0, buffer.indexOf('\n'));
      resolvePromise({ response: JSON.parse(line), bytes: line.length, ms: Date.now() - started });
    });
    connection.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
  });
}

test('la barriera di readiness degli eventi risponde con lo status compatto', withStateDirectory(
  'frontaliere-coordinator-readiness',
  async (stateDirectory, children) => {
    const identity = `readiness-${process.pid}`;
    const child = startServe(stateDirectory, identity);
    children.push(child);
    await waitUntil(() => pingOk(identity), 8_000, () => child.stderrText);
    const barrier = await rawRequest(identity, { type: 'status', compact: true, waitForEventBroker: true });
    assert.equal(barrier.response.ok, true);
    assert.equal(barrier.response.status.events.webhookSecretConfigured, true);
    assert.equal(barrier.response.status.events.loading, false);
    assert.equal(barrier.response.status.events.subscriptions, undefined);
    const full = await rawRequest(identity, { type: 'status' });
    assert.ok(Array.isArray(full.response.status.events.subscriptions), 'lo status completo resta disponibile');
    child.kill('SIGTERM');
    await child.exited;
  },
));

// Replay of the production backlog: set FRONTALIERE_GH_REPLAY_STATE to a copy
// of github-events-<identity>.json. Skipped when the snapshot is absent.
test('replay: un backlog di produzione non blocca ping e non perde stato', {
  skip: !process.env.FRONTALIERE_GH_REPLAY_STATE,
}, withStateDirectory('frontaliere-coordinator-replay', async (stateDirectory, children) => {
  const identity = `replay-${process.pid}`;
  const stateFile = join(stateDirectory, `github-events-${identity}.json`);
  writeFileSync(stateFile, readFileSync(process.env.FRONTALIERE_GH_REPLAY_STATE));
  const original = JSON.parse(readFileSync(stateFile, 'utf8'));
  const pendingOf = (state) => state.subscriptions.reduce((sum, item) => sum + (item.pending?.length || 0), 0);
  const child = startServe(stateDirectory, identity);
  children.push(child);
  const pings = [];
  const deadline = Date.now() + 20_000;
  let ready = null;
  while (Date.now() < deadline && !ready) {
    try {
      const ping = await rawRequest(identity, { type: 'ping', compact: true }, 3_000);
      pings.push(ping.ms);
      if (ping.response.status.events.loading === false) {
        ready = await rawRequest(identity, { type: 'status', compact: true, waitForEventBroker: true }, 3_000);
      }
    } catch {
      await sleep(20);
    }
  }
  assert.ok(ready, `broker mai pronto: ${child.stderrText}`);
  assert.ok(Math.max(...pings) < 1_000, `ping lenti durante il load: ${pings.join(',')}`);
  assert.ok(ready.bytes < 8_192, `barriera troppo grande: ${ready.bytes} byte`);
  child.kill('SIGTERM');
  assert.deepEqual(await child.exited, { code: 0, signal: null });
  const after = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(after.subscriptions.length, original.subscriptions.length);
  assert.equal(pendingOf(after), pendingOf(original));
  console.log(`replay: ${original.subscriptions.length} subscription, ${pendingOf(original)} pending, `
    + `ping max ${Math.max(...pings)} ms su ${pings.length}, barriera ${ready.bytes} B in ${ready.ms} ms`);
}));
