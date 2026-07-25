'use strict';

// Round 5 冒烟测试 (2026-07-25) — 验证 P2/P3 Codex + Opencode provider stub
//
// 端到端测试：
//   1. 起 HTTP server (port 41330)
//   2. 模拟 codex provider 事件通过 /state 路由，验证 agentId = 'codex'
//   3. 模拟 opencode provider 事件通过 /state 路由，验证 agentId = 'opencode'
//   4. 模拟 claude-code/codewhale/aider 事件验证不回归
//   5. parseHookStdin 直接调用验证 body.agentId
//   6. providers/index.js 注册验证：ALL_IDS 含 codex/opencode
//   7. provider 通过 base.js validateProvider
//   8. snapshot 包含 5 个 provider session 共存

const http = require('http');
const assert = require('assert');
const os = require('os');
const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');

const codex = require('../providers/codex');
const opencode = require('../providers/opencode');
const aider = require('../providers/aider');
const registry = require('../providers');
const { validateProvider } = require('../providers/base');

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
  console.log('=== Round 5 Smoke Test — Codex + Opencode provider stubs ===\n');

  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  assert(server.getPort(), 'server failed to bind');
  console.log('server on', server.getPort());

  // ── Test 1: codex session via /state route ──
  console.log('\n[1] codex session: agentId via HTTP routing');
  const codexSid = 'codex-r5-smoke-001';
  await post({ state: 'idle', event: 'SessionStart', session_id: codexSid, provider: 'codex', cwd: '/home/user/codex-proj' });
  await post({ state: 'thinking', event: 'UserPromptSubmit', session_id: codexSid, provider: 'codex', cwd: '/home/user/codex-proj' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === codexSid);
    check('codex session agentId = "codex" (not "claude-code")', () => {
      assert.strictEqual(ses.agentId, 'codex');
    });
    check('codex session provider = "codex"', () => {
      assert.strictEqual(ses.provider, 'codex');
    });
  }

  // ── Test 2: opencode session via /state route ──
  console.log('\n[2] opencode session: agentId via HTTP routing');
  const ocSid = 'opencode-r5-smoke-002';
  await post({ state: 'idle', event: 'SessionStart', session_id: ocSid, provider: 'opencode', cwd: '/home/user/oc-proj' });
  await post({ state: 'working', event: 'PreToolUse', session_id: ocSid, provider: 'opencode', cwd: '/home/user/oc-proj' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === ocSid);
    check('opencode session agentId = "opencode" (not "claude-code")', () => {
      assert.strictEqual(ses.agentId, 'opencode');
    });
    check('opencode session provider = "opencode"', () => {
      assert.strictEqual(ses.provider, 'opencode');
    });
  }

  // ── Test 3: claude-code session (no provider field) — no regression ──
  console.log('\n[3] claude-code session: no regression');
  const claudeSid = 'claude-r5-smoke-003';
  await post({ state: 'idle', event: 'SessionStart', session_id: claudeSid, cwd: '/Users/me/proj-cc' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === claudeSid);
    check('claude session agentId = "claude-code" (no provider → default)', () => {
      assert.strictEqual(ses.agentId, 'claude-code');
    });
  }

  // ── Test 4: codewhale session — no regression ──
  console.log('\n[4] codewhale session: no regression');
  const cwSid = 'cw-r5-smoke-004';
  await post({ state: 'idle', event: 'SessionStart', session_id: cwSid, provider: 'codewhale', cwd: '/Users/me/proj-cw' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === cwSid);
    check('codewhale session agentId = "codewhale"', () => {
      assert.strictEqual(ses.agentId, 'codewhale');
    });
  }

  // ── Test 5: aider session — no regression ──
  console.log('\n[5] aider session: no regression');
  const aiderSid = 'aider-r5-smoke-005';
  await post({ state: 'idle', event: 'SessionStart', session_id: aiderSid, provider: 'aider', cwd: '/Users/me/proj-aider' });
  {
    const snap = getSnapshot();
    const ses = snap.sessions.find(s => s.id === aiderSid);
    check('aider session agentId = "aider"', () => {
      assert.strictEqual(ses.agentId, 'aider');
    });
  }

  // ── Test 6: parseHookStdin 直接调用验证 body.agentId ──
  console.log('\n[6] parseHookStdin: agentId in body');
  {
    const codexBody = codex.parseHookStdin('session_start', { session_id: 'codex-direct-006', cwd: '/home/user/proj' });
    check('codex parseHookStdin body has agentId = "codex"', () => {
      assert.strictEqual(codexBody.agentId, 'codex');
    });

    const ocBody = opencode.parseHookStdin('session_start', { session_id: 'oc-direct-006b', cwd: '/home/user/proj' });
    check('opencode parseHookStdin body has agentId = "opencode"', () => {
      assert.strictEqual(ocBody.agentId, 'opencode');
    });
  }

  // ── Test 7: 完整生命周期事件 ──
  console.log('\n[7] full lifecycle: all events carry agentId');
  {
    const codexLifecycleSid = 'codex-lc-007';
    const codexEvents = ['session_start', 'message_submit', 'tool_call_before', 'tool_call_after', 'turn_end', 'on_error', 'session_end'];
    for (const ev of codexEvents) {
      const b = codex.parseHookStdin(ev, { session_id: codexLifecycleSid, cwd: '/home/user/proj' });
      assert.ok(b, `codex lifecycle event ${ev} should return body`);
      assert.strictEqual(b.agentId, 'codex', `codex ${ev}: agentId should be 'codex'`);
    }

    const ocLifecycleSid = 'oc-lc-007b';
    const ocEvents = ['session_start', 'message_submit', 'tool_call_before', 'tool_call_after', 'turn_end', 'on_error', 'session_end'];
    for (const ev of ocEvents) {
      const b = opencode.parseHookStdin(ev, { session_id: ocLifecycleSid, cwd: '/home/user/proj' });
      assert.ok(b, `opencode lifecycle event ${ev} should return body`);
      assert.strictEqual(b.agentId, 'opencode', `opencode ${ev}: agentId should be 'opencode'`);
    }
    check('all 7 lifecycle events × 2 providers have correct agentId', () => true);
  }

  // ── Test 8: providers/index.js 注册验证 ──
  console.log('\n[8] providers/index.js registry: codex + opencode registered');
  {
    check('ALL_IDS contains "codex"', () => {
      assert.ok(registry.ALL_IDS.includes('codex'), `ALL_IDS = ${JSON.stringify(registry.ALL_IDS)}`);
    });
    check('ALL_IDS contains "opencode"', () => {
      assert.ok(registry.ALL_IDS.includes('opencode'), `ALL_IDS = ${JSON.stringify(registry.ALL_IDS)}`);
    });
    check('ALL_IDS has 5 providers (claude, codewhale, codex, opencode, aider)', () => {
      assert.strictEqual(registry.ALL_IDS.length, 5);
      assert.deepStrictEqual([...registry.ALL_IDS].sort(), ['aider', 'claude', 'codewhale', 'codex', 'opencode']);
    });
    check('getProvider("codex") returns descriptor', () => {
      const p = registry.getProvider('codex');
      assert.ok(p);
      assert.strictEqual(p.id, 'codex');
    });
    check('getProvider("opencode") returns descriptor', () => {
      const p = registry.getProvider('opencode');
      assert.ok(p);
      assert.strictEqual(p.id, 'opencode');
    });
  }

  // ── Test 9: validateProvider 通过 ──
  console.log('\n[9] validateProvider: both new providers pass contract');
  {
    check('codex validateProvider: no errors', () => {
      assert.deepStrictEqual(validateProvider(codex), []);
    });
    check('opencode validateProvider: no errors', () => {
      assert.deepStrictEqual(validateProvider(opencode), []);
    });
  }

  // ── Test 10: snapshot 包含 5 个 provider session ──
  console.log('\n[10] snapshot: 5 provider sessions coexist');
  {
    const snap = getSnapshot();
    check('snapshot has 5 sessions', () => {
      assert.strictEqual(snap.sessions.length, 5);
    });
    const agentIds = snap.sessions.map(s => s.agentId).sort();
    check('agentIds are [aider, claude-code, codewhale, codex, opencode]', () => {
      assert.deepStrictEqual(agentIds, ['aider', 'claude-code', 'codewhale', 'codex', 'opencode']);
    });
  }

  server.stop();
  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
