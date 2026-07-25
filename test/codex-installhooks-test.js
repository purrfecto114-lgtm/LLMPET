'use strict';

// Round 11 — Codex provider installHooks test (#p11)
//
// Verifies that the Codex hook installer:
//   1. Creates ~/.codex/hooks.json with correct format
//   2. Adds entries for all 7 registered events
//   3. Each entry has command containing the marker + timeoutSec
//   4. Adds `hooks = "./hooks.json"` to config.toml if missing
//   5. Does NOT duplicate config.toml reference on re-run
//   6. Idempotent: re-running installHooks() replaces our entries
//   7. Preserves non-octopus hooks from other tools
//   8. uninstallHooks() removes only our entries
//   9. markerPresent() detects our entries correctly
//  10. Files written with mode 0o600

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;

// Isolate HOME before requiring any module
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p11-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.CODEX_HOME = path.join(TMP_HOME, '.codex');

const codex = require('../providers/codex');
const codexHooks = require('../backend/codex-hooks');

const hooksJsonPath = path.join(process.env.CODEX_HOME, 'hooks.json');
const configTomlPath = path.join(process.env.CODEX_HOME, 'config.toml');

// [T1] installHooks returns a result with added count
const r1 = codex.installHooks();
assert.ok(r1.added >= 7, `should add >=7 events, got ${r1.added}`);
assert.strictEqual(r1.hooksJsonPath, hooksJsonPath);
passed++;
console.log(`  [T1] installHooks added ${r1.added} events`);

// [T2] hooks.json file exists
assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json should exist');
passed++;
console.log('  [T2] hooks.json file created');

// [T3] hooks.json is valid JSON with hooks object
const hj = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
assert.ok(hj.hooks && typeof hj.hooks === 'object', 'hooks.json should have hooks object');
passed++;
console.log('  [T3] hooks.json has valid hooks object');

// [T4] All 7 registered events present
for (const ev of codex.hookEvents) {
  assert.ok(Array.isArray(hj.hooks[ev]), `event ${ev} should be an array`);
  assert.ok(hj.hooks[ev].length >= 1, `event ${ev} should have >=1 entry`);
}
passed++;
console.log(`  [T4] all ${codex.hookEvents.length} events present in hooks.json`);

// [T5] Each entry has command containing marker + timeoutSec
for (const ev of codex.hookEvents) {
  for (const entry of hj.hooks[ev]) {
    assert.ok(typeof entry.command === 'string', `${ev} command should be string`);
    assert.ok(entry.command.includes(codex.hookMarker), `${ev} command should contain marker`);
    assert.ok(entry.command.includes(ev), `${ev} command should contain event name`);
    assert.strictEqual(typeof entry.timeoutSec, 'number', `${ev} timeoutSec should be number`);
  }
}
passed++;
console.log('  [T5] all entries have command (with marker+event) + timeoutSec');

