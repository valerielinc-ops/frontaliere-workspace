import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GH_SLURP_WITH_JQ_MESSAGE,
  GitHubCoordinator,
  ghApiSlurpConflict,
} from '../bin/github-coordinator.mjs';

test('gh api --slurp con --jq o --template e rifiutato come dal gh reale', () => {
  for (const args of [
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '--jq', '.[]'],
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '--jq=.[]'],
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '-q', '.[]'],
    ['api', 'repos/o/r/pulls', '--jq', '.[]', '--paginate', '--slurp'],
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '--template', '{{.}}'],
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '-t', '{{.}}'],
  ]) {
    assert.equal(ghApiSlurpConflict(args), true, args.join(' '));
  }
});

test('--slurp senza formatter, o formatter senza --slurp, passa', () => {
  for (const args of [
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp'],
    ['api', 'repos/o/r/pulls', '--paginate', '--jq', '.[]'],
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '-f', 'note=--jq'],
    ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '-H', 'X-Note: -q'],
    ['pr', 'view', '1', '--jq', '.number'],
  ]) {
    assert.equal(ghApiSlurpConflict(args), false, args.join(' '));
  }
});

test('il coordinatore esce 1 con lo stesso messaggio senza accodare', async () => {
  const coordinator = new GitHubCoordinator({
    identity: 'test-slurp-parity',
    token: 'test-token-not-real',
    realGh: 'gh',
    socket: '/tmp/test-slurp-parity.sock',
  });
  const response = await coordinator.submit({
    type: 'exec',
    args: ['api', 'repos/o/r/pulls', '--paginate', '--slurp', '--jq', '.[0]'],
  });
  assert.equal(response.ok, false);
  assert.equal(response.exitCode, 1);
  assert.equal(response.stderr, `${GH_SLURP_WITH_JQ_MESSAGE}\n`);
  assert.equal(GH_SLURP_WITH_JQ_MESSAGE, 'the `--slurp` option is not supported with `--jq` or `--template`');
  assert.equal(coordinator.queue.length, 0);
});
