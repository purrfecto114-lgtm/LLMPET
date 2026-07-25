'use strict';

// Round 4 冒烟测试 (2026-07-25) — 验证 P1 aider agentId 修复
//
// 端到端测试：
//   1. 起 HTTP server (port 41330)
//   2. 模拟 aider provider 事件通过 /state 路由
//   3. 用 core.buildSnapshot() 抓 session 验证 agentId = 'aider'（非 'claude-code'）
//   4. 模拟 claude-code 事件验证不回归（agentId 仍为 'claude-code'）
//   5. 模拟 codewhale 事件验证不回归（agentId 仍为 'codewhale'）

const http = require('http');
const assert = require('assert');
const os = require('os');
const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');

const aider = require('../providers/aider');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

const core = createCore({
  onActivity: () => {},
  onDirty: () => {},
});
const permissions = createPermissions({
  onAdded: () => {},
  onChange: () => {},
});
const server = createServer({
  core, permissions,
  shouldDropForDnd: () => false,
  transcriptRoots: [os.tmpdir()],
});

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: server.getPort(), path: '/state', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-octopus-token': server.getToken() } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSnapshot() {
  return core.buildSnapshot();
}

async function main() {
  console.log('=== Round 4 Smoke Test — aider agentId fix ===\n');

  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  assert(server.getPort(), 'server failed to bind');
  console.log('server on', server.getPort());

  // ── Test 1: aider session via /state route ──
  console.log('\n[1] aider session: agentId via HTTP routing');
  const aiderSid = 'aider-r4-smoke-001';
  await post({ state: 'idle', event: 'SessionStart', session_id: aiderSid, provider: 'aider', cwd: '/home/user/myproject' });
  await post({ state: 'thinking', event: 'UserPromptSubmit', session_id: aiderSid, provider: 'aider', cwd: '/home/user/myproject' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === aiderSid);
    check('aider session agentId = "aider" (not "claude-code")', () => {
      assert.strictEqual(ses.agentId, 'aider');
    });
    check('aider session provider = "aider"', () => {
      assert.strictEqual(ses.provider, 'aider');
    });
  }

  // ── Test 2: claude-code session (no provider field) ──
  console.log('\n[2] claude-code session: no regression');
  const claudeSid = 'claude-r4-smoke-002';
  await post({ state: 'idle', event: 'SessionStart', session_id: claudeSid, cwd: '/Users/me/proj-cc' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === claudeSid);
    check('claude session agentId = "claude-code" (no provider → default)', () => {
      assert.strictEqual(ses.agentId, 'claude-code');
    });
    check('claude session provider = null', () => {
      assert.strictEqual(ses.provider, null);
    });
  }

  // ── Test 3: codewhale session ──
  console.log('\n[3] codewhale session: no regression');
  const cwSid = 'cw-r4-smoke-003';
  await post({ state: 'idle', event: 'SessionStart', session_id: cwSid, provider: 'codewhale', cwd: '/Users/me/proj-cw' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === cwSid);
    check('codewhale session agentId = "codewhale"', () => {
      assert.strictEqual(ses.agentId, 'codewhale');
    });
    check('codewhale session provider = "codewhale"', () => {
      assert.strictEqual(ses.provider, 'codewhale');
    });
  }

  // ── Test 4: parseHookStdin 直接调用（绕过 server.js） ──
  console.log('\n[4] aider parseHookStdin: agentId in body');
  const body = aider.parseHookStdin('session_start', { session_id: 'aider-direct-004', cwd: '/home/user/proj' });
  check('parseHookStdin body has agentId = "aider"', () => {
    assert.strictEqual(body.agentId, 'aider');
  });

  // ── Test 5: 多事件 aider 生命周期 ──
  console.log('\n[5] aider full lifecycle: all events carry agentId');
  const lifecycleSid = 'aider-lifecycle-005';
  const lifecycleEvents = ['session_start', 'message_submit', 'tool_call_before', 'turn_end', 'session_end'];
  for (const ev of lifecycleEvents) {
    const b = aider.parseHookStdin(ev, { session_id: lifecycleSid, cwd: '/home/user/proj' });
    assert.ok(b, `lifecycle event ${ev} should return body`);
    assert.strictEqual(b.agentId, 'aider', `lifecycle ${ev}: agentId should be 'aider'`);
  }
  check('all 5 lifecycle events have agentId = "aider"', () => true);

  // ── Test 6: snapshot 包含 3 个 provider session ──
  console.log('\n[6] snapshot: 3 provider sessions coexist');
  {
    const snap = getSnapshot();
    check('snapshot has 3 sessions', () => {
      assert.strictEqual(snap.sessions.length, 3);
    });
    const agentIds = snap.sessions.map(s => s.agentId).sort();
    check('agentIds are ["aider", "claude-code", "codewhale"]', () => {
      assert.deepStrictEqual(agentIds, ['aider', 'claude-code', 'codewhale']);
    });
  }

  server.stop();
  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
