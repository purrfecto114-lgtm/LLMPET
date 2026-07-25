'use strict';

// Round 17 — Real Aider CLI binary smoke test (#p17)
//
// First test to exercise the LLMPET aider provider against a REAL aider binary
// (installed via `python -m venv ~/.aider-venv && pip install aider-chat`).
//
// Verifies:
//   1. Binary discovery (venv path + PATH fallback)
//   2. --version works
//   3. --help mentions --notifications-command (our integration hook)
//   4. Provider config path alignment (~/.aider.conf.yml, not ~/.aider/.aider.conf.yml)
//   5. parseHookStdin works for synthetic events
//   6. agentId = 'aider' (R4 fix)
//
// Gracefully SKIPs (exit 0) if aider binary is not available.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const aider = require('../providers/aider');

let passed = 0;
let skipped = 0;

// Find aider binary: check venv path first, then PATH
function findAider() {
  // #p17: venv path from provider.dirs.venvBin
  const venvBin = aider.dirs.venvBin;
  if (venvBin && fs.existsSync(venvBin)) {
    try { fs.accessSync(venvBin, fs.constants.X_OK); return venvBin; } catch {}
  }
  // PATH fallback
  try {
    const r = spawnSync('which', ['aider'], { encoding: 'utf8', timeout: 2000 });
    if (r.status === 0) {
      const p = r.stdout.trim().split('\n')[0];
      if (p && fs.existsSync(p)) return p;
    }
  } catch {}
  // Common install locations
  for (const c of [
    '/usr/local/bin/aider',
    '/usr/bin/aider',
    path.join(os.homedir(), '.local', 'bin', 'aider'),
  ]) {
    if (fs.existsSync(c)) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  }
  return null;
}

const AIDER_BIN = findAider();

if (!AIDER_BIN) {
  console.log('aider-binary-smoke: SKIP (aider binary not found)');
  console.log('  To enable: python3 -m venv ~/.aider-venv && source ~/.aider-venv/bin/activate && pip install aider-chat');
  process.exit(0);
}

console.log(`aider-binary-smoke: using binary at ${AIDER_BIN}`);

// [1] Binary is executable
assert.ok(fs.existsSync(AIDER_BIN), 'binary should exist');
passed++;
console.log('  [1] aider binary exists + executable');

// [2] --version returns valid version
const vResult = spawnSync(AIDER_BIN, ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.strictEqual(vResult.status, 0, `aider --version should exit 0, got ${vResult.status}: ${vResult.stderr}`);
const versionOut = (vResult.stdout || '').trim();
assert.ok(/^aider\s+\d+\.\d+/.test(versionOut), `version output should match 'aider X.Y', got: ${versionOut}`);
passed++;
console.log(`  [2] aider --version: ${versionOut}`);

// [3] --help mentions --notifications-command (our integration point)
const hResult = spawnSync(AIDER_BIN, ['--help'], { encoding: 'utf8', timeout: 10000 });
assert.strictEqual(hResult.status, 0, `aider --help should exit 0`);
const helpOut = hResult.stdout || '';
assert.ok(helpOut.includes('--notifications-command'), 'help should mention --notifications-command');
assert.ok(helpOut.includes('--notifications'), 'help should mention --notifications');
passed++;
console.log('  [3] aider --help mentions --notifications-command (integration hook)');

// [4] --help mentions config file location
assert.ok(helpOut.includes('.aider.conf.yml'), 'help should mention .aider.conf.yml');
passed++;
console.log('  [4] aider --help mentions .aider.conf.yml config file');

// [5] Provider config path alignment
// aider searches for .aider.conf.yml in git root, cwd, or HOME.
// Our provider.dirs.settingsFile should be ~/.aider.conf.yml (HOME, not ~/.aider/)
const settingsFile = aider.dirs.settingsFile;
assert.ok(settingsFile.endsWith('.aider.conf.yml'), `settingsFile should end with .aider.conf.yml, got ${settingsFile}`);
// #p17: should be in HOME, not in ~/.aider/ subdirectory
assert.ok(!settingsFile.includes(path.join('.aider', '.aider.conf.yml')),
  `settingsFile should be in HOME (not ~/.aider/), got ${settingsFile}`);
passed++;
console.log(`  [5] settingsFile path aligned: ${settingsFile}`);

// [6] Provider venvBin path
assert.ok(aider.dirs.venvBin, 'venvBin should be defined');
assert.ok(aider.dirs.venvBin.endsWith(path.join('.aider-venv', 'bin', 'aider')),
  `venvBin should end with .aider-venv/bin/aider, got ${aider.dirs.venvBin}`);
passed++;
console.log(`  [6] venvBin path: ${aider.dirs.venvBin}`);

// [7] parseHookStdin — session_start
const body1 = aider.parseHookStdin('session_start', { session_id: 'aider-test-1', cwd: '/tmp/proj', model: 'gpt-4' });
assert.ok(body1, 'session_start should produce body');
assert.strictEqual(body1.agentId, 'aider', 'agentId should be aider (R4 fix)');
assert.strictEqual(body1.provider, 'aider', 'provider should be aider');
assert.strictEqual(body1.event, 'SessionStart', 'event should be SessionStart');
assert.strictEqual(body1.state, 'idle', 'state should be idle');
assert.strictEqual(body1.cwd, '/tmp/proj', 'cwd should be forwarded');
assert.strictEqual(body1.model, 'gpt-4', 'model should be forwarded');
passed++;
console.log('  [7] parseHookStdin(session_start) — agentId=aider (R4 fix)');

// [8] parseHookStdin — turn_end (Stop)
const body2 = aider.parseHookStdin('turn_end', { session_id: 'aider-test-1' });
assert.ok(body2, 'turn_end should produce body');
assert.strictEqual(body2.event, 'Stop', 'event should be Stop');
assert.strictEqual(body2.state, 'attention', 'state should be attention');
passed++;
console.log('  [8] parseHookStdin(turn_end) — Stop/attention');

// [9] parseHookStdin — message_submit (UserPromptSubmit)
const body3 = aider.parseHookStdin('message_submit', { session_id: 'aider-test-1' });
assert.strictEqual(body3.event, 'UserPromptSubmit', 'event should be UserPromptSubmit');
assert.strictEqual(body3.state, 'thinking', 'state should be thinking');
passed++;
console.log('  [9] parseHookStdin(message_submit) — UserPromptSubmit/thinking');

// [10] parseHookStdin — unknown event returns null
const body4 = aider.parseHookStdin('unknown_event', { session_id: 'x' });
assert.strictEqual(body4, null, 'unknown event should return null');
passed++;
console.log('  [10] parseHookStdin(unknown) → null');

// [11] parseHookStdin — missing session_id returns null
const body5 = aider.parseHookStdin('session_start', {});
assert.strictEqual(body5, null, 'missing session_id should return null');
passed++;
console.log('  [11] parseHookStdin(missing session_id) → null');

// [12] --notifications-command accepts a command string (dry-run validation)
// We can't actually run aider interactively, but we verify the flag is accepted
// by checking --help output shows it takes a COMMAND argument.
const notifMatch = helpOut.match(/--notifications-command\s+COMMAND/);
assert.ok(notifMatch, '--notifications-command should take COMMAND argument');
passed++;
console.log('  [12] --notifications-command takes COMMAND argument (integration ready)');

console.log(`\naider-binary-smoke: ALL PASS (${passed} checks, ${skipped} skipped)`);
