#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findWorkspaceRoot,
  formatHuman,
  loadManifest,
  resolvePath,
} from './where-to-fix-lib.mjs';

function extractEditedPaths(payload) {
  const toolInput = payload?.tool_input || {};
  if (typeof toolInput.file_path === 'string') return [toolInput.file_path];
  if (typeof toolInput.command !== 'string') return [];

  return [...toolInput.command.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$/gm)]
    .map((match) => match[1]);
}

function main(payload) {
  let manifest;
  try {
    const workspaceRoot = process.env.WORKSPACE || findWorkspaceRoot(fileURLToPath(import.meta.url));
    manifest = loadManifest({ workspaceRoot });
  } catch {
    // Deliberate fail-open: this is advisory feedback, never a reason to block an edit.
    // A missing corpus checkout or manifest must stay silent so the hook cannot turn
    // an environment problem into a destructive edit gate.
    return;
  }

  const editedPaths = extractEditedPaths(payload);
  const warnings = [];
  for (const editedPath of editedPaths) {
    try {
      const report = resolvePath(editedPath, {
        cwd: payload?.cwd || process.cwd(),
        workspaceRoot: process.env.WORKSPACE || findWorkspaceRoot(fileURLToPath(import.meta.url)),
        index: manifest.index,
      });
      if (!report.repoMatchesFix) warnings.push(formatHuman(report));
    } catch {
      // Path ambiguity is also fail-open: the CLI remains the explicit resolver.
    }
  }

  if (!warnings.length) return;

  const warning = `Controllo advisory: il path sta per essere modificato nel repo sbagliato.\n${warnings.join('\n\n')}`;
  process.stdout.write(JSON.stringify({
    systemMessage: warning,
    hookSpecificOutput: {
      hookEventName: payload?.hook_event_name || 'PreToolUse',
      additionalContext: warning,
    },
  }));
}

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
  main(JSON.parse(input));
} catch {
  // Hook input and manifest failures are intentionally non-blocking.
}
