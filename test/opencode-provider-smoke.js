'use strict';

// OpenCode provider 测试套件 (Round 5: autonomous advancement 2026-07-25)
//
// opencode 是 Round 5 新增的 stub provider (providers/opencode.js)，对应
// SST OpenCode AI coding agent。验证其契约完整性:
//   - provider descriptor 结构 (id / displayName / dirs / hookEvents / stdinShape / capabilities)
//   - parseHookStdin 7 个事件映射 + 边界情况
//   - installHooks / uninstallHooks / markerPresent stub 行为
//   - makeNotImplemented stub 抛 ENOTIMPL (launch / readTranscriptTail / lastAssistantText)
//
// 这套测试保证未来 P12 实现 opencode plugin 安装时, 现有契约不被破坏。

const assert = require('assert');
const path = require('path');
const provider = require('../providers/opencode');

// ─── 1. provider descriptor 结构完整性 ─────────────────────────────────────
function test_descriptor_structure() {
  assert.strictEqual(provider.id, 'opencode', 'provider.id should be "opencode"');
  assert.strictEqual(provider.displayName, 'OpenCode', 'provider.displayName should be "OpenCode"');

  // dirs
  assert.ok(provider.dirs, 'provider.dirs should exist');
  assert.ok(provider.dirs.settingsFile.endsWith('opencode.json'), 'settingsFile should end with opencode.json');
  assert.strictEqual(provider.dirs.settingsFormat, 'json', 'settingsFormat should be json');
  assert.ok(provider.dirs.pluginsDir, 'pluginsDir should exist (for future plugin install)');

  // hookEvents
  assert.ok(Array.isArray(provider.hookEvents), 'hookEvents should be array');
  assert.deepStrictEqual([...provider.hookEvents], [
    'session_start', 'session_end', 'message_submit',
    'tool_call_before', 'tool_call_after', 'turn_end', 'on_error',
  ], 'hookEvents should match opencode.js EVENT_MAP keys');

  // stdinShape
  assert.ok(provider.stdinShape, 'stdinShape should exist');
  assert.ok(Array.isArray(provider.stdinShape.common), 'stdinShape.common should be array');
  assert.ok(provider.stdinShape.perEvent, 'stdinShape.perEvent should exist');

  // capabilities
  assert.ok(provider.capabilities, 'capabilities should exist');
  assert.strictEqual(provider.capabilities.permissionBubble, false, 'opencode stub has no permission bubble yet');
  assert.strictEqual(provider.capabilities.metering, false, 'opencode stub has no metering yet');
  assert.strictEqual(provider.capabilities.sessionList, false, 'opencode stub has no session list yet');
  assert.strictEqual(provider.capabilities.greetSleep, true, 'opencode has session_start/session_end events');

  console.log('opencode descriptor structure: PASS');
}

// ─── 2. parseHookStdin — 7 个事件映射正确 ─────────────────────────────────
function test_parseHookStdin_event_mapping() {
  const sid = 'opencode-session-abc123';
  const cwd = '/home/user/myproject';
  const model = 'claude-sonnet-4-5';

  const cases = [
    { event: 'session_start',    expectedInternal: 'SessionStart',    expectedState: 'idle' },
    { event: 'session_end',      expectedInternal: 'SessionEnd',      expectedState: 'sleeping' },
    { event: 'message_submit',   expectedInternal: 'UserPromptSubmit', expectedState: 'thinking' },
    { event: 'tool_call_before', expectedInternal: 'PreToolUse',      expectedState: 'working' },
    { event: 'tool_call_after',  expectedInternal: 'PostToolUse',     expectedState: 'working' },
    { event: 'turn_end',         expectedInternal: 'Stop',            expectedState: 'attention' },
    { event: 'on_error',         expectedInternal: 'StopFailure',     expectedState: 'error' },
  ];

  for (const c of cases) {
    const body = provider.parseHookStdin(c.event, { session_id: sid, cwd, model });
    assert.ok(body, `parseHookStdin('${c.event}') should return body`);
    assert.strictEqual(body.provider, 'opencode', `${c.event}: provider should be opencode`);
    assert.strictEqual(body.agentId, 'opencode', `${c.event}: agentId should be 'opencode' (#r5-fix)`);
    assert.strictEqual(body.event, c.expectedInternal, `${c.event}: event should be ${c.expectedInternal}`);
    assert.strictEqual(body.state, c.expectedState, `${c.event}: state should be ${c.expectedState}`);
    assert.strictEqual(body.session_id, sid, `${c.event}: session_id preserved`);
    assert.strictEqual(body.cwd, cwd, `${c.event}: cwd preserved`);
    assert.strictEqual(body.model, model, `${c.event}: model preserved`);
    assert.strictEqual(body.background_tasks_count, 0, `${c.event}: background_tasks_count default 0`);
    assert.strictEqual(body.session_crons_count, 0, `${c.event}: session_crons_count default 0`);
  }

  console.log('opencode parseHookStdin event mapping (7 events): PASS');
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

  console.log('opencode parseHookStdin boundaries: PASS');
}

