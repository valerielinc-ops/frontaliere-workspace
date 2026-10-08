import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MANIFEST } from '../bin/hook-dispatch.mjs';

// Gli hook Bash delle due configurazioni passano da bin/hook-dispatch.mjs: la
// guardia delle risorse e la cache del gate sono cablate nel suo MANIFEST, non
// piu' nei due file. Il cleanup di sessione resta nelle configurazioni.
const runsGuard = (hooks, flag) => hooks.some((hook) => hook.name === 'agent-resource-guard' && hook.args?.includes(flag));

test('il dispatch degli hook Bash esegue la guardia in pre e in post, e la cache del gate', () => {
  assert.ok(runsGuard(MANIFEST['pre-bash'], '--pre'));
  assert.ok(MANIFEST['pre-bash'].some((hook) => hook.name === 'pr-gate-cache'));
  assert.ok(runsGuard(MANIFEST['post-bash'], '--post'));
});

for (const file of ['.codex/hooks.json', '.claude/settings.json']) {
  test(`${file} collega il dispatch in pre e post, e il cleanup della guardia`, () => {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const pre = config.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash');
    const post = config.hooks.PostToolUse.find((entry) => entry.matcher === 'Bash');
    const sessionStart = config.hooks.SessionStart.flatMap((entry) => entry.hooks);
    const sessionEnd = config.hooks.SessionEnd.flatMap((entry) => entry.hooks);
    assert.ok(pre.hooks.some((hook) => hook.command.includes('hook-dispatch.mjs') && hook.command.includes('pre-bash')));
    assert.ok(post.hooks.some((hook) => hook.command.includes('hook-dispatch.mjs') && hook.command.includes('post-bash')));
    assert.ok(sessionStart.some((hook) => hook.command.includes('agent-resource-guard.mjs') && hook.command.includes('--cleanup')));
    assert.ok(sessionEnd.some((hook) => hook.command.includes('agent-resource-guard.mjs') && hook.command.includes('--cleanup')));
  });
}
