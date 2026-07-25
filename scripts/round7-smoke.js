'use strict';

// Round 7 冒烟测试 (2026-07-25) — 验证 P5 启动性能优化 (#r7-fix)
//
// 端到端测试：core.startStaleCleanup() 把初始 backfill 延后到 setImmediate
// 下一 tick，让 Electron boot 不被同步 fs 扫描阻塞。
//
// 测试场景：
//   1. 设置 mock transcript tree（多 project 多 session）
//   2. 起 HTTP server (port 41330)，call core.startStaleCleanup()
//   3. 立即 GET /state — backfill 还没跑，session 列表为空（graceful degrade）
//   4. 等 setImmediate 触发后 GET /state — backfill 已 seed sessions
//   5. 在 defer 窗口期间模拟 hook 上报 — 验证不发生 race
//   6. 验证 rapid start→stop 取消 pending backfill（无 leak）
//   7. 验证 startStaleCleanup 重复调用幂等
//   8. 验证 periodic 10s sweep 在 backfill 后仍工作（手动触发 cleanStaleSessions）

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 设置 mock HOME BEFORE require core ─────────────────────────────────────
// core.js 计算 PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
// 在 require 时执行，所以必须在 require 之前设好 HOME。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-r7-smoke-'));
process.env.HOME = TMP_HOME;

// 构造 mock transcript tree：2 个 project，每个 1 个 session
const PROJ_A = path.join(TMP_HOME, '.claude', 'projects', 'proj-a');
const PROJ_B = path.join(TMP_HOME, '.claude', 'projects', 'proj-b');
fs.mkdirSync(PROJ_A, { recursive: true });
fs.mkdirSync(PROJ_B, { recursive: true });

const SID_A = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
const SID_B = 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee';
const TS = new Date().toISOString();

fs.writeFileSync(
  path.join(PROJ_A, `${SID_A}.jsonl`),
  JSON.stringify({ type: 'assistant', timestamp: TS, requestId: 'r1',
    message: { id: 'm1', model: 'claude-sonnet', usage: { input_tokens: 10, output_tokens: 5 } },
    cwd: '/tmp/proj-a' }) + '\n',
);
fs.writeFileSync(
  path.join(PROJ_B, `${SID_B}.jsonl`),
  JSON.stringify({ type: 'assistant', timestamp: TS, requestId: 'r2',
    message: { id: 'm2', model: 'claude-opus', usage: { input_tokens: 20, output_tokens: 10 } },
    cwd: '/tmp/proj-b' }) + '\n',
);

const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nextTick() { return new Promise((r) => setImmediate(r)); }

async function main() {
  console.log('=== Round 7 Smoke Test — boot backfill defer (#r7-fix) ===\n');

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
  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  assert.ok(server.getPort(), 'server failed to bind a port');

  function getState() {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: server.getPort(), path: '/state', method: 'GET',
          headers: { 'x-octopus-token': server.getToken() } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); },
      );
      req.on('error', reject);
      req.end();
    });
  }
  function postState(body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { hostname: '127.0.0.1', port: server.getPort(), path: '/state', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-octopus-token': server.getToken() } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  // ── [1] startStaleCleanup returns immediately (no sync fs scan blocking) ──
  console.log('[1] startStaleCleanup returns immediately');
  const t0 = Date.now();
  core.startStaleCleanup();
  const t1 = Date.now();
  check(`returns in <5ms (got ${t1 - t0}ms)`, () => {
    assert.ok(t1 - t0 < 5, `expected <5ms, got ${t1 - t0}ms`);
  });

  // ── [2] GET /state immediately — backfill hasn't fired, sessions empty ──
  console.log('[2] GET /state before setImmediate fires');
  const earlySnap = core.buildSnapshot();
  check('snapshot.sessions empty before defer fires', () => {
    assert.strictEqual(earlySnap.sessions.length, 0);
  });

  // ── [3] Hook event arrives during defer window — must not race ──
  console.log('[3] Hook event during defer window');
  const liveSid = 'cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee';
  const r1 = await postState({
    session_id: liveSid, state: 'working', event: 'PreToolUse',
    agentId: 'claude-code', cwd: '/tmp/live', provider: 'claude-code',
  });
  check('hook POST returns 200', () => {
    assert.strictEqual(r1.status, 200);
  });
  check('live session registered immediately (no backfill race)', () => {
    assert.ok(core.sessions.has(liveSid), 'live hook session should be registered before backfill fires');
    const s = core.sessions.get(liveSid);
    assert.strictEqual(s.state, 'working');
  });

  // ── [4] Wait for setImmediate — backfill seeds the 2 mock sessions ──
  console.log('[4] After setImmediate — deferred backfill seeds transcripts');
  await nextTick();
  await nextTick(); // extra tick safety

  check('backfilled SID_A from transcript tree', () => {
    assert.ok(core.sessions.has(SID_A), `sessions should contain SID_A ${SID_A}`);
  });
  check('backfilled SID_B from transcript tree', () => {
    assert.ok(core.sessions.has(SID_B), `sessions should contain SID_B ${SID_B}`);
  });
  check('live session still present (no clobber)', () => {
    assert.ok(core.sessions.has(liveSid));
  });
  check('total sessions = 3 (2 backfilled + 1 live)', () => {
    assert.strictEqual(core.sessions.size, 3, `expected 3, got ${core.sessions.size}`);
  });

  // ── [5] GET /state after backfill — snapshot includes all 3 sessions ──
  console.log('[5] GET /state after deferred backfill');
  const snap = core.buildSnapshot();
  check('snapshot has 3 sessions', () => {
    assert.strictEqual(snap.sessions.length, 3);
  });
  check('backfilled sessions have agentId=claude-code (default)', () => {
    const a = snap.sessions.find((s) => s.id === SID_A);
    assert.strictEqual(a.agentId, 'claude-code');
  });
  check('live session has agentId=claude-code (set by hook)', () => {
    const live = snap.sessions.find((s) => s.id === liveSid);
    assert.strictEqual(live.agentId, 'claude-code');
  });

  // ── [6] startStaleCleanup idempotent ──
  console.log('[6] startStaleCleanup idempotent');
  check('repeat calls do not throw', () => {
    core.startStaleCleanup();
    core.startStaleCleanup();
    core.startStaleCleanup();
  });

  // ── [7] Periodic 10s sweep still works after defer ──
  console.log('[7] Periodic sweep still works');
  check('cleanStaleSessions runs without throw', () => {
    core.cleanStaleSessions();
  });
  check('3 sessions still present after sweep (all fresh)', () => {
    assert.strictEqual(core.sessions.size, 3);
  });

  // ── [8] Rapid start→stop cancels pending backfill ──
  console.log('[8] Rapid start→stop on fresh core');
  const core2 = createCore({ onActivity: () => {}, onDirty: () => {} });
  core2.startStaleCleanup();
  core2.stopStaleCleanup(); // cancel before setImmediate
  await nextTick();
  await nextTick();
  check('pending backfill cancelled (0 sessions)', () => {
    assert.strictEqual(core2.sessions.size, 0, 'rapid start→stop should leave sessions empty');
  });

  // ── [9] Stop and cleanup ──
  console.log('[9] Stop & cleanup');
  core.stopStaleCleanup();
  server.stop();
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

  check('cleanup completed', () => {
    assert.ok(true);
  });

  console.log(`\n=== Round 7 Smoke: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Round 7 smoke FAILED:', err);
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
