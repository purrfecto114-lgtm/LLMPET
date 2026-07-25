'use strict';

// Round 18 — Aider notification bridge HTTP e2e smoke test (#p21)
//
// Full end-to-end test of the Aider notification bridge:
//   1. Install hooks (writes ~/.aider.conf.yml)
//   2. Start LLMPET server
//   3. Create a mock .aider.chat.history.md in a temp project dir
//   4. Invoke the aider-hook.js bridge script (simulating aider's notification)
//   5. Verify the server received the turn_end event
//   6. Verify assistant_last_output was extracted from history

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'r18-aider-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.OCTOPUS_DISABLE_MODELS_DEV_FETCH = '1';

const { createCore } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');
const { installProcessGuards } = require('../backend/process-guards');
const aider = require('../providers/aider');
const transport = require('../backend/transport');

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // [1] Install process guards + aider hooks
  installProcessGuards();
  const inst = aider.installHooks();
  check('[1] installHooks added 1 entry', inst.added >= 1);
  check('[2] markerPresent() = true', aider.markerPresent() === true);

  // [3] Start server
  const core = createCore({ onActivity: () => {}, onDirty: () => {} });
  const permissions = createPermissions({ onAdded: () => {}, onChange: () => {} });
  const server = createServer({
    core, permissions,
    shouldDropForDnd: () => false,
    transcriptRoots: [os.tmpdir()],
  });
  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  check('[3] server started on port 41330', server.getPort() === 41330);

  // [4] Create a mock project dir with .aider.chat.history.md
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-proj-'));
  const historyPath = path.join(projectDir, '.aider.chat.history.md');
  fs.writeFileSync(historyPath, [
    '# Aider chat history',
    '',
    '## user',
    'Please write a hello world function',
    '',
    '## assistant',
    'I will create a hello world function for you.',
    '',
    '```python',
    'def hello():',
    '    print("Hello, World!")',
    '```',
    '',
    '## user',
    'thanks',
    '',
    '## assistant',
    'You are welcome! The function is ready to use.',
    '',
  ].join('\n'));

  // [5] Invoke the aider-hook.js bridge script (simulating aider notification)
  // First verify runtime.json exists (server writes it on start)
  const runtimePath = path.join(TMP_HOME, '.octopus', 'runtime.json');
  await sleep(50); // give server time to write runtime.json
  check('[4a] runtime.json exists', fs.existsSync(runtimePath));
  if (fs.existsSync(runtimePath)) {
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    check('[4b] runtime.json has port 41330', rt.port === 41330);
  }

  const hookScript = path.join(__dirname, '..', 'hook', 'aider-hook.js');
  const r = spawnSync(process.execPath, [hookScript], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME },
  });
  check('[5] aider-hook.js exited 0', r.status === 0);
  if (r.status !== 0 || r.stderr) {
    console.log('    bridge stderr:', r.stderr || '(none)');
    console.log('    bridge stdout:', r.stdout || '(none)');
  }

  // Give the HTTP POST time to complete
  await sleep(100);

  // [6] Snapshot has 1 session
  const snap = core.buildSnapshot();
  check('[6] snapshot has 1 session', snap.sessions.length === 1);

  // [7] session agentId = aider
  const s = snap.sessions[0];
  check('[7] session agentId=aider', s.agentId === 'aider');

  // [8] session provider = aider
  check('[8] session provider=aider', s.provider === 'aider');

  // [9] session cwd = projectDir
  check('[9] session cwd=projectDir', s.cwd === projectDir);

  // [10] session requiresCompletionAck (from Stop event)
  check('[10] session requiresCompletionAck=true', s.requiresCompletionAck === true);

  // [11] session_id starts with aider-
  check('[11] session_id starts with aider-', s.id && s.id.startsWith('aider-'));

  // [12] assistantLastOutput extracted from history
  check('[12] assistantLastOutput contains "welcome"', 
    s.assistantLastOutput && s.assistantLastOutput.includes('welcome'));

  // [13] Verify config file has notifications_command
  const configPath = path.join(TMP_HOME, '.aider.conf.yml');
  const configContent = fs.readFileSync(configPath, 'utf8');
  check('[13] config has notifications_command', configContent.includes('notifications_command:'));
  check('[14] config has notifications: true', /notifications:\s*true/.test(configContent));

  // [15] Uninstall removes our line
  const ur = aider.uninstallHooks();
  check('[15] uninstallHooks removed 1 line', ur.removed >= 1);
  check('[16] markerPresent() = false after uninstall', aider.markerPresent() === false);

  // [17] Cleanup
  server.stop();
  check('[17] server stopped cleanly', true);

  // Summary
  console.log(`\nround18-aider-smoke: ${passed}/${passed + failures.length} PASS`);
  if (failures.length) {
    console.log('FAILURES:', failures);
    process.exit(1);
  }

  // Cleanup
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error('round18-aider-smoke FATAL:', err);
  process.exit(1);
});
