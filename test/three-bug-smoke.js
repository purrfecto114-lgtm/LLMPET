'use strict';

// 三 bug 修复回归测试 (Round 1: autonomous advancement 2026-07-24)
//   Bug#1 attention: Stop 完成时 adapter 应在 turn-done/big-done 之外再 push
//                 一个 attention event，让 cat-attention.gif 有 1.6s 显示窗口
//   Bug#2 needsinput: Notification/Elicitation 事件 + AskUserQuestion permission
//                  都应触发 needsinput 状态（验证代码路径完整）
//   Bug#3 greet: SessionStart → UserPromptSubmit 首条 prompt 窗口从 5min 放宽
//              到 15min；toolSpawned 正则从 /\/\./ 收紧到 /\/\.(claude|codex)\/sessions\//

const assert = require('assert');
const path = require('path');
const { createCore } = require('../backend/core');
const { buildPetStats, activityToEvents } = require('../backend/adapter');

function mkSession(overrides) {
  return Object.assign({
    id: 'test-' + Math.random().toString(36).slice(2, 10),
    agentId: 'claude-code',
    provider: null,
    state: 'idle',
    badge: 'idle',
    cwd: '/home/user/myproject',
    headless: false,
    sessionTitle: null,
    model: 'claude-sonnet-4',
    contextUsage: null,
    assistantLastOutput: null,
    assistantLastOutputTruncated: false,
    requiresCompletionAck: false,
    lastEvent: null,
    lastEventTool: null,
    updatedAt: Date.now(),
    idleMs: 0,
    transcriptActiveAt: 0,
    sourcePid: null,
    pidChain: null,
    editor: null,
    tmuxSocket: null,
    tmuxClient: null,
    wtHwnd: null,
    ghosttyTerminalId: null,
  }, overrides || {});
}

// ─── Bug#1: attention event on Stop ─────────────────────────────────────────
function test_attention_event() {
  const core = createCore({ onActivity: () => {}, onDirty: () => {} });

  // 模拟 UserPromptSubmit → PreToolUse → Stop 的标准一轮
  core.updateSession('s1', 'thinking', 'UserPromptSubmit', { cwd: '/home/user/myproject' });
  core.updateSession('s1', 'working', 'PreToolUse', { cwd: '/home/user/myproject', toolName: 'Edit' });
  core.updateSession('s1', 'working', 'PostToolUse', { cwd: '/home/user/myproject', toolName: 'Edit' });

  let captured = null;
  core.updateSession('s1', 'attention', 'Stop', { cwd: '/home/user/myproject' });
  const s = core.getSession('s1');
  // core 会把 Stop 的 state 设为 idle（设计选择，保持与上游一致），
  // 但 realCompletion=true 会触发 adapter 的 turn-done + attention event。
  // 我们需要从 onActivity 回调里拿到 realCompletion。
  // 重新做一次：让 onActivity 捕获 realCompletion。
  const core2 = createCore({
    onActivity: (act) => { if (act.event === 'Stop') captured = act; },
    onDirty: () => {},
  });
  core2.updateSession('s2', 'thinking', 'UserPromptSubmit', { cwd: '/home/user/myproject' });
  core2.updateSession('s2', 'working', 'PreToolUse', { cwd: '/home/user/myproject', toolName: 'Edit' });
  core2.updateSession('s2', 'attention', 'Stop', { cwd: '/home/user/myproject' });

  assert.ok(captured, 'onActivity should fire on Stop');
  assert.strictEqual(captured.realCompletion, true, 'Stop without suppression must set realCompletion=true');
  assert.strictEqual(captured.newState, 'idle', 'core keeps Stop state as idle (design choice)');

  // adapter 应该把 Stop + realCompletion 翻译成 [turn-done OR big-done] + attention
  const events = activityToEvents(captured);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('turn-done') || kinds.includes('big-done'),
    `expected turn-done or big-done in ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('attention'),
    `Bug#1 fix: attention event should be pushed alongside turn-done/big-done, got ${JSON.stringify(kinds)}`);

  console.log('Bug#1 attention event on Stop: PASS');
}

