'use strict';

// E2E 冒烟：真实 HTTP 请求穿过完整链路。
// 不 mock HTTP —— 起真的 server、发真的请求、验证真的响应字节。
// 覆盖：/state 的 codewhale 事件路由与 usage 回调、/codewhale-permission 的
// 挂起/决策/超时/信任边界、pretool-hook 子进程的 stdin→stdout 协议。

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 隔离 HOME：runtime.json / 计量状态都不碰真实用户目录。
// ⚠️ 必须在任何 backend 模块 require 之前 —— transport.js 在模块加载时
// 就把 RUNTIME_PATH 固化为 os.homedir() 的值，晚干 HOME 会让 runtime
// 写到真实用户目录（这本身就是一次真实踩坑的回归记录）。
// ⚠️ Windows 上 os.homedir() 读的是 USERPROFILE 而非 HOME（Node 文档明示），
// 两个都要覆盖。只改 HOME 在 windows-latest CI 上让本套件确定性全红：
// runtime.json 落进真实用户目录，且第 11 组「LLMPET 不可达」的子进程会
// 读到本测试自己 server 写下的 runtime 记录 —— 危险命令挂起在权限池里
// 无人决策，10s 后被 SIGKILL，exit code ≠ 0。
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // Windows 的 os.homedir() 只认它
process.env.OCTOPUS_ALLOW_MULTI = '1';

const { createServer } = require('../backend/server');
const { createCore } = require('../backend/core');

const root = path.join(__dirname, '..');

// ── 起 server + core ─────────────────────────────────────────────────────────
const events = [];
let core;
function makeCore() {
  const c = createCore({
    onActivity: (act) => events.push(act),
    onDirty: () => {},
  });
  c.startStaleCleanup();
  return c;
}
core = makeCore();

const usageTurns = [];
const permissionsDecided = [];
let onAddedEntry = null;
// 第 13 组计时用：server 处理完 usage POST 的时刻（父进程时钟）。
// ack→exit 口径剥掉子进程 spawn/模块加载成本，Windows runner 上也干净。
let lastUsagePostedAt = 0;

const server = createServer({
  core,
  permissions: { sweepForSessionEvent: () => {}, getPending: () => [] },
  onCodeWhaleUsage: (turn) => { usageTurns.push(turn); lastUsagePostedAt = Date.now(); },
  onPermissionChange: () => {},
  onPermissionAdded: (entry) => { onAddedEntry = entry; },
});
server.start();

// 等 server 就绪（端口扫描 + listening 是异步的）
function waitForPort(ms = 3000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (server.getPort()) return resolve(server.getPort());
      if (Date.now() > deadline) return reject(new Error('server never listened'));
      setTimeout(poll, 50);
    })();
  });
}

function request(port, method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: reqPath, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function runHook(script, args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    // 兜底：钩子最迟 10s 必须退出（正常路径 < 1s）
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000).unref?.();
  });
}

