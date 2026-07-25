'use strict';

// Aider provider 测试套件 (Round 3: autonomous advancement 2026-07-25)
//
// aider 是 fork 的 stub provider (providers/aider.js)，验证其契约完整性:
//   - provider descriptor 结构 (id / displayName / dirs / hookEvents / stdinShape / capabilities)
//   - parseHookStdin 5 个事件映射 + 边界情况
//   - installHooks / uninstallHooks / markerPresent stub 行为
//   - makeNotImplemented stub 抛 ENOTIMPL (launch / readTranscriptTail / lastAssistantText)
//
// 这套测试保证未来实现 file-watch bridge 或 --notification-command 时,
// 现有契约不被破坏。

const assert = require('assert');
const path = require('path');
const provider = require('../providers/aider');

// ─── 1. provider descriptor 结构完整性 ─────────────────────────────────────
function test_descriptor_structure() {
  assert.strictEqual(provider.id, 'aider', 'provider.id should be "aider"');
  assert.strictEqual(provider.displayName, 'Aider', 'provider.displayName should be "Aider"');

  // dirs
  assert.ok(provider.dirs, 'provider.dirs should exist');
  assert.ok(provider.dirs.settingsFile.endsWith('.aider.conf.yml'), 'settingsFile should end with .aider.conf.yml');
  assert.strictEqual(provider.dirs.settingsFormat, 'yaml', 'settingsFormat should be yaml');

  // hookEvents
  assert.ok(Array.isArray(provider.hookEvents), 'hookEvents should be array');
  assert.deepStrictEqual([...provider.hookEvents], [
    'session_start', 'message_submit', 'tool_call_before', 'turn_end', 'session_end',
  ], 'hookEvents should match aider.js EVENT_MAP keys');

  // stdinShape
  assert.ok(provider.stdinShape, 'stdinShape should exist');
  assert.ok(Array.isArray(provider.stdinShape.common), 'stdinShape.common should be array');
  assert.ok(provider.stdinShape.perEvent, 'stdinShape.perEvent should exist');

  // capabilities
  assert.ok(provider.capabilities, 'capabilities should exist');
  assert.strictEqual(provider.capabilities.permissionBubble, false, 'aider has no permission bubble');
  assert.strictEqual(provider.capabilities.metering, false, 'aider has no metering');
  assert.strictEqual(provider.capabilities.sessionList, false, 'aider sessions are git-based, not file-based');

  console.log('aider descriptor structure: PASS');
}

// ─── 2. parseHookStdin — 5 个事件映射正确 ─────────────────────────────────
function test_parseHookStdin_event_mapping() {
  const sid = 'aider-session-abc123';
  const cwd = '/home/user/myproject';
  const model = 'gpt-4';

  const cases = [
    { event: 'session_start',    expectedInternal: 'SessionStart',    expectedState: 'idle' },
    { event: 'message_submit',   expectedInternal: 'UserPromptSubmit', expectedState: 'thinking' },
    { event: 'tool_call_before', expectedInternal: 'PreToolUse',      expectedState: 'working' },
    { event: 'turn_end',         expectedInternal: 'Stop',            expectedState: 'attention' },
    { event: 'session_end',      expectedInternal: 'SessionEnd',      expectedState: 'sleeping' },
  ];

  for (const c of cases) {
    const body = provider.parseHookStdin(c.event, { session_id: sid, cwd, model });
    assert.ok(body, `parseHookStdin('${c.event}') should return body`);
    assert.strictEqual(body.provider, 'aider', `${c.event}: provider should be aider`);
    assert.strictEqual(body.event, c.expectedInternal, `${c.event}: event should be ${c.expectedInternal}`);
    assert.strictEqual(body.state, c.expectedState, `${c.event}: state should be ${c.expectedState}`);
    assert.strictEqual(body.session_id, sid, `${c.event}: session_id preserved`);
    assert.strictEqual(body.cwd, cwd, `${c.event}: cwd preserved`);
    assert.strictEqual(body.model, model, `${c.event}: model preserved`);
    assert.strictEqual(body.background_tasks_count, 0, `${c.event}: background_tasks_count default 0`);
    assert.strictEqual(body.session_crons_count, 0, `${c.event}: session_crons_count default 0`);
    // #r4-fix: verify agentId is set to 'aider' (not defaulted to 'claude-code')
    assert.strictEqual(body.agentId, 'aider', `${c.event}: agentId should be 'aider'`);
  }

  console.log('aider parseHookStdin event mapping (5 events): PASS');
}

// ─── 3. parseHookStdin — 边界情况 ─────────────────────────────────────────
function test_parseHookStdin_boundaries() {
  // invalid event → null
  assert.strictEqual(provider.parseHookStdin('invalid_event', { session_id: 's1' }), null,
    'unknown event should return null');

  // missing session_id → null
  assert.strictEqual(provider.parseHookStdin('session_start', {}), null,
    'missing session_id should return null');
  assert.strictEqual(provider.parseHookStdin('session_start', { session_id: '' }), null,
    'empty session_id should return null');
  assert.strictEqual(provider.parseHookStdin('session_start', { session_id: null }), null,
    'null session_id should return null');

  // null/undefined payload → null
  assert.strictEqual(provider.parseHookStdin('session_start', null), null,
    'null payload should return null');
  assert.strictEqual(provider.parseHookStdin('session_start', undefined), null,
    'undefined payload should return null');

  // valid event + valid session_id + no optional fields → still works
  const body = provider.parseHookStdin('turn_end', { session_id: 's2' });
  assert.ok(body, 'minimal valid payload should produce body');
  assert.strictEqual(body.session_id, 's2');
  assert.ok(!('cwd' in body), 'cwd should be absent when not provided');
  assert.ok(!('model' in body), 'model should be absent when not provided');

  console.log('aider parseHookStdin boundaries: PASS');
}