// ─── 4. parseHookStdin — OpenCode 特有: session.id 嵌套 ───────────────────
function test_parseHookStdin_nested_session() {
  // OpenCode SDK 经常把 session 作为嵌套对象传: { session: { id, cwd, ... } }
  // parseHookStdin 应能从 session.id 提取 session_id, 从 session.cwd 提取 cwd
  const body = provider.parseHookStdin('session_start', {
    session: { id: 'nested-sid-123', cwd: '/nested/path' },
  });
  assert.ok(body, 'should return body for nested session payload');
  assert.strictEqual(body.session_id, 'nested-sid-123', 'should extract session_id from session.id');
  assert.strictEqual(body.cwd, '/nested/path', 'should extract cwd from session.cwd');

  console.log('opencode parseHookStdin nested session: PASS');
}

// ─── 5. parseHookStdin — 特殊事件字段 ─────────────────────────────────────
function test_parseHookStdin_special_fields() {
  // session_start → session_source = 'startup'
  const ssBody = provider.parseHookStdin('session_start', { session_id: 's1' });
  assert.strictEqual(ssBody.session_source, 'startup', 'session_start should set session_source=startup');

  // message_submit → user_prompt from text
  const msBody = provider.parseHookStdin('message_submit', { session_id: 's2', text: 'hello opencode' });
  assert.strictEqual(msBody.user_prompt, 'hello opencode', 'message_submit should map text → user_prompt');

  // message_submit → user_prompt from message (fallback)
  const msBody2 = provider.parseHookStdin('message_submit', { session_id: 's2b', message: 'fallback msg' });
  assert.strictEqual(msBody2.user_prompt, 'fallback msg', 'message_submit should fallback message → user_prompt');

  // tool_call_before → tool_name from tool_name
  const tcbBody = provider.parseHookStdin('tool_call_before', { session_id: 's3', tool_name: 'Read' });
  assert.strictEqual(tcbBody.tool_name, 'Read', 'tool_call_before should preserve tool_name');

  // tool_call_before → tool_name from tool.name (nested)
  const tcbBody2 = provider.parseHookStdin('tool_call_before', { session_id: 's3b', tool: { name: 'Write' } });
  assert.strictEqual(tcbBody2.tool_name, 'Write', 'tool_call_before should extract tool_name from tool.name');

  // turn_end with failed status → state=error
  const teBody = provider.parseHookStdin('turn_end', { session_id: 's4', status: 'failed', error: 'crash' });
  assert.strictEqual(teBody.state, 'error', 'turn_end with failed status → state=error');
  assert.strictEqual(teBody.event, 'StopFailure', 'turn_end with failed status → event=StopFailure');
  assert.strictEqual(teBody.api_error_type, 'crash', 'turn_end with failed status → api_error_type=error');

  // turn_end with usage → turn_usage (input/output aliases)
  const teBody2 = provider.parseHookStdin('turn_end', {
    session_id: 's5',
    usage: { input: 50, output: 75 },
  });
  assert.ok(teBody2.turn_usage, 'turn_end with usage should produce turn_usage');
  assert.strictEqual(teBody2.turn_usage.input, 50, 'turn_usage.input (from usage.input)');
  assert.strictEqual(teBody2.turn_usage.output, 75, 'turn_usage.output (from usage.output)');

  // on_error → api_error_type from error
  const oeBody = provider.parseHookStdin('on_error', { session_id: 's6', error: 'conn_refused' });
  assert.strictEqual(oeBody.api_error_type, 'conn_refused', 'on_error should map error → api_error_type');

  console.log('opencode parseHookStdin special fields: PASS');
}

