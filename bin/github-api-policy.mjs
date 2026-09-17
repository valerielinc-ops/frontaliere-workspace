#!/usr/bin/env node

/**
 * PreToolUse(Bash) guard.  It blocks the common direct GitHub API/polling
 * forms and points the agent to the shared coordinator.  It deliberately does
 * not try to parse arbitrary shell syntax; the global `gh` shim and the
 * source-level checks cover commands that are not visible as literal calls.
 */

import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { shellExecutableText } from './shell-command-scanner.mjs';

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
  return /(?:^|[;&|()\n]\s*)(?:command\s+)?gh\s+/.test(shellExecutableText(command));
}

function directNetworkCall(command) {
  return /(?:^|[;&|()\n]\s*)(?:command\s+)?(?:curl|wget)\s+[^\n]*(?:api\.github\.com|github\.com\/[^\s]*\/actions)/.test(
    shellExecutableText(command),
  );
}

function ghWatchInvocation(command) {
  const ghPath = '(?:^|[;&|()\\n])\\s*(?:(?:do|then)\\s+)?(?:command\\s+)?(?:[^\\s;&|()]+/)?gh';
  return new RegExp(
    `${ghPath}\\s+(?:pr\\s+checks\\b[^\\n]*--watch|run\\s+watch\\b)`,
  ).test(shellExecutableText(command));
}

const GH_STATUS_COMMAND = '(?:pr\\s+(?:view|checks)\\b|run\\s+view\\b)';

export function pollingGhInvocation(command) {
  const executableText = shellExecutableText(command);
  const ghPath = '(?:^|[;&|()\\n])\\s*(?:(?:do|then)\\s+)?(?:command\\s+)?(?:[^\\s;&|()]+/)?gh';
  const statusInvocation = `${ghPath}\\s+${GH_STATUS_COMMAND}`;

  if (!new RegExp(statusInvocation).test(executableText)) return false;

  const followedBySleep = new RegExp(
    `${statusInvocation}[^\\n]*?(?:[;&|]|\\n)\\s*sleep\\b`,
  ).test(executableText);
  if (followedBySleep) return true;

  const loopPattern = /\b(?:while|until|for)\b[\s\S]*?\bdo\b([\s\S]*?)\bdone\b/g;
  for (const [, loopBody] of executableText.matchAll(loopPattern)) {
    if (new RegExp(`${ghPath}\\s+${GH_STATUS_COMMAND}`).test(loopBody)) return true;
  }

  return false;
}

export function explicitGhApiInvocation(command) {
  return new RegExp(
    '(?:^|[;&|()\\n]\\s*)(?:command\\s+)?[^\\s;&|()]+/gh\\s+'
      + '(?:api|graphql|pr|issue|run|workflow|search|release|repo|project|org|gist|label|auth)\\b',
  ).test(shellExecutableText(command));
}

function isAllowed(command) {
  if (
    directNetworkCall(command)
    || ghWatchInvocation(command)
    || pollingGhInvocation(command)
    || explicitGhApiInvocation(command)
  ) return false;
  return command.includes('bin/gh-frontaliere')
    || command.includes('bin/gh-nanako')
    || command.includes('github-coordinator')
    || (hasPlainGhInvocation(command) && resolvedGhShim());
}

export function containsDirectCall(command) {
  const executableText = shellExecutableText(command);
  const ghPath = '(?:^|[;&|()\\n]\\s*)(?:command\\s+)?(?:[^\\s;&|()]+/)?gh';
  const ghApi = new RegExp(`${ghPath}\\s+(?:api|graphql|pr|issue|run|workflow|search|release|repo|project|org|gist|label|auth)\\b`);
  const trustedPlainGh = hasPlainGhInvocation(command) && resolvedGhShim();
  return directNetworkCall(executableText)
    || ghWatchInvocation(command)
    || pollingGhInvocation(executableText)
    || explicitGhApiInvocation(command)
    || (ghApi.test(executableText) && !trustedPlainGh);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = commandFromStdin();
  if (!command || isAllowed(command) || !containsDirectCall(command)) process.exit(0);

  if (ghWatchInvocation(command)) {
    process.stderr.write(
      'Osservazione GitHub bloccata: non usare `gh pr checks --watch` o `gh run watch`. '
      + 'Usa `bin/gh-frontaliere events subscribe ... && bin/gh-frontaliere events listen <id>`.\n',
    );
  } else if (pollingGhInvocation(command)) {
    process.stderr.write(
      'Polling GitHub bloccato: non ripetere `gh pr view`, `gh run view` o `gh pr checks` '
      + 'in loop o prima di `sleep`; usa `bin/gh-frontaliere events subscribe ... '
      + '&& bin/gh-frontaliere events listen <id>`.\n',
    );
  } else {
    process.stderr.write(
      'GitHub API diretto bloccato dal coordinatore condiviso. '
      + 'Usa `bin/gh-frontaliere ...`.\n',
    );
  }
  process.exit(2);
}