// [T6] config.toml exists with hooks reference
assert.ok(fs.existsSync(configTomlPath), 'config.toml should exist');
const ct = fs.readFileSync(configTomlPath, 'utf8');
assert.ok(/hooks\s*=\s*["']\.?\/?hooks\.json["']/.test(ct), 'config.toml should reference hooks.json');
passed++;
console.log('  [T6] config.toml has hooks = "./hooks.json" reference');

// [T7] Re-running installHooks does NOT duplicate config.toml reference
const r2 = codex.installHooks();
assert.strictEqual(r2.configChanged, false, 'config.toml should not be changed on re-run');
const ct2 = fs.readFileSync(configTomlPath, 'utf8');
const refCount = (ct2.match(/hooks\s*=\s*["']\.?\/?hooks\.json["']/g) || []).length;
assert.strictEqual(refCount, 1, `config.toml should have exactly 1 reference, got ${refCount}`);
passed++;
console.log('  [T7] config.toml reference not duplicated on re-run');

// [T8] Idempotent: re-running doesn't add duplicate entries
const hj2 = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
for (const ev of codex.hookEvents) {
  const ourEntries = hj2.hooks[ev].filter((e) => e.command.includes(codex.hookMarker));
  assert.strictEqual(ourEntries.length, 1, `${ev} should have exactly 1 octopus entry after re-run, got ${ourEntries.length}`);
}
passed++;
console.log('  [T8] idempotent: no duplicate entries after re-run');

// [T9] Preserves non-octopus hooks from other tools
const hj3 = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
hj3.hooks.session_start = hj3.hooks.session_start || [];
hj3.hooks.session_start.push({ command: 'echo other-tool', timeoutSec: 10 });
fs.writeFileSync(hooksJsonPath, JSON.stringify(hj3), { mode: 0o600 });
codex.installHooks();
const hj4 = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
const otherEntries = hj4.hooks.session_start.filter((e) => e.command.includes('other-tool'));
assert.strictEqual(otherEntries.length, 1, 'non-octopus hook should be preserved');
const ourEntries = hj4.hooks.session_start.filter((e) => e.command.includes(codex.hookMarker));
assert.strictEqual(ourEntries.length, 1, 'octopus entry should still be exactly 1');
passed++;
console.log('  [T9] non-octopus hooks preserved on re-install');

// [T10] markerPresent() returns true after install
assert.strictEqual(codex.markerPresent(), true, 'markerPresent should be true after install');
passed++;
console.log('  [T10] markerPresent() = true after install');

// [T11] uninstallHooks removes only our entries
const ur = codex.uninstallHooks();
assert.ok(ur.removed >= 7, `should remove >=7 entries, got ${ur.removed}`);
const hj5 = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
const remainingOur = Object.values(hj5.hooks || {}).flat().filter((e) => e.command && e.command.includes(codex.hookMarker));
assert.strictEqual(remainingOur.length, 0, 'no octopus entries should remain');
const remainingOther = Object.values(hj5.hooks || {}).flat().filter((e) => e.command && e.command.includes('other-tool'));
assert.strictEqual(remainingOther.length, 1, 'non-octopus entry should remain');
passed++;
console.log(`  [T11] uninstallHooks removed ${ur.removed} octopus entries, kept 1 other`);

// [T12] markerPresent() returns false after uninstall
assert.strictEqual(codex.markerPresent(), false, 'markerPresent should be false after uninstall');
passed++;
console.log('  [T12] markerPresent() = false after uninstall');

// [T13] File permissions are 0o600 (skip on Windows)
if (process.platform !== 'win32') {
  const hjMode = fs.statSync(hooksJsonPath).mode & 0o777;
  assert.strictEqual(hjMode, 0o600, `hooks.json mode should be 0o600, got 0o${hjMode.toString(8)}`);
  const ctMode = fs.statSync(configTomlPath).mode & 0o777;
  assert.strictEqual(ctMode, 0o600, `config.toml mode should be 0o600, got 0o${ctMode.toString(8)}`);
}
passed++;
console.log('  [T13] file permissions 0o600 (hooks.json + config.toml)');

// [T14] codex-hook.js bridge script exists
const hookScript = codex.hookScript;
assert.ok(fs.existsSync(hookScript), `codex-hook.js should exist at ${hookScript}`);
const scriptSrc = fs.readFileSync(hookScript, 'utf8');
assert.ok(scriptSrc.includes('transport.postState'), 'hook script should call transport.postState');
assert.ok(scriptSrc.includes('codex.parseHookStdin'), 'hook script should call codex.parseHookStdin');
passed++;
console.log('  [T14] codex-hook.js bridge script exists + correct calls');

// [T15] buildCommand produces valid command with forward slashes
const cmd = codexHooks.buildCommand('session_start');
assert.ok(cmd.startsWith('node "'), 'command should start with node "');
assert.ok(cmd.includes('codex-hook.js'), 'command should include codex-hook.js');
assert.ok(cmd.includes('session_start'), 'command should include event name');
assert.ok(!cmd.includes('\\'), 'command should use forward slashes (no backslash)');
passed++;
console.log('  [T15] buildCommand produces valid cross-platform command');

// Cleanup
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

console.log(`\ncodex-installhooks-test: ALL PASS (${passed} checks)`);
