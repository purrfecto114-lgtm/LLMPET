'use strict';

// Round 8 — codewhale binary smoke test (#r8)
//
// First LLMPET test to exercise the provider code path against a REAL Codewhale
// CLI binary (installed via `npm install -g codewhale`). All previous rounds
// used mock transcripts and stub providers.
//
// Gracefully SKIPs (exit 0) if the codewhale binary is not available, so this
// test is safe to register in run-all.js even on CI environments without
// network access to install the binary.
//
// Tests (11 checks):
//   [1]  findCodeWhale() returns an absolute path or 'codewhale' fallback
//   [2]  codewhale --version exits 0 with stdout matching /^codewhale\s+\d+/
//   [3]  codewhale doctor --json returns valid JSON with version, config_path,
//        legacy_state.{primary_root,legacy_root}
//   [4]  doctor.config_path === provider.dirs.settingsFile (PATH ALIGNMENT)
//   [5]  doctor.legacy_state.primary_root === provider.dirs.dataHome
//   [6]  doctor.legacy_state.legacy_root === provider.dirs.legacyDataHome
//   [7]  parseHookStdin('session_start', {bare-UUID session_id, workspace,
//        mode, model}) → correct body (R2.6 bare UUID, R2.1 SessionStart/idle)
//   [8]  parseHookStdin('turn_end', {...usage, totals, provider, ...}) →
//        extracts metering fields (R2.3: 7 usage fields + context_usage)
//   [9]  parseHookStdin('tool_call_before', {tool_name, tool_input_json}) →
//        correct body (R2.2: env-var event, synthetic payload)
//   [10] parseHookStdin rejects unknown event (returns null)
//   [11] parseHookStdin rejects missing session_id (returns null)
//
// References:
//   - https://www.npmjs.com/package/codewhale (npm launcher → native binary)
//   - https://github.com/Hmbown/CodeWhale/blob/main/docs/INSTALL.md
//   - https://github.com/Hmbown/CodeWhale/blob/main/docs/GUIDE.md (codewhale doctor)

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Graceful SKIP if binary not available ────────────────────────────────────
// This test is registered in test/run-all.js and runs on every CI. If codewhale
// is not installed (no network, restricted env), SKIP with exit 0 rather than
// FAIL — the other 23 test files still validate the provider logic via mocks.
let binaryVersion = null;
try {
  binaryVersion = execFileSync('codewhale', ['--version'], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  console.log('SKIP: codewhale binary not available');
  console.log('      (install with: npm install -g codewhale)');
  console.log('      (this test validates real-binary integration; mock-based');
  console.log('       provider tests in codewhale-provider-security.js still run)');
  process.exit(0);
}

const provider = require('../providers/codewhale');

let failures = 0;
const checks = [];
function check(name, fn) {
  try { fn(); checks.push(['\u2713', name, null]); }
  catch (e) { failures++; checks.push(['\u2717', name, e.message]); }
}

// ── [1] findCodeWhale returns absolute path or 'codewhale' fallback ──────────
const found = provider.findCodeWhale();
check(`findCodeWhale() returns absolute path or fallback (got ${found})`, () => {
  // findCodeWhale returns 'codewhale' (string) as fallback when not found in
  // PATH or common locations. An absolute path means it was discovered.
  // Either is acceptable — the real validation is [2] (binary responds).
  assert.ok(
    path.isAbsolute(found) || found === 'codewhale',
    `expected absolute path or 'codewhale', got ${found}`
  );
});

// ── [2] codewhale --version ──────────────────────────────────────────────────
check(`codewhale --version returns valid version (got ${binaryVersion})`, () => {
  assert.match(binaryVersion, /^codewhale\s+\d+\.\d+\.\d+/);
});

// ── [3] codewhale doctor --json returns valid JSON ───────────────────────────
let doctor = null;
try {
  const raw = execFileSync('codewhale', ['doctor', '--json'], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  doctor = JSON.parse(raw);
} catch {
  // doctor failed — path alignment tests below will report failure
}
check('codewhale doctor --json returns valid JSON', () => {
  assert.ok(doctor, 'doctor --json did not return parseable JSON');
  assert.ok(typeof doctor === 'object');
});
if (doctor) {
  check('doctor has version field', () => {
    assert.ok(typeof doctor.version === 'string' && doctor.version.length > 0);
  });
  check('doctor has config_path field', () => {
    assert.ok(typeof doctor.config_path === 'string' && doctor.config_path.length > 0);
  });
  check('doctor has legacy_state.{primary_root,legacy_root}', () => {
    assert.ok(doctor.legacy_state && typeof doctor.legacy_state === 'object');
    assert.ok(typeof doctor.legacy_state.primary_root === 'string');
    assert.ok(typeof doctor.legacy_state.legacy_root === 'string');
  });

  // ── [4] doctor.config_path === provider.dirs.settingsFile ─────────────────
  // PATH ALIGNMENT: proves LLMPET's config.toml path matches the real Codewhale
  // CLI's expected config location. If this fails, hook installation would
  // write to the wrong file and Codewhale would never invoke the hooks.
  check(`path alignment: doctor.config_path === provider.dirs.settingsFile`, () => {
    assert.strictEqual(doctor.config_path, provider.dirs.settingsFile);
  });

  // ── [5] doctor.legacy_state.primary_root === provider.dirs.dataHome ───────
  check(`path alignment: doctor.primary_root === provider.dirs.dataHome`, () => {
    assert.strictEqual(doctor.legacy_state.primary_root, provider.dirs.dataHome);
  });

  // ── [6] doctor.legacy_state.legacy_root === provider.dirs.legacyDataHome ──
  check(`path alignment: doctor.legacy_root === provider.dirs.legacyDataHome`, () => {
    assert.strictEqual(doctor.legacy_state.legacy_root, provider.dirs.legacyDataHome);
  });
}

// ── [7] parseHookStdin('session_start', ...) ────────────────────────────────
// R2.6: session_id is bare UUID (not sess_ prefixed).
// R2.1: session_start → SessionStart/idle, session_source='startup'.
const SID = '12345678-1234-1234-1234-123456789abc';
const r7 = provider.parseHookStdin('session_start', {
  event: 'session_start',
  session_id: SID,
  workspace: '/tmp/my-project',
  mode: 'agent',
  model: 'deepseek-v4',
});
check('parseHookStdin(session_start) returns correct body', () => {
  assert.ok(r7, 'should return body for known event');
  assert.strictEqual(r7.provider, 'codewhale');
  assert.strictEqual(r7.event, 'SessionStart');
  assert.strictEqual(r7.state, 'idle');
  assert.strictEqual(r7.session_id, SID);
  assert.strictEqual(r7.session_source, 'startup');
  assert.strictEqual(r7.cwd, '/tmp/my-project');
  assert.strictEqual(r7.agent_mode, 'agent');
  assert.strictEqual(r7.model, 'deepseek-v4');
});

// ── [8] parseHookStdin('turn_end', ...) ─────────────────────────────────────
// R2.3: 7 usage fields (input, output, cache_read, cache_create, cache_write,
// reasoning, reasoning_replay) + context_usage from totals.conversation_tokens.
const r8 = provider.parseHookStdin('turn_end', {
  event: 'turn_end',
  session_id: SID,
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    prompt_cache_hit_tokens: 200,
    prompt_cache_miss_tokens: 50,
    prompt_cache_write_tokens: 30,
    reasoning_tokens: 80,
    reasoning_replay_tokens: 10,
  },
  totals: { conversation_tokens: 1800 },
  provider: 'deepseek',
  billing_surface: 'tui',
  turn_id: 'turn-001',
  duration_ms: 4500,
  tool_count: 3,
  status: 'success',
});
check('parseHookStdin(turn_end) extracts metering fields (R2.3)', () => {
  assert.ok(r8, 'should return body');
  assert.strictEqual(r8.event, 'Stop');
  assert.strictEqual(r8.state, 'attention');
  assert.ok(r8.turn_usage, 'should have turn_usage');
  assert.strictEqual(r8.turn_usage.input, 1000);
  assert.strictEqual(r8.turn_usage.output, 500);
  assert.strictEqual(r8.turn_usage.cache_read, 200);
  assert.strictEqual(r8.turn_usage.cache_create, 50);
  assert.strictEqual(r8.turn_usage.cache_write, 30);
  assert.strictEqual(r8.turn_usage.reasoning, 80);
  assert.strictEqual(r8.turn_usage.reasoning_replay, 10);
  assert.ok(r8.context_usage, 'should have context_usage');
  assert.strictEqual(r8.context_usage.used, 1800);
  assert.strictEqual(r8.context_usage.source, 'codewhale');
  assert.strictEqual(r8.billing_provider, 'deepseek');
  assert.strictEqual(r8.billing_surface, 'tui');
  assert.strictEqual(r8.turn_id, 'turn-001');
  assert.strictEqual(r8.turn_duration_ms, 4500);
  assert.strictEqual(r8.tool_count, 3);
});

// ── [9] parseHookStdin('tool_call_before', ...) ─────────────────────────────
// R2.2: tool_call_before uses env vars, not stdin. The hook script assembles a
// synthetic payload from env vars before calling parseHookStdin.
const r9 = provider.parseHookStdin('tool_call_before', {
  event: 'tool_call_before',
  session_id: SID,
  tool_name: 'edit_file',
  tool_input_json: '{"path":"/tmp/f.txt"}',
});
check('parseHookStdin(tool_call_before) extracts tool_name + tool_input_json', () => {
  assert.ok(r9, 'should return body');
  assert.strictEqual(r9.event, 'PreToolUse');
  assert.strictEqual(r9.state, 'working');
  assert.strictEqual(r9.tool_name, 'edit_file');
  assert.strictEqual(r9.tool_input_json, '{"path":"/tmp/f.txt"}');
});

// ── [10] parseHookStdin rejects unknown event ───────────────────────────────
check('parseHookStdin(unknown_event) returns null', () => {
  const r = provider.parseHookStdin('not_a_real_event', { session_id: SID });
  assert.strictEqual(r, null);
});

// ── [11] parseHookStdin rejects missing session_id ──────────────────────────
check('parseHookStdin(missing session_id) returns null', () => {
  const r = provider.parseHookStdin('session_start', { workspace: '/tmp' });
  assert.strictEqual(r, null);
});

// ── Report ───────────────────────────────────────────────────────────────────
for (const [mark, name, msg] of checks) {
  console.log(`  ${mark} ${name}${msg ? '\n      ' + msg : ''}`);
}
const total = checks.length;
console.log(`\ncodewhale-binary-smoke: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${total} checks, binary ${binaryVersion})`);
process.exit(failures === 0 ? 0 : 1);