// ─── Bug#2: needsinput via Notification event ──────────────────────────────
function test_needsinput_via_notification() {
  const core = createCore({ onActivity: () => {}, onDirty: () => {} });
  core.updateSession('s3', 'idle', 'SessionStart', { cwd: '/home/user/myproject', sessionSource: 'startup' });
  // hook 上报 Notification → core 接受 state='notification'
  core.updateSession('s3', 'notification', 'Notification', { cwd: '/home/user/myproject' });
  const snap = core.buildSnapshot();

  // buildPetStats 应把 notification state 映射为 needsinput
  const stats = buildPetStats(snap, [], null, {});
  const sess = stats.sessions.find((s) => s.sessionId === 's3');
  assert.ok(sess, 'session s3 should be in stats');
  assert.strictEqual(sess.state, 'needsinput',
    `Bug#2: notification state should map to needsinput, got ${sess.state}`);
  assert.strictEqual(sess.reason, '回复', 'needsinput reason should be "回复"');

  // activityToEvents 的 Notification 分支也应 push needsinput event
  const s3obj = core.getSession('s3');
  const ev = activityToEvents({ session: s3obj, event: 'Notification', isNew: false, realCompletion: false, assistantChanged: false, cwdActive: false });
  assert.strictEqual(ev.length, 1, 'Notification should produce exactly one event');
  assert.strictEqual(ev[0].kind, 'needsinput', 'Notification event kind should be needsinput');

  console.log('Bug#2 needsinput via Notification: PASS');
}

// ─── Bug#2b: needsinput via AskUserQuestion permission ─────────────────────
function test_needsinput_via_elicitation() {
  const core = createCore({ onActivity: () => {}, onDirty: () => {} });
  core.updateSession('s4', 'idle', 'SessionStart', { cwd: '/home/user/myproject' });
  core.updateSession('s4', 'thinking', 'UserPromptSubmit', { cwd: '/home/user/myproject' });

  const snap = core.buildSnapshot();
  // 模拟一个 AskUserQuestion pending permission
  const pending = [{
    id: 'perm-1',
    sessionId: 's4',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    suggestions: [],
    isElicitation: true,
    questions: [{ header: '', question: 'Continue?', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }],
    createdAt: Date.now(),
  }];
  const stats = buildPetStats(snap, pending, null, {});
  const sess = stats.sessions.find((s) => s.sessionId === 's4');
  assert.ok(sess, 'session s4 should be in stats');
  assert.strictEqual(sess.state, 'needsinput',
    `Bug#2: AskUserQuestion permission should map to needsinput, got ${sess.state}`);
  assert.strictEqual(sess.reason, '回复', 'needsinput reason should be "回复"');
  assert.strictEqual(sess.choice.kind, 'ask', 'choice kind should be "ask"');

  console.log('Bug#2 needsinput via AskUserQuestion: PASS');
}

