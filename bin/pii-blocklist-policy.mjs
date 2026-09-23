#!/usr/bin/env node

/**
 * PreToolUse(Bash) guard for the per-clone PII blocklist.
 *
 * A linked worktree stores `.git` as a file, so the literal
 * `.git/info/pii-blocklist.txt` path is not portable.  Git's `rev-parse`
 * path resolver is the one source of truth for both ordinary clones and
 * linked worktrees.  This guard stops the broken form before it can waste a
 * worker turn and verifies that the resolved, untracked file is present.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellExecutableText } from './shell-command-scanner.mjs';

const BLOCKLIST_NAME_RE = /pii-blocklist\.txt/i;
const LITERAL_GIT_INFO_RE = /\.git\/info\/pii-blocklist\.txt/i;
const SCAN_TOOL_RE = /(?:^|[;&|()\n]\s*)(?:command\s+)?(?:git\s+(?:diff|show)|grep|egrep|fgrep|test|stat|cat|awk|sed)\b/i;
const RESOLVER_RE = /\bgit\s+rev-parse\b[^;\n]*--git-path\s+['"]?info\/pii-blocklist\.txt['"]?/i;

export function commandFromStdin(input) {
  try {
    const payload = JSON.parse(input);
    return {
      command: String(payload?.tool_input?.command || ''),
      cwd: typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd(),
    };
  } catch {
    return { command: '', cwd: process.cwd() };
  }
}

export function resolvedBlocklistPath(cwd) {
  try {
    const resolved = execFileSync(
      'git',
      ['rev-parse', '--git-path', 'info/pii-blocklist.txt'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!resolved) return undefined;
    return path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);
  } catch {
    return undefined;
  }
}

export function isPiiBlocklistCommand(command) {
  const raw = String(command || '');
  if (!BLOCKLIST_NAME_RE.test(raw)) return false;

  // A quoted search pattern/documentation string is not a filesystem access.
  // The executable view masks those strings while retaining real arguments.
  const executable = shellExecutableText(raw);
  return LITERAL_GIT_INFO_RE.test(executable) || SCAN_TOOL_RE.test(executable);
}

export function policyResult({ command, cwd }) {
  if (!isPiiBlocklistCommand(command)) return { allowed: true };

  const raw = String(command || '');
  const executable = shellExecutableText(raw);
  if (LITERAL_GIT_INFO_RE.test(executable)) {
    return {
      allowed: false,
      message:
        'PII gate bloccato: `.git/info/pii-blocklist.txt` non è un percorso valido in un linked worktree. '
        + 'Usa `BL="$(git rev-parse --git-path info/pii-blocklist.txt)"` e passa `"$BL"` a grep.',
    };
  }

  if (!RESOLVER_RE.test(raw)) {
    return {
      allowed: false,
      message:
        'PII gate bloccato: risolvi la blocklist con `git rev-parse --git-path info/pii-blocklist.txt`; '
        + 'non indovinare il percorso di `.git`.',
    };
  }

  const blocklist = resolvedBlocklistPath(cwd);
  if (!blocklist || !existsSync(blocklist)) {
    return {
      allowed: false,
      message:
        'PII blocklist assente per questo clone. Verifica il risultato di '
        + '`git rev-parse --git-path info/pii-blocklist.txt` e chiedi al proprietario prima di continuare.',
    };
  }

  return { allowed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, cwd } = commandFromStdin(readFileSync(0, 'utf8'));
  const result = policyResult({ command, cwd });
  if (!result.allowed) {
    process.stderr.write(`${result.message}\n`);
    process.exit(2);
  }
}
