'use strict';

// Round 18 — Aider notification bridge installer test (#p21)
//
// Verifies that the Aider hook installer:
//   1. Creates ~/.aider.conf.yml with notifications_command + notifications: true
//   2. notifications_command contains the marker + node + script path
//   3. Idempotent: re-running doesn't duplicate
//   4. Preserves other YAML keys
//   5. Does NOT overwrite non-octopus notifications_command (collision)
//   6. uninstallHooks removes only our line
//   7. markerPresent() detects our line
//   8. File permissions 0o600
//   9. aider-hook.js bridge script exists + has correct logic

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-p21-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const aider = require('../providers/aider');
const aiderHooks = require('../backend/aider-hooks');

const configPath = path.join(TMP_HOME, '.aider.conf.yml');

// [T1] installHooks returns result with added=1
const r1 = aider.installHooks();
assert.ok(r1.added >= 1, `should add 1, got ${r1.added}`);
assert.strictEqual(r1.configPath, configPath);
passed++;
console.log(`  [T1] installHooks added ${r1.added} entry`);

// [T2] config file exists
assert.ok(fs.existsSync(configPath), 'config file should exist');
passed++;
console.log('  [T2] ~/.aider.conf.yml created');

// [T3] config contains notifications_command with marker
const content = fs.readFileSync(configPath, 'utf8');
assert.ok(content.includes('notifications_command:'), 'should have notifications_command');
assert.ok(content.includes(aiderHooks.MARKER), 'should contain marker');
assert.ok(content.includes('node'), 'should use node prefix');
passed++;
console.log('  [T3] notifications_command contains marker + node');

// [T4] config contains notifications: true
assert.ok(/notifications:\s*true/.test(content), 'should have notifications: true');
passed++;
console.log('  [T4] notifications: true present');

// [T5] Idempotent: re-running doesn't duplicate
const r2 = aider.installHooks();
const content2 = fs.readFileSync(configPath, 'utf8');
const notifCount = (content2.match(/notifications_command:/g) || []).length;
assert.strictEqual(notifCount, 1, `should have exactly 1 notifications_command, got ${notifCount}`);
passed++;
console.log('  [T5] idempotent: no duplicate notifications_command');

// [T6] Preserves other YAML keys
const withExtra = content2 + '\n# my custom config\nmodel: gpt-4\nauto_commits: true\n';
fs.writeFileSync(configPath, withExtra, { mode: 0o600 });
aider.installHooks();
const content3 = fs.readFileSync(configPath, 'utf8');
assert.ok(content3.includes('model: gpt-4'), 'should preserve model key');
assert.ok(content3.includes('auto_commits: true'), 'should preserve auto_commits key');
assert.ok(content3.includes('# my custom config'), 'should preserve comments');
passed++;
console.log('  [T6] preserves other YAML keys + comments');

// [T7] Collision detection: non-octopus notifications_command not overwritten
const withOther = 'notifications_command: "echo other-tool"\nmodel: gpt-4\n';
fs.writeFileSync(configPath, withOther, { mode: 0o600 });
const r3 = aider.installHooks();
assert.strictEqual(r3.collision, true, 'should detect collision');
const content4 = fs.readFileSync(configPath, 'utf8');
assert.ok(content4.includes('echo other-tool'), 'should preserve non-octopus command');
assert.ok(!content4.includes(aiderHooks.MARKER), 'should NOT add our marker');
passed++;
console.log('  [T7] collision detection (preserves non-octopus notifications_command)');

// [T8] markerPresent() = true after clean install
fs.writeFileSync(configPath, '', { mode: 0o600 });
aider.installHooks();
assert.strictEqual(aider.markerPresent(), true, 'markerPresent should be true');
passed++;
console.log('  [T8] markerPresent() = true after install');

// [T9] uninstallHooks removes our line
const ur = aider.uninstallHooks();
assert.ok(ur.removed >= 1, `should remove >=1, got ${ur.removed}`);
const content5 = fs.readFileSync(configPath, 'utf8');
assert.ok(!content5.includes(aiderHooks.MARKER), 'should not contain marker after uninstall');
assert.ok(!/notifications_command/.test(content5), 'should not have notifications_command after uninstall');
passed++;
console.log(`  [T9] uninstallHooks removed ${ur.removed} line`);

// [T10] markerPresent() = false after uninstall
assert.strictEqual(aider.markerPresent(), false, 'markerPresent should be false');
passed++;
console.log('  [T10] markerPresent() = false after uninstall');

// [T11] uninstallHooks preserves other keys
assert.ok(content5.includes('notifications: true'), 'should preserve notifications: true');
passed++;
console.log('  [T11] uninstallHooks preserves other keys');

// [T12] File permissions 0o600 (skip Windows)
if (process.platform !== 'win32') {
  fs.writeFileSync(configPath, '', { mode: 0o600 });
  aider.installHooks();
  const mode = fs.statSync(configPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, `mode should be 0o600, got 0o${mode.toString(8)}`);
}
passed++;
console.log('  [T12] file permissions 0o600');

// [T13] aider-hook.js bridge script exists
const hookScript = aiderHooks.HOOK_SCRIPT;
assert.ok(fs.existsSync(hookScript), `aider-hook.js should exist at ${hookScript}`);
const scriptSrc = fs.readFileSync(hookScript, 'utf8');
assert.ok(scriptSrc.includes('postState'), 'bridge should have postState');
assert.ok(scriptSrc.includes('deriveSessionId'), 'bridge should derive session_id');
assert.ok(scriptSrc.includes('.aider.chat.history.md'), 'bridge should read chat history');
passed++;
console.log('  [T13] aider-hook.js bridge script exists + correct logic');

// [T14] buildCommand produces valid command with forward slashes
const cmd = aiderHooks.buildCommand();
assert.ok(cmd.startsWith('node "'), 'command should start with node "');
assert.ok(cmd.includes('aider-hook.js'), 'should include aider-hook.js');
assert.ok(!cmd.includes('\\'), 'should use forward slashes');
passed++;
console.log('  [T14] buildCommand produces valid cross-platform command');

// [T15] Bridge _deriveSessionId is stable per path
const { _deriveSessionId } = require('../hook/aider-hook.js');
const sid1 = _deriveSessionId('/tmp/proj-a/.aider.chat.history.md');
const sid2 = _deriveSessionId('/tmp/proj-a/.aider.chat.history.md');
const sid3 = _deriveSessionId('/tmp/proj-b/.aider.chat.history.md');
assert.ok(sid1, 'should return a session id');
assert.strictEqual(sid1, sid2, 'same path should give same id');
assert.notStrictEqual(sid1, sid3, 'different paths should give different ids');
assert.ok(sid1.startsWith('aider-'), 'should start with aider-');
passed++;
console.log('  [T15] _deriveSessionId stable per path, unique per project');

// [T16] Bridge _extractLastAssistant extracts last assistant message
const { _extractLastAssistant } = require('../hook/aider-hook.js');
const history = '## user\nhello\n\n## assistant\nfirst reply\n\n## user\nbye\n\n## assistant\nfinal reply\n';
const last = _extractLastAssistant(history);
assert.ok(last && last.includes('final reply'), 'should extract last assistant message');
assert.ok(!last.includes('first reply'), 'should not include earlier messages');
passed++;
console.log('  [T16] _extractLastAssistant extracts last assistant message');

// Cleanup
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

console.log(`\naider-installhooks-test: ALL PASS (${passed} checks)`);