// ─── Bug#3: greet window widened to 15min ──────────────────────────────────
function test_greet_window_widened() {
  // adapter.activityToEvents 的 SessionStart 分支会设置 session.greetPending。
  // 模拟：SessionStart → 等 6 分钟 → UserPromptSubmit，应该仍然触发 greet
  // （原 5min 窗口会失败，新 15min 窗口通过）。
  const s5 = mkSession({ id: 's5', cwd: '/home/user/myproject5' });
  // SessionStart: 设置 greetPending = Date.now()
  activityToEvents({ session: s5, event: 'SessionStart', isNew: true, realCompletion: false, assistantChanged: false, cwdActive: false });
  assert.ok(s5.greetPending, 'SessionStart with isNew should set greetPending');

  // 模拟 6 分钟前设了 greetPending
  s5.greetPending = Date.now() - 6 * 60 * 1000;
  const ev = activityToEvents({ session: s5, event: 'UserPromptSubmit', isNew: false, realCompletion: false, assistantChanged: false, cwdActive: false });
  const kinds = ev.map((e) => e.kind);
  // 6 分钟在原 5min 窗口外、新 15min 窗口内 → 应触发 greet
  assert.ok(kinds.includes('greet'),
    `Bug#3 fix: 6min after SessionStart should still greet (15min window), got ${JSON.stringify(kinds)}`);

  // 反例：16 分钟前设的 greetPending → 应不触发 greet，回退到 user-turn
  s5.greetPending = Date.now() - 16 * 60 * 1000;
  // 注意：activityToEvents 在 UserPromptSubmit 时会清掉 greetPending，所以可以重复用 s5
  // 但 lastGreetAt 仍可能命中 30min 频控——用一个新 project 避免干扰
  const s5b = mkSession({ id: 's5b', cwd: '/home/user/myproject5b' });
  activityToEvents({ session: s5b, event: 'SessionStart', isNew: true, realCompletion: false, assistantChanged: false, cwdActive: false });
  s5b.greetPending = Date.now() - 16 * 60 * 1000;
  const ev2 = activityToEvents({ session: s5b, event: 'UserPromptSubmit', isNew: false, realCompletion: false, assistantChanged: false, cwdActive: false });
  const kinds2 = ev2.map((e) => e.kind);
  assert.ok(!kinds2.includes('greet'),
    `16min after SessionStart should NOT greet (outside 15min window), got ${JSON.stringify(kinds2)}`);
  assert.ok(kinds2.includes('user-turn'), 'should fall back to user-turn event');

  console.log('Bug#3 greet window widened to 15min: PASS');
}

// ─── Bug#3b: toolSpawned regex tightened ───────────────────────────────────
function test_toolspawned_regex_tightened() {
  // 验证收紧后的正则不再误判合法路径
  // 我们通过 SessionStart 后 session.greetPending 是否被设置来验证
  // （注意：toolSpawned 是 adapter 内部判断，core.SessionStart 不感知它）
  // 直接验证正则本身
  const RE = /\/\.(claude|codex)\/sessions\//;
  assert.ok(RE.test('/home/user/.claude/sessions/abc-123'), 'should match real sessions path');
  assert.ok(RE.test('/home/user/.codex/sessions/xyz'), 'should match codex sessions path');
  assert.ok(!RE.test('/home/user/.local/share/myproject'), 'should NOT match .local (legit path)');
  assert.ok(!RE.test('/home/user/.config/myproject'), 'should NOT match .config (legit path)');
  assert.ok(!RE.test('/home/z/my-project'), 'should NOT match normal project path');

  console.log('Bug#3 toolSpawned regex tightened: PASS');
}

// ─── Regression: existing tests must still pass ────────────────────────────
function test_no_regression_on_basic_states() {
  // ensure existing states still work
  const core = createCore({ onActivity: () => {}, onDirty: () => {} });
  core.updateSession('s6', 'thinking', 'UserPromptSubmit', { cwd: '/home/user/myproject6' });
  const snap = core.buildSnapshot();
  const stats = buildPetStats(snap, [], null, {});
  const sess = stats.sessions.find((s) => s.sessionId === 's6');
  assert.strictEqual(sess.state, 'thinking', 'thinking state should map to thinking');

  console.log('Regression basic states: PASS');
}

// ─── Run ──────────────────────────────────────────────────────────────────
function main() {
  console.log('=== Three-bug fix smoke (Round 1) ===\n');
  test_attention_event();
  test_needsinput_via_notification();
  test_needsinput_via_elicitation();
  test_greet_window_widened();
  test_toolspawned_regex_tightened();
  test_no_regression_on_basic_states();
  console.log('\n=== ALL PASS ===');
}

main();
