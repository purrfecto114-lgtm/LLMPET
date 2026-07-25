'use strict';

// Round 12 — Opencode provider installHooks test (#p12)
//
// Verifies that the Opencode plugin installer:
//   1. Creates ~/.config/opencode/plugins/octopus.js
//   2. Plugin file contains the marker
//   3. Plugin exports OctopusPlugin function
//   4. Plugin registers 5 hook events (chat.prompt, tool.execute.before/after, session.idle, chat.abort)
//   5. Idempotent: re-running with same content skips (content hash)
//   6. Re-running with different content updates
//   7. Preserves other plugins in the directory
//   8. uninstallHooks removes only our plugin
//   9. markerPresent() detects our plugin
//  10. File permissions 0o600

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-p12-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.OPENCODE_CONFIG_DIR = path.join(TMP_HOME, '.config', 'opencode');

const opencode = require('../providers/opencode');
const opencodeHooks = require('../backend/opencode-hooks');

const pluginsDir = path.join(process.env.OPENCODE_CONFIG_DIR, 'plugins');
const pluginPath = path.join(pluginsDir, 'octopus.js');

// [T1] installHooks returns result with added=1
const r1 = opencode.installHooks();
assert.ok(r1.added >= 1, `should add 1 plugin, got ${r1.added}`);
assert.strictEqual(r1.pluginPath, pluginPath);
passed++;
console.log(`  [T1] installHooks added ${r1.added} plugin`);

// [T2] plugin file exists
assert.ok(fs.existsSync(pluginPath), 'plugin file should exist');
passed++;
console.log('  [T2] plugin file created');

// [T3] plugin contains marker
const content = fs.readFileSync(pluginPath, 'utf8');
assert.ok(content.includes(opencodeHooks.MARKER), 'plugin should contain marker');
passed++;
console.log('  [T3] plugin contains marker');

// [T4] plugin exports OctopusPlugin function
assert.ok(content.includes('OctopusPlugin'), 'plugin should export OctopusPlugin');
assert.ok(content.includes('module.exports'), 'plugin should use module.exports');
passed++;
console.log('  [T4] plugin exports OctopusPlugin');

// [T5] plugin registers 5 hook events
const hookEvents = ['chat.prompt', 'tool.execute.before', 'tool.execute.after', 'session.idle', 'chat.abort'];
for (const ev of hookEvents) {
  assert.ok(content.includes(`'${ev}'`), `plugin should register hook '${ev}'`);
}
passed++;
console.log(`  [T5] plugin registers ${hookEvents.length} hook events`);

// [T6] plugin uses http to POST (not transport.js)
assert.ok(content.includes("require('http')"), 'plugin should require http');
assert.ok(content.includes('postState'), 'plugin should have postState function');
assert.ok(!content.includes("require('../backend/transport')"), 'plugin should NOT require transport.js (self-contained)');
passed++;
console.log('  [T6] plugin is self-contained (http module, no transport.js)');

// [T7] Idempotent: re-running with same content skips
const r2 = opencode.installHooks();
assert.strictEqual(r2.skipped, 1, `should skip (content unchanged), got skipped=${r2.skipped}`);
assert.strictEqual(r2.added, 0, 'should not add on re-run');
passed++;
console.log('  [T7] idempotent: skip when content unchanged (content hash)');

// [T8] markerPresent() = true
assert.strictEqual(opencode.markerPresent(), true, 'markerPresent should be true');
passed++;
console.log('  [T8] markerPresent() = true after install');

// [T9] Preserves other plugins
const otherPlugin = path.join(pluginsDir, 'other-tool.js');
fs.writeFileSync(otherPlugin, '// other tool plugin\n', { mode: 0o600 });
opencode.installHooks(); // re-run, should not touch other plugin
assert.ok(fs.existsSync(otherPlugin), 'other plugin should still exist');
const otherContent = fs.readFileSync(otherPlugin, 'utf8');
assert.ok(otherContent.includes('other tool'), 'other plugin content preserved');
passed++;
console.log('  [T9] other plugins preserved');

// [T10] Does NOT overwrite non-octopus file at our path (collision detection)
// Temporarily replace our plugin with a non-octopus file
fs.writeFileSync(pluginPath, '// different plugin without marker\n', { mode: 0o600 });
const r3 = opencode.installHooks();
assert.strictEqual(r3.collision, true, 'should detect collision (non-octopus file at our path)');
const afterCollision = fs.readFileSync(pluginPath, 'utf8');
assert.ok(!afterCollision.includes(opencodeHooks.MARKER), 'should NOT overwrite non-octopus file');
passed++;
console.log('  [T10] collision detection (does not overwrite non-octopus file)');

// Restore our plugin for remaining tests
fs.writeFileSync(pluginPath, content, { mode: 0o600 });

// [T11] uninstallHooks removes our plugin
const ur = opencode.uninstallHooks();
assert.strictEqual(ur.removed, 1, `should remove 1 plugin, got ${ur.removed}`);
assert.ok(!fs.existsSync(pluginPath), 'plugin file should be deleted');
passed++;
console.log('  [T11] uninstallHooks removed our plugin');

// [T12] markerPresent() = false after uninstall
assert.strictEqual(opencode.markerPresent(), false, 'markerPresent should be false');
passed++;
console.log('  [T12] markerPresent() = false after uninstall');

// [T13] Other plugin still there after uninstall
assert.ok(fs.existsSync(otherPlugin), 'other plugin should still exist after uninstall');
passed++;
console.log('  [T13] other plugin preserved after uninstall');

// [T14] uninstallHooks does NOT remove non-octopus file at our path
fs.writeFileSync(pluginPath, '// non-octopus file\n', { mode: 0o600 });
const ur2 = opencode.uninstallHooks();
assert.strictEqual(ur2.removed, 0, 'should not remove non-octopus file');
assert.strictEqual(ur2.skipped, true, 'should skip non-octopus file');
assert.ok(fs.existsSync(pluginPath), 'non-octopus file should still exist');
passed++;
console.log('  [T14] uninstallHooks skips non-octopus file');

// [T15] File permissions 0o600 (skip Windows)
if (process.platform !== 'win32') {
  // Re-install and check mode
  fs.unlinkSync(pluginPath);
  opencode.installHooks();
  const mode = fs.statSync(pluginPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, `plugin mode should be 0o600, got 0o${mode.toString(8)}`);
}
passed++;
console.log('  [T15] file permissions 0o600');

// [T16] source plugin template exists in repo
const sourcePlugin = path.join(__dirname, '..', 'hook', 'opencode-plugin.js');
assert.ok(fs.existsSync(sourcePlugin), `source plugin should exist at ${sourcePlugin}`);
passed++;
console.log('  [T16] source plugin template exists in repo');

// Cleanup
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

console.log(`\nopencode-installhooks-test: ALL PASS (${passed} checks)`);
