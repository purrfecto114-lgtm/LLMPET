'use strict';

// Codex provider 测试套件 (Round 5: autonomous advancement 2026-07-25)
//
// codex 是 Round 5 新增的 stub provider (providers/codex.js)，对应新版 ChatGPT
// Codex CLI。验证其契约完整性:
//   - provider descriptor 结构 (id / displayName / dirs / hookEvents / stdinShape / capabilities)
//   - parseHookStdin 7 个事件映射 + 边界情况
//   - installHooks / uninstallHooks / markerPresent stub 行为
//   - makeNotImplemented stub 抛 ENOTIMPL (launch / readTranscriptTail / lastAssistantText)
//
// 这套测试保证未来 P11 实现 config.toml hook 安装时, 现有契约不被破坏。

const assert = require('assert');
const path = require('path');
const provider = require('../providers/codex');

// ─── 1. provider descriptor 结构完整性 ─────────────────────────────────────
function test_descriptor_structure() {
  assert.strictEqual(provider.id, 'codex', 'provider.id should be "codex"');
  assert.strictEqual(provider.displayName, 'Codex', 'provider.displayName should be "Codex"');

  // dirs
  assert.ok(provider.dirs, 'provider.dirs should exist');
  assert.ok(provider.dirs.settingsFile.endsWith('config.toml'), 'settingsFile should end with config.toml');
  assert.strictEqual(provider.dirs.settingsFormat, 'toml', 'settingsFormat should be toml');
  assert.ok(provider.dirs.sessionsDir, 'sessionsDir should exist (for future JSONL rollout reader)');

  // hookEvents
  assert.ok(Array.isArray(provider.hookEvents), 'hookEvents should be array');
  assert.deepStrictEqual([...provider.hookEvents], [
    'session_start', 'session_end', 'message_submit',
    'tool_call_before', 'tool_call_after', 'turn_end', 'on_error',
  ], 'hookEvents should match codex.js EVENT_MAP keys');

  // stdinShape
  assert.ok(provider.stdinShape, 'stdinShape should exist');
  assert.ok(Array.isArray(provider.stdinShape.common), 'stdinShape.common should be array');
  assert.ok(provider.stdinShape.perEvent, 'stdinShape.perEvent should exist');

  // capabilities
  assert.ok(provider.capabilities, 'capabilities should exist');
  assert.strictEqual(provider.capabilities.permissionBubble, false, 'codex stub has no permission bubble yet');
  assert.strictEqual(provider.capabilities.metering, false, 'codex stub has no metering yet');
  assert.strictEqual(provider.capabilities.sessionList, false, 'codex stub has no session list yet');
  assert.strictEqual(provider.capabilities.greetSleep, true, 'codex has session_start/session_end hooks');

  console.log('codex descriptor structure: PASS');
}

// ─── 2. parseHookStdin — 7 个事件映射正确 ─────────────────────────────────
function test_parseHookStdin_event_mapping() {
  const sid = 'codex-session-abc123';
  const cwd = '/home/user/myproject';
  const model = 'gpt-5';

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
    assert.strictEqual(body.provider, 'codex', `${c.event}: provider should be codex`);
    assert.strictEqual(body.agentId, 'codex', `${c.event}: agentId should be 'codex' (#r5-fix)`);
    assert.strictEqual(body.event, c.expectedInternal, `${c.event}: event should be ${c.expectedInternal}`);
    assert.strictEqual(body.state, c.expectedState, `${c.event}: state should be ${c.expectedState}`);
    assert.strictEqual(body.session_id, sid, `${c.event}: session_id preserved`);
    assert.strictEqual(body.cwd, cwd, `${c.event}: cwd preserved`);
    assert.strictEqual(body.model, model, `${c.event}: model preserved`);
    assert.strictEqual(body.background_tasks_count, 0, `${c.event}: background_tasks_count default 0`);
    assert.strictEqual(body.session_crons_count, 0, `${c.event}: session_crons_count default 0`);
  }

  console.log('codex parseHookStdin event mapping (7 events): PASS');
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

  console.log('codex parseHookStdin boundaries: PASS');
}

