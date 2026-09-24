import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['.codex/hooks.json', '.claude/settings.json']) {
  test(`${file} collega pre, post, cleanup e cache gate`, () => {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const pre = config.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash');
    const post = config.hooks.PostToolUse.find((entry) => entry.matcher === 'Bash');
    const sessionStart = config.hooks.SessionStart.flatMap((entry) => entry.hooks);
    const sessionEnd = config.hooks.SessionEnd.flatMap((entry) => entry.hooks);
    assert.ok(pre.hooks.some((hook) => hook.command.includes('agent-resource-guard.mjs') && hook.command.includes('--pre')));
    assert.ok(pre.hooks.some((hook) => hook.command.includes('pr-gate-cache.mjs')));
    assert.ok(post.hooks.some((hook) => hook.command.includes('agent-resource-guard.mjs') && hook.command.includes('--post')));
    assert.ok(sessionStart.some((hook) => hook.command.includes('agent-resource-guard.mjs') && hook.command.includes('--cleanup')));
    assert.ok(sessionEnd.some((hook) => hook.command.includes('agent-resource-guard.mjs') && hook.command.includes('--cleanup')));
  });
}
