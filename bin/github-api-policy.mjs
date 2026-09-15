#!/usr/bin/env node

/**
 * PreToolUse(Bash) guard.  It blocks the common direct GitHub API/polling
 * forms and points the agent to the shared coordinator.  It deliberately does
 * not try to parse arbitrary shell syntax; the global `gh` shim and the
 * source-level checks cover commands that are not visible as literal calls.
 */

import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function commandFromStdin() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    return String(payload?.tool_input?.command || '');
  } catch {
    return '';
  }
}

function resolvedGhShim() {
  const expected = new Set([
    join(homedir(), '.local', 'bin', 'gh'),
    join(process.env.WORKSPACE || process.cwd(), 'bin', 'gh'),
  ]);
  for (const directory of String(process.env.PATH || '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, 'gh');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return expected.has(candidate) || dirname(candidate) === join(process.env.WORKSPACE || '', 'bin');
    } catch {
      // Continue through PATH.
    }
  }
  return false;
}

function hasPlainGhInvocation(command) {
  return /(?:^|[;&|()]\s*)(?:command\s+)?gh\s+/.test(command);
}

function directNetworkCall(command) {
  return /(?:curl|wget)\s+[^\n]*(?:api\.github\.com|github\.com\/[^\s]*\/actions)/.test(command);
}

function ghWatchInvocation(command) {
  const ghPath = '(?:^|[;&|()]\\s*)(?:command\\s+)?(?:[^\\s;&|()]+/)?gh';
  return new RegExp(`${ghPath}\\s+pr\\s+checks\\b[^\\n]*--watch`).test(command);
}

function explicitGhApiInvocation(command) {
  return new RegExp(
    '(?:^|[;&|()]\\s*)(?:command\\s+)?[^\\s;&|()]+/gh\\s+'
      + '(?:api|graphql|pr|issue|run|workflow|search|release|repo|project|org|gist|label|auth)\\b',
  ).test(command);
}

function isAllowed(command) {
  if (directNetworkCall(command) || ghWatchInvocation(command) || explicitGhApiInvocation(command)) return false;
  return command.includes('bin/gh-frontaliere')
    || command.includes('bin/gh-nanako')
    || command.includes('github-coordinator')
    || (hasPlainGhInvocation(command) && resolvedGhShim());
}

function containsDirectCall(command) {
  const ghPath = '(?:^|[;&|()]\\s*)(?:command\\s+)?(?:[^\\s;&|()]+/)?gh';
  const ghApi = new RegExp(`${ghPath}\\s+(?:api|graphql|pr|issue|run|workflow|search|release|repo|project|org|gist|label|auth)\\b`);
  const trustedPlainGh = hasPlainGhInvocation(command) && resolvedGhShim();
  return directNetworkCall(command)
    || ghWatchInvocation(command)
    || explicitGhApiInvocation(command)
    || (ghApi.test(command) && !trustedPlainGh);
}

const command = commandFromStdin();
if (!command || isAllowed(command) || !containsDirectCall(command)) process.exit(0);

process.stderr.write(
  'GitHub API diretto bloccato dal coordinatore condiviso. '
  + 'Usa `bin/gh-frontaliere ...`; per lo stato PR non usare `--watch`.\n',
);
process.exit(2);