// ─── 4. parseHookStdin — 特殊事件字段 ─────────────────────────────────────
function test_parseHookStdin_special_fields() {
  // session_start → session_source = 'startup'
  const ssBody = provider.parseHookStdin('session_start', { session_id: 's1' });
  assert.strictEqual(ssBody.session_source, 'startup', 'session_start should set session_source=startup');

  // message_submit → user_prompt from text
  const msBody = provider.parseHookStdin('message_submit', { session_id: 's2', text: 'hello world' });
  assert.strictEqual(msBody.user_prompt, 'hello world', 'message_submit should map text → user_prompt');

  // tool_call_before → tool_name
  const tcbBody = provider.parseHookStdin('tool_call_before', { session_id: 's3', tool_name: 'Bash' });
  assert.strictEqual(tcbBody.tool_name, 'Bash', 'tool_call_before should preserve tool_name');

  // turn_end with failed status → state=error, event=StopFailure
  const teBody = provider.parseHookStdin('turn_end', { session_id: 's4', status: 'failed', error: 'OOM' });
  assert.strictEqual(teBody.state, 'error', 'turn_end with failed status → state=error');
  assert.strictEqual(teBody.event, 'StopFailure', 'turn_end with failed status → event=StopFailure');
  assert.strictEqual(teBody.api_error_type, 'OOM', 'turn_end with failed status → api_error_type=error');

  // turn_end with usage → turn_usage
  const teBody2 = provider.parseHookStdin('turn_end', {
    session_id: 's5',
    usage: { input_tokens: 100, output_tokens: 200, prompt_cache_hit_tokens: 50 },
  });
  assert.ok(teBody2.turn_usage, 'turn_end with usage should produce turn_usage');
  assert.strictEqual(teBody2.turn_usage.input, 100, 'turn_usage.input');
  assert.strictEqual(teBody2.turn_usage.output, 200, 'turn_usage.output');
  assert.strictEqual(teBody2.turn_usage.cache_read, 50, 'turn_usage.cache_read');

  // on_error → api_error_type from error
  const oeBody = provider.parseHookStdin('on_error', { session_id: 's6', error: 'rate_limit' });
  assert.strictEqual(oeBody.api_error_type, 'rate_limit', 'on_error should map error → api_error_type');

  // on_error → api_error_type from reason (fallback)
  const oeBody2 = provider.parseHookStdin('on_error', { session_id: 's7', reason: 'timeout' });
  assert.strictEqual(oeBody2.api_error_type, 'timeout', 'on_error should fallback reason → api_error_type');

  console.log('codex parseHookStdin special fields: PASS');
}

// ─── 5. installHooks / uninstallHooks / markerPresent (#p11 实现) ─────────
function test_hook_stubs() {
  // #p11: installHooks now writes ~/.codex/hooks.json + config.toml reference.
  // Isolate HOME so we don't touch the real ~/.codex.
  const fs = require('fs');
  const os = require('os');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-'));
  const origCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpHome, '.codex');

  // installHooks — returns result with added count
  const inst = provider.installHooks();
  assert.ok(inst, 'installHooks should return result');
  assert.ok(inst.added >= 7, `installHooks.added should be >=7 (P11), got ${inst.added}`);
  assert.ok(inst.hooksJsonPath, 'installHooks.hooksJsonPath should be set');

  // markerPresent — should be true after install
  assert.strictEqual(provider.markerPresent(), true, 'markerPresent should be true after install');

  // uninstallHooks — removes our entries
  const uninst = provider.uninstallHooks();
  assert.ok(uninst, 'uninstallHooks should return result');
  assert.ok(uninst.removed >= 7, `uninstallHooks.removed should be >=7, got ${uninst.removed}`);

  // markerPresent — false after uninstall
  assert.strictEqual(provider.markerPresent(), false, 'markerPresent should be false after uninstall');

  // Cleanup
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  if (origCodexHome) process.env.CODEX_HOME = origCodexHome; else delete process.env.CODEX_HOME;

  console.log('codex hook installer (install/uninstall/marker, #p11): PASS');
}

// ─── 6. makeNotImplemented stub 抛 ENOTIMPL ───────────────────────────────
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
    assert.strictEqual(err.provider, 'codex', `${fn}() error.provider should be codex`);
    assert.strictEqual(err.fn, fn, `${fn}() error.fn should be ${fn}`);
    assert.ok(err.message.includes('codex') && err.message.includes(fn),
      `${fn}() error.message should mention codex and ${fn}`);
  }

  console.log('codex makeNotImplemented stubs (launch/readTranscriptTail/lastAssistantText): PASS');
}

// ─── 7. eventToPetState 与 EVENT_MAP 一致性 ──────────────────────────────
function test_event_to_pet_state_consistency() {
  const eventKeys = Object.keys(provider.eventToPetState).sort();
  const hookEventKeys = [...provider.hookEvents].sort();
  assert.deepStrictEqual(eventKeys, hookEventKeys,
    'eventToPetState keys should match hookEvents');

  const knownStates = new Set(['idle', 'thinking', 'working', 'attention', 'sleeping', 'error']);
  for (const [ev, state] of Object.entries(provider.eventToPetState)) {
    assert.ok(knownStates.has(state), `eventToPetState['${ev}'] = '${state}' should be a known pet state`);
  }

  console.log('codex eventToPetState consistency: PASS');
}

// ─── 8. stdinShape.perEvent 与 hookEvents 一致性 ─────────────────────────
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

  console.log('codex stdinShape consistency: PASS');
}

// ─── 9. provider 通过 base.js validateProvider ───────────────────────────
function test_provider_validation() {
  const { validateProvider } = require('../providers/base');
  const errors = validateProvider(provider);
  assert.deepStrictEqual(errors, [], `validateProvider should return no errors, got: ${JSON.stringify(errors)}`);
  console.log('codex validateProvider (base.js contract): PASS');
}

// ─── Run ──────────────────────────────────────────────────────────────────
function main() {
  console.log('=== Codex provider smoke (Round 5) ===\n');
  test_descriptor_structure();
  test_parseHookStdin_event_mapping();
  test_parseHookStdin_boundaries();
  test_parseHookStdin_special_fields();
  test_hook_stubs();
  test_not_implemented_stubs();
  test_event_to_pet_state_consistency();
  test_stdin_shape_consistency();
  test_provider_validation();
  console.log('\n=== ALL PASS ===');
}

main();