async function main() {
  const port = await waitForPort();
  const token = server.getToken();
  const auth = { 'x-octopus-token': token };
  console.log(`server on :${port}, token ${token ? 'ok' : 'MISSING'}`);

  // ── 1. GET /state 健康检查 + 身份头 ────────────────────────────────────────
  const health = await request(port, 'GET', '/state');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.headers['x-octopus-server'], 'octopus');
  console.log('✓ GET /state 健康检查 + 身份头');

  // ── 2. 无 token 的 /state POST → 403 ──────────────────────────────────────
  const noToken = await request(port, 'POST', '/state', { state: 'idle', event: 'SessionStart', session_id: 's1' });
  assert.strictEqual(noToken.status, 403, `expected 403, got ${noToken.status}`);
  console.log('✓ /state 无 token → 403');

  // ── 3. codewhale 事件路由：agentId 正确入库 ────────────────────────────────
  const ev1 = await request(port, 'POST', '/state', {
    state: 'thinking', event: 'UserPromptSubmit', session_id: 'cw-s1',
    agent_id: 'codewhale', cwd: '/tmp/proj', model: 'deepseek-chat',
  }, auth);
  assert.strictEqual(ev1.status, 200, ev1.body);
  const snap1 = core.buildSnapshot();
  const sess = snap1.sessions.find((s) => s.id === 'cw-s1');
  assert(sess, 'codewhale session missing from snapshot');
  assert.strictEqual(sess.agentId, 'codewhale');
  assert.strictEqual(sess.state, 'thinking');
  // claude 事件不带 agent_id → 仍是 claude-code
  await request(port, 'POST', '/state', { state: 'working', event: 'PreToolUse', session_id: 'cl-s1' }, auth);
  const sessClaude = core.buildSnapshot().sessions.find((s) => s.id === 'cl-s1');
  assert.strictEqual(sessClaude.agentId, 'claude-code');
  console.log('✓ /state agent_id 路由：codewhale/claude-code 各归各位');

  // ── 4. turn_end usage → onCodeWhaleUsage 回调 ──────────────────────────────
  const turnEnd = await request(port, 'POST', '/state', {
    state: 'attention', event: 'Stop', session_id: 'cw-s1', agent_id: 'codewhale',
    model: 'deepseek-chat',
    usage: { input_tokens: 100, output_tokens: 50, prompt_cache_hit_tokens: 20 },
    usage_totals: { input_tokens: 100 },
    turn_id: 'turn-e2e-1', turn_status: 'completed', provider: 'deepseek',
  }, auth);
  assert.strictEqual(turnEnd.status, 200, turnEnd.body);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(usageTurns.length, 1, 'usage callback not fired');
  assert.strictEqual(usageTurns[0].turnId, 'turn-e2e-1');
  assert.strictEqual(usageTurns[0].provider, 'deepseek');
  assert.strictEqual(usageTurns[0].usage.input_tokens, 100);
  // 非 codewhale 的 Stop 不触发回调
  await request(port, 'POST', '/state', { state: 'attention', event: 'Stop', session_id: 'cl-s1' }, auth);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(usageTurns.length, 1);
  console.log('✓ turn_end usage 只走 codewhale 回调，字段完整');

  // ── 5. /codewhale-permission：信任边界 ────────────────────────────────────
  // CodeWhale 的 shell 工具真名是 exec_shell（上游权限规则文档验证）。
  const noTokPerm = await request(port, 'POST', '/codewhale-permission', { session_id: 'cw-s1', tool_name: 'exec_shell', tool_input: { command: 'ls' } });
  assert.strictEqual(noTokPerm.status, 403);
  const badBody = await request(port, 'POST', '/codewhale-permission', { tool_name: 'exec_shell' }, auth);
  assert.strictEqual(badBody.status, 400);
  console.log('✓ /codewhale-permission：无 token 403 / 缺 session_id 400');

  // ── 6. 安全只读命令 → 立即 allow（不挂起）─────────────────────────────────
  const safeReq = await request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'exec_shell', tool_input: { command: 'ls -la /tmp' },
  }, auth);
  assert.strictEqual(safeReq.status, 200);
  assert.strictEqual(JSON.parse(safeReq.body).decision, 'allow');
  // 工具名精确匹配：Claude 时代的 'Bash' 拼写绝不能在 cw 路由上自动放行
  const wrongName = (async () => request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' },
  }, auth))();
  await new Promise((r) => setTimeout(r, 100));
  const wrongPending = server.getCodeWhalePermissions().getPending();
  assert.strictEqual(wrongPending.length, 1, 'claude-era tool name must NOT auto-allow on the cw route');
  server.getCodeWhalePermissions().decide(wrongPending[0].id, 'deny');
  await wrongName;
  console.log('✓ 只读 exec_shell 直接 allow；"Bash" 拼写不误放行（精确匹配）');

  // ── 7. 危险命令 → 挂起 → 用户拒绝 → deny 响应 ────────────────────────────
  const decided = request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'exec_shell', tool_input: { command: 'rm -rf /tmp/important' },
  }, auth);
  await new Promise((r) => setTimeout(r, 100));
  const cwPerms = server.getCodeWhalePermissions();
  const pendingNow = cwPerms.getPending();
  assert.strictEqual(pendingNow.length, 1);
  assert(pendingNow[0].id.startsWith('cw-'));
  assert.strictEqual(pendingNow[0].toolName, 'exec_shell');
  assert.strictEqual(pendingNow[0].agentId, 'codewhale');
  assert(typeof pendingNow[0].expiresAt === 'number' && pendingNow[0].expiresAt > Date.now(), 'expiresAt missing on pending entry');
  assert(onAddedEntry && onAddedEntry.id === pendingNow[0].id, 'onPermissionAdded not fired');
  // 注意：此时响应还没写出 —— 决策后才有
  cwPerms.decide(pendingNow[0].id, 'deny');
  const denied = await decided;
  assert.strictEqual(denied.status, 200);
  assert.strictEqual(denied.headers['x-octopus-server'], 'octopus');
  assert.strictEqual(JSON.parse(denied.body).decision, 'deny');
  assert.ok(JSON.parse(denied.body).reason);
  permissionsDecided.push('deny');
  assert.strictEqual(cwPerms.getPending().length, 0);
  console.log('✓ 挂起→用户拒绝→deny 响应（带身份头）');

  // ── 8. 用户允许 → allow 响应 ──────────────────────────────────────────────
  const allowed = (async () => request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-s1', tool_name: 'write_file', tool_input: { path: '/tmp/x', content: 'y' },
  }, auth))();
  await new Promise((r) => setTimeout(r, 100));
  const p2 = server.getCodeWhalePermissions().getPending()[0];
  server.getCodeWhalePermissions().decide(p2.id, 'allow');
  const allowRes = await allowed;
  assert.strictEqual(JSON.parse(allowRes.body).decision, 'allow');
  console.log('✓ 挂起→用户允许→allow 响应');

  // ── 9. 会话结束 → 挂起请求被清扫为 ask ────────────────────────────────────
  const parked = (async () => request(port, 'POST', '/codewhale-permission', {
    session_id: 'cw-sweep', tool_name: 'exec_shell', tool_input: { command: 'curl example.com' },
  }, auth))();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(server.getCodeWhalePermissions().getPending().length, 1);
  await request(port, 'POST', '/state', {
    state: 'sleeping', event: 'SessionEnd', session_id: 'cw-sweep', agent_id: 'codewhale',
  }, auth);
  const swept = await parked;
  assert.strictEqual(JSON.parse(swept.body).decision, 'ask', `sweep should answer ask, got ${swept.body}`);
  assert.strictEqual(server.getCodeWhalePermissions().getPending().length, 0);
  console.log('✓ SessionEnd 清扫挂起权限 → ask');

  // ── 10. pretool-hook 子进程：真实 stdin→stdout 协议 ────────────────────────
  const pretool = path.join(root, 'hook', 'pretool-hook.js');
  const safePayload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status --short' } });
  const r1 = await runHook(pretool, [], {}, safePayload);
  assert.strictEqual(r1.code, 0);
  const out1 = JSON.parse(r1.out);
  assert.strictEqual(out1.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out1.hookSpecificOutput.permissionDecision, 'allow');
  assert(typeof out1.hookSpecificOutput.permissionDecisionReason === 'string');
  console.log('✓ pretool-hook：只读命令 → hookSpecificOutput.permissionDecision=allow');

  const dangerPayload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls; rm -rf /' } });
  const r2 = await runHook(pretool, [], {}, dangerPayload);
  assert.strictEqual(r2.code, 0);
  assert.strictEqual(r2.out, '', 'dangerous command must produce NO output (no opinion)');
  console.log('✓ pretool-hook：危险命令 → 空输出（交回正常权限流程）');

  const otherTool = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x' } });
  const r3 = await runHook(pretool, [], {}, otherTool);
  assert.strictEqual(r3.code, 0);
  assert.strictEqual(r3.out, '');
  console.log('✓ pretool-hook：非 Bash 工具 → 不表态');

  const badJson = 'this is not json{{{';
  const r4 = await runHook(pretool, [], {}, badJson);
  assert.strictEqual(r4.code, 0);
  assert.strictEqual(r4.out, '');
  console.log('✓ pretool-hook：畸形 stdin → 安全不表态');

  // ── 11. codewhale-hook 子进程：env 变量 → /state + 权限桥 ─────────────────
  const cwHook = path.join(root, 'hook', 'codewhale-hook.js');
  // 先验证 LLMPET 不可达时（把 HOME/USERPROFILE 指到空目录，runtime.json
  // 不存在）→ ask。USERPROFILE 缺席时 Windows 的 os.homedir() 仍解析真实
  // 用户目录，本用例会在 windows-latest 上确定性失败（见文件头注释）。
  const unreachableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'no-runtime-'));
  const r5 = await runHook(cwHook, ['tool_call_before'], {
    HOME: unreachableHome,
    USERPROFILE: unreachableHome,
    DEEPSEEK_SESSION_ID: 'cw-unreach', DEEPSEEK_TOOL_NAME: 'exec_shell', DEEPSEEK_TOOL_ARGS: '{"command":"rm -rf /"}',
  }, '');
  assert.strictEqual(r5.code, 0);
  const decision5 = JSON.parse(r5.out.trim().split('\n').pop());
  assert.strictEqual(decision5.decision, 'ask', `unreachable LLMPET must answer ask, got ${r5.out}`);
  assert(decision5.reason);
  // maxRetries：子进程刚退出时其句柄可能仍处于 delete-pending 窗口内
  fs.rmSync(unreachableHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  console.log('✓ codewhale-hook：LLMPET 不可达 → ask（fail-closed，绝不空输出=allow）');

  // 可达时：写 runtime.json 指向测试 server，危险命令挂起，由我们决定
  // transport 的 RUNTIME_PATH 在 require 时已按 fakeHome 定值 —— hook 子进程同
  // fakeHome，因此 runtime.json 需写到 fakeHome/.octopus/runtime.json
  const { writeRuntimeConfig } = require('../backend/transport');
  assert(writeRuntimeConfig(port, token), 'runtime write failed');

  const bridged = runHook(cwHook, ['tool_call_before'], {
    DEEPSEEK_SESSION_ID: 'cw-bridge', DEEPSEEK_TOOL_NAME: 'exec_shell',
    DEEPSEEK_TOOL_ARGS: '{"command":"curl http://evil.example"}',
    DEEPSEEK_WORKSPACE: '/tmp/proj', DEEPSEEK_MODEL: 'deepseek-chat',
  }, '');
  // 子进程冷启动（node + 两个模块）+ HTTP 往返，给足时间
  let bridgedPending = [];
  for (let i = 0; i < 20 && bridgedPending.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    bridgedPending = server.getCodeWhalePermissions().getPending();
  }
  if (bridgedPending.length === 0) {
    // 诊断：环境、runtime 文件、hook 进程输出
    const { RUNTIME_PATH } = require('../backend/transport');
    console.error('DIAG HOME=', process.env.HOME, 'RUNTIME_PATH=', RUNTIME_PATH);
    console.error('DIAG runtime exists=', fs.existsSync(RUNTIME_PATH), fs.existsSync(RUNTIME_PATH) ? fs.readFileSync(RUNTIME_PATH, 'utf8') : '');
    console.error('DIAG server port/token=', port, token ? 'present' : 'MISSING');
    const diag = await Promise.race([bridged, new Promise((r) => setTimeout(() => r({ timeout: true }), 2000))]);
    console.error('DIAG hook result=', JSON.stringify(diag));
  }
  assert.strictEqual(bridgedPending.length, 1, 'permission not bridged');
  assert.strictEqual(bridgedPending[0].sessionId, 'cw-bridge');
  server.getCodeWhalePermissions().decide(bridgedPending[0].id, 'allow');
  const r6 = await bridged;
  assert.strictEqual(r6.code, 0);
  const decision6 = JSON.parse(r6.out.trim().split('\n').pop());
  assert.strictEqual(decision6.decision, 'allow');
  console.log('✓ codewhale-hook：权限桥全链路（env→HTTP→桌宠决策→stdout）');

  // ── 12. mode_change：状态入库为 attention，事件名不冒充 Notification ──────────
  const mc = await request(port, 'POST', '/state', {
    state: 'attention', event: 'ModeChange', session_id: 'cw-s1', agent_id: 'codewhale',
  }, auth);
  assert.strictEqual(mc.status, 200, mc.body);
  const mcSess = core.buildSnapshot().sessions.find((s) => s.id === 'cw-s1');
  assert.strictEqual(mcSess.state, 'attention');
  assert.strictEqual(mcSess.lastEvent.rawEvent, 'ModeChange');
  console.log('✓ mode_change：attention 状态入库（不触发 Notification 卡片路径）');

  // ── 13. 观察者 hook 性能：stdin 守护定时器不再拖住进程 ─────────────────────
  // 修复前：readStdin 的 300ms 定时器不清理也不 unref，每个观察者事件
  // 的 hook 进程至少存活 300ms；修复后 stdin 关闭即退出（本地实测 ~30ms）。
  // 两个计时口径，两轮取最小值（容忍 CI 单次抖动；旧代码两轮都 ≥300ms）：
  //   elapsed     spawn→exit 全程。Linux/macOS 上基线 ~30ms，泄漏时 ≥300ms，
  //               阈值 280ms 干净；但 Windows 进程冷启动本身就要 100-400ms，
  //               该口径在 Windows 上无判别力 —— 只在非 win32 断言。
  //   postToExit  server 处理完 usage POST→子进程退出。剥掉 spawn/模块加载
  //               成本，跨平台干净：修复后 ~0-50ms（响应落地即退出），泄漏时
  //               ≥250ms（守护定时器从 stdin 结束起算 300ms，POST 在其后
  //               几十 ms 内完成）。阈值 150ms 两侧留足余量。
  const usageBefore = usageTurns.length;
  let elapsed = Infinity;
  let postToExit = Infinity;
  for (let round = 0; round < 2; round++) {
    lastUsagePostedAt = 0;
    const t0 = Date.now();
    const obs = await runHook(cwHook, ['turn_end'], {
      DEEPSEEK_SESSION_ID: `cw-timing-${round}`, DEEPSEEK_WORKSPACE: '/tmp/proj', DEEPSEEK_MODEL: 'deepseek-chat',
    }, JSON.stringify({ event: 'turn_end', session_id: `cw-timing-${round}`, turn_id: `turn-timing-${round}`, status: 'completed', provider: 'deepseek', usage: { input_tokens: 10, output_tokens: 5 } }));
    assert.strictEqual(obs.code, 0, obs.err);
    const exitAt = Date.now();
    elapsed = Math.min(elapsed, exitAt - t0);
    if (lastUsagePostedAt) postToExit = Math.min(postToExit, exitAt - lastUsagePostedAt);
  }
  if (process.platform !== 'win32') {
    assert(elapsed < 280, `observer hook must exit promptly, took ${elapsed}ms (>=300 means the stdin guard timer leaks)`);
  }
  assert(postToExit < 150, `hook must exit within 150ms of the server acking its POST (took ${postToExit}ms; ~300ms means the stdin guard timer leaks)`);
  await new Promise((r) => setTimeout(r, 100));
  assert(usageTurns.length > usageBefore && usageTurns.some((u) => u.turnId === 'turn-timing-0'), 'turn_end usage not delivered through the real hook process');
  console.log(`✓ 观察者 hook 快速退出（两轮最小 spawn→exit ${elapsed}ms / ack→exit ${postToExit}ms，修复前 ≥300ms）且 usage 全链路送达`);

  // ── 13b. askPermission 超时分支：永不响应的服务器 → ask + 明确超时 reason ──
  {
    const net = require('net');
    const { PORTS } = require('../backend/transport');
    const tryListen = (p) => new Promise((resolve) => {
      const srv = net.createServer(() => {}); // 接受连接，永不响应
      srv.once('error', () => resolve(null));
      srv.listen(p, '127.0.0.1', () => resolve(srv));
    });
    let silent = null;
    let silentPort = null;
    for (const p of PORTS) {
      if (p === port) continue;
      silent = await tryListen(p);
      if (silent) { silentPort = p; break; }
    }
    assert(silent, 'no free port for the silent server');
    writeRuntimeConfig(silentPort, token);
    const { askPermission } = require('../hook/codewhale-hook');
    const decision = await askPermission(
      { session_id: 'cw-timeout', tool_name: 'exec_shell', tool_input: { command: 'ls' } },
      { timeoutMs: 120 },
    );
    assert.strictEqual(decision.decision, 'ask', `timeout must degrade to ask, got ${JSON.stringify(decision)}`);
    assert(/timed out/i.test(String(decision.reason)), `reason should say timed out, got ${decision.reason}`);
    silent.close();
    // 恢复 runtime 记录指向测试 server，供后续断言使用
    writeRuntimeConfig(port, token);
    console.log('✓ askPermission 超时分支：ask + 区别于「未运行」的超时 reason');
  }

  // ── 14. runtime 守护：伪造陈旧记录 → 被接管；伪造存活记录 → 不抢 ─────────
  // 直接测 claimRuntimeOwnership 的行为：写一个指向死端口的记录
  const { writeRuntimeConfig: writeRuntime, readRuntimeConfig } = require('../backend/transport');
  // 陈旧记录（死端口）—— server 内部 15s 守护会探测并接管；手动触发更快的方式：
  // 直接调用 server 内部不可行（未导出），改为验证「写死端口后短时间内不崩溃」+
  // 等守护周期。这里验证读取侧一致性与 stop() 行为即可；守护逻辑已由
  // pr3-smoke + 代码审查覆盖。
  const staleOk = writeRuntime(port === 41330 ? 41334 : 41330, 'a'.repeat(48));
  assert(staleOk);
  // stop() 只删指向自己的记录
  const otherPort = port === 41330 ? 41331 : 41330;
  writeRuntime(otherPort, 'b'.repeat(48));
  server.stop();
  const after = readRuntimeConfig();
  assert(after && after.port === otherPort, 'stop() must not delete a record pointing elsewhere');
  console.log('✓ runtime：stop() 不误删他人记录（first-live-wins 语义）');

  console.log('\n✅ E2E 冒烟全部通过（14 组断言）');
  // 收尾卫生：本进程内 server 的 listening/error 日志在 fakeHome/.octopus/
  // octopus.log 上持有一个追加流句柄。Windows 上打开的句柄让 unlink 进入
  // delete-pending 后 rmdir 依旧 ENOTEMPTY —— 必须先真正关掉句柄再删沙箱
  // （fork main 的 windows-latest/Node20 CI 曾在此确定性挂掉）。maxRetries
  // 兑付刚刚退出的 hook 子进程残余句柄的短暂窗口。
  await require('../backend/log').shutdown();
  fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  process.exit(0);
}

main().catch(async (e) => {
  console.error('E2E FAILED:', e);
  try { server.stop(); } catch {}
  try { await require('../backend/log').shutdown(); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  process.exit(1);
});
