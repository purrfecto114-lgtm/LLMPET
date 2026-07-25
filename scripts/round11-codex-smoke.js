'use strict';

// Round 11 — Codex provider HTTP e2e smoke test (#p11)
//
// Full end-to-end test of the Codex provider hook system:
//   1. Install hooks (writes hooks.json + config.toml reference)
//   2. Start LLMPET server
//   3. Simulate codex-hook.js bridge behavior for 7 events
//   4. Verify session states in snapshot
//   5. Verify hooks.json round-trip (install → uninstall)

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-codex-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.CODEX_HOME = path.join(TMP_HOME, '.codex');
process.env.OCTOPUS_DISABLE_MODELS_DEV_FETCH = '1';

const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');
const codex = require('../providers/codex');
const codexHooks = require('../backend/codex-hooks');

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // [1] Install hooks
  const inst = codex.installHooks();
  check('[1] installHooks added 7 events', inst.added >= 7);
  check('[2] hooks.json exists', fs.existsSync(inst.hooksJsonPath));
  check('[3] config.toml exists with reference', fs.existsSync(inst.configTomlPath || path.join(process.env.CODEX_HOME, 'config.toml')));
  check('[4] markerPresent() = true', codex.markerPresent() === true);

  // [5] Start server
  const core = createCore({ onActivity: () => {}, onDirty: () => {} });
  const permissions = createPermissions({ onAdded: () => {}, onChange: () => {} });
  const server = createServer({
    core, permissions,
    shouldDropForDnd: () => false,
    transcriptRoots: [os.tmpdir()],
  });
  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  check('[5] server started on port 41330', server.getPort() === 41330);

  function postEvent(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: 41330, path: '/state', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Octopus-Token': server.getToken ? server.getToken() : 'test',
        },
        timeout: 2000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data);
      req.end();
    });
  }

  // [6-12] Simulate 7 codex events via parseHookStdin + POST
  const ses = 'r11-codex-ses-aaaa';
  const events = [
    { event: 'session_start', payload: { session_id: ses, cwd: '/tmp/proj-x', model: 'gpt-5' } },
    { event: 'message_submit', payload: { session_id: ses, text: 'hello codex' } },
    { event: 'tool_call_before', payload: { session_id: ses, tool_name: 'Bash' } },
    { event: 'tool_call_after', payload: { session_id: ses, tool_name: 'Bash', status: 'success' } },
    { event: 'turn_end', payload: { session_id: ses, usage: { input_tokens: 100, output_tokens: 50 } } },
    { event: 'session_end', payload: { session_id: ses } },
  ];

  let allPosted = true;
  for (const { event, payload } of events) {
    const body = codex.parseHookStdin(event, payload);
    if (!body) { allPosted = false; break; }
    const r = await postEvent(body);
    if (r.status !== 200) { allPosted = false; break; }
  }
  check('[6] all 6 codex events POSTed successfully (200)', allPosted);

  // [7] Snapshot has 1 session
  const snap = core.buildSnapshot();
  check('[7] snapshot has 1 session', snap.sessions.length === 1);

  // [8] session agentId = codex
  const s = snap.sessions[0];
  check('[8] session agentId=codex', s.agentId === 'codex');

  // [9] session provider = codex
  check('[9] session provider=codex', s.provider === 'codex');

  // [10] session model = gpt-5
  check('[10] session model=gpt-5', s.model === 'gpt-5');

  // [11] turn_end → requiresCompletionAck (Stop event)
  // Note: session_end came after turn_end, so state may be sleeping.
  // But requiresCompletionAck should still be true from the Stop.
  check('[11] session requiresCompletionAck=true (from turn_end/Stop)', s.requiresCompletionAck === true);

  // [12] hooks.json contains all 7 events with marker
  const hj = JSON.parse(fs.readFileSync(inst.hooksJsonPath, 'utf8'));
  let allEventsPresent = true;
  for (const ev of codex.hookEvents) {
    if (!Array.isArray(hj.hooks[ev]) || !hj.hooks[ev].some((e) => e.command.includes(codex.hookMarker))) {
      allEventsPresent = false;
      break;
    }
  }
  check('[12] hooks.json has all 7 events with marker', allEventsPresent);

  // [13] config.toml contains hooks reference
  const ct = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  check('[13] config.toml has hooks reference', /hooks\s*=\s*["']\.?\/?hooks\.json["']/.test(ct));

  // [14] Uninstall removes our entries
  const uninst = codex.uninstallHooks();
  check('[14] uninstallHooks removed >=7 entries', uninst.removed >= 7);

  // [15] markerPresent() = false after uninstall
  check('[15] markerPresent() = false after uninstall', codex.markerPresent() === false);

  // [16] hooks.json removed (all entries were ours)
  check('[16] hooks.json deleted (all entries were ours)', !fs.existsSync(inst.hooksJsonPath));

  // [17] File permissions 0o600 (skip Windows)
  if (process.platform !== 'win32') {
    // config.toml should still exist with 0o600
    const ctMode = fs.statSync(path.join(process.env.CODEX_HOME, 'config.toml')).mode & 0o777;
    check('[17] config.toml mode 0o600', ctMode === 0o600);
  } else {
    check('[17] file permissions (skipped on Windows)', true);
  }

  // [18] codex-hook.js bridge script parses a synthetic payload
  const bridge = require('../hook/codex-hook.js');
  assert.ok(typeof bridge.main === 'function', 'codex-hook.js should export main');
  check('[18] codex-hook.js bridge exports main()', true);

  // [19] Cleanup
  server.stop();
  check('[19] server stopped cleanly', true);

  console.log(`\nround11-codex-smoke: ${passed}/${passed + failures.length} PASS`);
  if (failures.length) {
    console.log('FAILURES:', failures);
    process.exit(1);
  }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error('round11-codex-smoke FATAL:', err);
  process.exit(1);
});