// ─── 4. installHooks / uninstallHooks / markerPresent (#p21 实现) ─────────
function test_hook_stubs() {
  // #p21: installHooks now writes notifications_command to ~/.aider.conf.yml.
  // Isolate HOME so we don't touch the real ~/.aider.conf.yml.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-smoke-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  // installHooks — returns result with added=1
  const inst = provider.installHooks();
  assert.ok(inst, 'installHooks should return result');
  assert.ok(inst.added >= 1, `installHooks.added should be >=1 (P21), got ${inst.added}`);
  assert.ok(inst.configPath, 'installHooks.configPath should be set');

  // markerPresent — true after install
  assert.strictEqual(provider.markerPresent(), true, 'markerPresent should be true after install');

  // uninstallHooks — removes our line
  const uninst = provider.uninstallHooks();
  assert.ok(uninst, 'uninstallHooks should return result');
  assert.ok(uninst.removed >= 1, `uninstallHooks.removed should be >=1, got ${uninst.removed}`);

  // markerPresent — false after uninstall
  assert.strictEqual(provider.markerPresent(), false, 'markerPresent should be false after uninstall');

  // Cleanup
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  process.env.HOME = origHome;
  process.env.USERPROFILE = origHome;

  console.log('aider hook installer (install/uninstall/marker, #p21): PASS');
}

// ─── 5. makeNotImplemented stub 抛 ENOTIMPL ───────────────────────────────
function test_not_implemented_stubs() {
  const stubFns = ['launch', 'readTranscriptTail', 'lastAssistantText'];
  for (const fn of stubFns) {
    assert.strictEqual(typeof provider[fn], 'function', `${fn} should be a function (stub)`);
    let threw = false;
    let err = null;
    try {
      provider[fn]();
    } catch (e) {
      threw = true;
      err = e;
    }
    assert.ok(threw, `${fn}() should throw (makeNotImplemented)`);
    assert.strictEqual(err.code, 'ENOTIMPL', `${fn}() error.code should be ENOTIMPL`);
    assert.strictEqual(err.provider, 'aider', `${fn}() error.provider should be aider`);
    assert.strictEqual(err.fn, fn, `${fn}() error.fn should be ${fn}`);
    assert.ok(err.message.includes('aider') && err.message.includes(fn),
      `${fn}() error.message should mention aider and ${fn}`);
  }

  console.log('aider makeNotImplemented stubs (launch/readTranscriptTail/lastAssistantText): PASS');
}

// ─── 6. eventToPetState 与 EVENT_MAP 一致性 ──────────────────────────────
function test_event_to_pet_state_consistency() {
  // eventToPetState 应包含与 hookEvents 相同的 key
  const eventKeys = Object.keys(provider.eventToPetState).sort();
  const hookEventKeys = [...provider.hookEvents].sort();
  assert.deepStrictEqual(eventKeys, hookEventKeys,
    'eventToPetState keys should match hookEvents');

  // 每个值应在已知 state 集合内
  const knownStates = new Set(['idle', 'thinking', 'working', 'attention', 'sleeping']);
  for (const [ev, state] of Object.entries(provider.eventToPetState)) {
    assert.ok(knownStates.has(state), `eventToPetState['${ev}'] = '${state}' should be a known pet state`);
  }

  console.log('aider eventToPetState consistency: PASS');
}

// ─── 7. stdinShape.perEvent 与 hookEvents 一致性 ─────────────────────────
function test_stdin_shape_consistency() {
  const perEventKeys = Object.keys(provider.stdinShape.perEvent).sort();
  const hookEventKeys = [...provider.hookEvents].sort();
  assert.deepStrictEqual(perEventKeys, hookEventKeys,
    'stdinShape.perEvent keys should match hookEvents');

  // tool_call_before 应该有 tool_name 字段
  assert.ok(provider.stdinShape.perEvent.tool_call_before.includes('tool_name'),
    'tool_call_before should expect tool_name field');

  // turn_end 应该有 status 和 error 字段
  assert.ok(provider.stdinShape.perEvent.turn_end.includes('status'),
    'turn_end should expect status field');
  assert.ok(provider.stdinShape.perEvent.turn_end.includes('error'),
    'turn_end should expect error field');

  console.log('aider stdinShape consistency: PASS');
}

// ─── 8. provider 通过 base.js validateProvider ───────────────────────────
function test_provider_validation() {
  const { validateProvider } = require('../providers/base');
  const errors = validateProvider(provider);
  assert.deepStrictEqual(errors, [], `validateProvider should return no errors, got: ${JSON.stringify(errors)}`);
  console.log('aider validateProvider (base.js contract): PASS');
}

// ─── Run ──────────────────────────────────────────────────────────────────
function main() {
  console.log('=== Aider provider smoke (Round 3) ===\n');
  test_descriptor_structure();
  test_parseHookStdin_event_mapping();
  test_parseHookStdin_boundaries();
  test_hook_stubs();
  test_not_implemented_stubs();
  test_event_to_pet_state_consistency();
  test_stdin_shape_consistency();
  test_provider_validation();
  console.log('\n=== ALL PASS ===');
}

main();