// ─── 6. installHooks / uninstallHooks / markerPresent stub 行为 ──────────
function test_hook_stubs() {
  const inst = provider.installHooks();
  assert.ok(inst, 'installHooks should return result');
  assert.strictEqual(inst.added, 0, 'installHooks.added should be 0 (stub)');
  assert.strictEqual(inst.skipped, true, 'installHooks.skipped should be true (stub)');
  assert.ok(typeof inst.reason === 'string' && inst.reason.length > 0,
    'installHooks.reason should be non-empty string');

  const uninst = provider.uninstallHooks();
  assert.ok(uninst, 'uninstallHooks should return result');
  assert.ok(typeof uninst.reason === 'string' && uninst.reason.length > 0,
    'uninstallHooks.reason should be non-empty string');

  assert.strictEqual(provider.markerPresent(), false, 'markerPresent should be false (stub)');

  console.log('opencode hook stubs (install/uninstall/marker): PASS');
}

// ─── 7. makeNotImplemented stub 抛 ENOTIMPL ───────────────────────────────
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
    assert.strictEqual(err.provider, 'opencode', `${fn}() error.provider should be opencode`);
    assert.strictEqual(err.fn, fn, `${fn}() error.fn should be ${fn}`);
    assert.ok(err.message.includes('opencode') && err.message.includes(fn),
      `${fn}() error.message should mention opencode and ${fn}`);
  }

  console.log('opencode makeNotImplemented stubs (launch/readTranscriptTail/lastAssistantText): PASS');
}

// ─── 8. eventToPetState 与 EVENT_MAP 一致性 ──────────────────────────────
function test_event_to_pet_state_consistency() {
  const eventKeys = Object.keys(provider.eventToPetState).sort();
  const hookEventKeys = [...provider.hookEvents].sort();
  assert.deepStrictEqual(eventKeys, hookEventKeys,
    'eventToPetState keys should match hookEvents');

  const knownStates = new Set(['idle', 'thinking', 'working', 'attention', 'sleeping', 'error']);
  for (const [ev, state] of Object.entries(provider.eventToPetState)) {
    assert.ok(knownStates.has(state), `eventToPetState['${ev}'] = '${state}' should be a known pet state`);
  }

  console.log('opencode eventToPetState consistency: PASS');
}

// ─── 9. stdinShape.perEvent 与 hookEvents 一致性 ─────────────────────────
function test_stdin_shape_consistency() {
  const perEventKeys = Object.keys(provider.stdinShape.perEvent).sort();
  const hookEventKeys = [...provider.hookEvents].sort();
  assert.deepStrictEqual(perEventKeys, hookEventKeys,
    'stdinShape.perEvent keys should match hookEvents');

  // tool_call_before 应该有 tool_name 和 tool 字段 (OpenCode SDK nested)
  assert.ok(provider.stdinShape.perEvent.tool_call_before.includes('tool_name'),
    'tool_call_before should expect tool_name field');
  assert.ok(provider.stdinShape.perEvent.tool_call_before.includes('tool'),
    'tool_call_before should expect tool field (OpenCode nested)');

  // turn_end 应该有 status 和 error 字段
  assert.ok(provider.stdinShape.perEvent.turn_end.includes('status'),
    'turn_end should expect status field');
  assert.ok(provider.stdinShape.perEvent.turn_end.includes('error'),
    'turn_end should expect error field');

  console.log('opencode stdinShape consistency: PASS');
}

// ─── 10. provider 通过 base.js validateProvider ───────────────────────────
function test_provider_validation() {
  const { validateProvider } = require('../providers/base');
  const errors = validateProvider(provider);
  assert.deepStrictEqual(errors, [], `validateProvider should return no errors, got: ${JSON.stringify(errors)}`);
  console.log('opencode validateProvider (base.js contract): PASS');
}

// ─── Run ──────────────────────────────────────────────────────────────────
function main() {
  console.log('=== OpenCode provider smoke (Round 5) ===\n');
  test_descriptor_structure();
  test_parseHookStdin_event_mapping();
  test_parseHookStdin_boundaries();
  test_parseHookStdin_nested_session();
  test_parseHookStdin_special_fields();
  test_hook_stubs();
  test_not_implemented_stubs();
  test_event_to_pet_state_consistency();
  test_stdin_shape_consistency();
  test_provider_validation();
  console.log('\n=== ALL PASS ===');
}

main();
