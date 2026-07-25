'use strict';

// #p24-fix: Round 19 smoke — IPC contextBridge security audit (read-only).
//
// This smoke script is a companion to test/preload-contextbridge-security.js.
// It re-validates the audit findings against the on-disk production files and
// asserts the security posture is unchanged since the audit:
//   1. main.js webPreferences enforce contextIsolation:true + nodeIntegration:false + sandbox:true
//      for BOTH the pet window and the panel window.
//   2. preload.js uses contextBridge.exposeInMainWorld (no direct ipcRenderer exposure).
//   3. preload.js does NOT expose `ipcRenderer`, `require`, or `electron` as keys.
//   4. No `nodeIntegration: true` or `contextIsolation: false` anywhere in main.js.
//   5. The exposed surface key count matches the locked-down baseline (38 keys).
//
// Exit code 0 = all assertions PASS.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { console.error(`  [FAIL] ${name}`); process.exitCode = 1; }
}

console.log('Round 19 — IPC contextBridge security audit smoke\n');

// ---- 1. main.js webPreferences posture ----
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

// pet window webPreferences (first occurrence)
check('pet window: contextIsolation: true', /contextIsolation:\s*true/.test(mainSrc));
check('pet window: nodeIntegration: false', /nodeIntegration:\s*false/.test(mainSrc));
check('pet window: sandbox: true', /sandbox:\s*true/.test(mainSrc));
check('pet window: preload set to PRELOAD', /preload:\s*PRELOAD/.test(mainSrc));

// count occurrences — both pet + panel windows must have the secure triple
const ciCount = (mainSrc.match(/contextIsolation:\s*true/g) || []).length;
const niFalseCount = (mainSrc.match(/nodeIntegration:\s*false/g) || []).length;
const sandboxCount = (mainSrc.match(/sandbox:\s*true/g) || []).length;
check('secure triple present for both windows (contextIsolation x2)', ciCount >= 2);
check('secure triple present for both windows (nodeIntegration:false x2)', niFalseCount >= 2);
check('secure triple present for both windows (sandbox:true x2)', sandboxCount >= 2);

// ---- 2. no insecure settings anywhere ----
check('no nodeIntegration: true anywhere in main.js', !/nodeIntegration:\s*true/.test(mainSrc));
check('no contextIsolation: false anywhere in main.js', !/contextIsolation:\s*false/.test(mainSrc));
check('no webSecurity: false anywhere in main.js', !/webSecurity:\s*false/.test(mainSrc));
check('no allowRunningInsecureContent: true', !/allowRunningInsecureContent:\s*true/.test(mainSrc));

// ---- 3. preload.js uses contextBridge, never exposes raw ipcRenderer ----
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
check('preload uses contextBridge.exposeInMainWorld', /contextBridge\.exposeInMainWorld\(\s*['"]pet['"]/.test(preloadSrc));
check('preload does NOT expose ipcRenderer as a key', !/ipcRenderer\s*\)/.test(preloadSrc.replace(/ipcRenderer\.(on|invoke|send|removeListener)/g, '')));
check('preload does NOT expose `require` as a key', !/['"]require['"]\s*:/.test(preloadSrc));
check('preload does NOT expose `electron` as a key', !/['"]electron['"]\s*:/.test(preloadSrc));
// the only `require('electron')` call should destructure contextBridge + ipcRenderer
const requireCount = (preloadSrc.match(/require\(['"]electron['"]\)/g) || []).length;
check('preload requires electron exactly once', requireCount === 1);

// ---- 4. exposed surface key count matches locked-down baseline ----
// Extract the keys between exposeInMainWorld('pet', { ... });
const m = preloadSrc.match(/exposeInMainWorld\(\s*['"]pet['"]\s*,\s*\{([\s\S]*?)\}\s*\)\s*;/);
assert(m, 'could not locate exposeInMainWorld block in preload.js');
const block = m[1];
// keys are lines like `  name: ...` (top-level only, ignore nested)
const keys = [];
for (const line of block.split('\n')) {
  const km = line.match(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
  if (km) keys.push(km[1]);
}
check('exposed surface key count matches baseline (38 keys)', keys.length === 38);

// ---- 5. the regression test file exists + passes (run it inline) ----
const testPath = path.join(ROOT, 'test', 'preload-contextbridge-security.js');
check('regression test file exists', fs.existsSync(testPath));
const { spawnSync } = require('child_process');
const r = spawnSync(process.execPath, [testPath], { cwd: ROOT, encoding: 'utf8' });
check('regression test passes (exit 0)', r.status === 0);

console.log(`\nRound 19 smoke: ${process.exitCode ? 'FAIL' : 'ALL PASS'} (${pass} checks)`);
if (process.exitCode) process.exit(1);
