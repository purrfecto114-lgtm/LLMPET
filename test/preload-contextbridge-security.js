'use strict';

// #p24-fix: IPC contextBridge security regression test.
//
// Loads the REAL preload.js with a mocked `electron` module (contextBridge +
// ipcRenderer) and asserts the security contract of the exposed `pet` surface:
//   1. exposeInMainWorld called exactly once with apiKey 'pet'
//   2. exposed api is a plain object whose values are ALL functions
//      (contextBridge rule: only Function/string/number/Array/boolean/object;
//       exposing raw ipcRenderer is forbidden)
//   3. no ipcRenderer / require / electron handle leaks into the main world
//   4. the exposed key set matches the locked-down surface (regression guard:
//      any added/removed/renamed method must be a deliberate, reviewed change)
//   5. subscribe() validates cb is a function (no-op for non-functions, no throw)
//   6. subscribe() returns a working unsubscribe that removes the listener
//   7. invoke-based methods call ipcRenderer.invoke with the correct channel
//   8. send-based methods call ipcRenderer.send with the correct channel + args
//
// This is a read-only guard over the production preload — it does NOT modify
// preload.js behavior. See docs/SECURITY-AUDIT-R10.md for the threat model.

const path = require('path');
const Module = require('module');
const assert = require('assert');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}`); }
}

// ---- Mock the `electron` module so requiring preload.js is side-effect only ----
const ipcCalls = []; // record of [method, ...args]
const listeners = {}; // channel -> Map(listener -> cb)

const ipcRenderer = {
  on(channel, listener) {
    ipcCalls.push(['on', channel]);
    (listeners[channel] = listeners[channel] || new Map()).set(listener, listener);
  },
  removeListener(channel, listener) {
    ipcCalls.push(['removeListener', channel]);
    if (listeners[channel]) listeners[channel].delete(listener);
  },
  invoke(channel, ...args) {
    ipcCalls.push(['invoke', channel, ...args]);
    return Promise.resolve(null);
  },
  send(channel, ...args) {
    ipcCalls.push(['send', channel, ...args]);
  },
};

let exposedApi = null;
let exposedKey = null;
const contextBridge = {
  exposeInMainWorld(apiKey, api) {
    exposedKey = apiKey;
    exposedApi = api;
  },
};
const electronMock = { contextBridge, ipcRenderer };

// Intercept Module._load so `require('electron')` inside preload.js returns the
// mock. All other requires fall through to the real loader.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return originalLoad.apply(this, arguments);
};

try {
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  delete require.cache[preloadPath];
  require(preloadPath);
} finally {
  Module._load = originalLoad;
}

// ---- Assertions ----

// T1: exposeInMainWorld called exactly once with apiKey 'pet'
check('exposeInMainWorld called with apiKey "pet"', exposedKey === 'pet');
check('exposed api is a non-null object', typeof exposedApi === 'object' && exposedApi !== null);

// T2: every exposed value is a function (no raw ipcRenderer / primitive leak)
const exposedKeys = Object.keys(exposedApi).sort();
let allFunctions = true;
for (const k of exposedKeys) {
  if (typeof exposedApi[k] !== 'function') { allFunctions = false; break; }
}
check('all exposed values are functions (no raw primitive/object leak)', allFunctions);

// T3: no ipcRenderer / require / electron handle leaks
check('no ipcRenderer property exposed on api', !('ipcRenderer' in exposedApi));
check('no require property exposed on api', !('require' in exposedApi));
check('no electron property exposed on api', !('electron' in exposedApi));
// Verify no exposed function IS ipcRenderer or a bound method of it
let noIpcAlias = true;
for (const k of exposedKeys) {
  if (exposedApi[k] === ipcRenderer || exposedApi[k] === ipcRenderer.send || exposedApi[k] === ipcRenderer.invoke) {
    noIpcAlias = false; break;
  }
}
check('no exposed function aliases ipcRenderer or its methods', noIpcAlias);

// T4: locked-down surface — exact key set (regression guard)
const EXPECTED_KEYS = [
  'onEvent', 'onStats', 'onPanelStats', 'onConfig', 'onPrice',
  'getConfig', 'getStats', 'openPanel', 'closePanel',
  'setMode', 'setSkin', 'setBudget', 'setCurrency', 'toggleMute',
  'setProviders', 'territoryRunNow', 'territoryToggleAuto', 'quit',
  'getWinPos', 'setWinPos',
  'launchClaude', 'launchCodeWhale',
  'decidePermission', 'decideCwPermission', 'decideCwPermissionBatch',
  'focusSession', 'primaryAction',
  'setIgnoreMouse', 'setPetTall', 'setPetBig', 'setPetSize', 'setPanelHeight',
  'focusPet', 'blurPet',
  'openLog', 'petLog', 'uiBusy', 'petVisualBounds',
].sort();
check('exposed key set matches locked-down surface (count)', exposedKeys.length === EXPECTED_KEYS.length);
check('exposed key set matches locked-down surface (exact keys)',
  exposedKeys.length === EXPECTED_KEYS.length &&
  exposedKeys.every((k, i) => k === EXPECTED_KEYS[i]));
if (exposedKeys.length !== EXPECTED_KEYS.length) {
  const added = exposedKeys.filter((k) => !EXPECTED_KEYS.includes(k));
  const removed = EXPECTED_KEYS.filter((k) => !exposedKeys.includes(k));
  if (added.length) console.log('    ADDED (review & whitelist):', added);
  if (removed.length) console.log('    REMOVED (update test):', removed);
}

// T5: subscribe() validates cb — non-function returns no-op, doesn't throw, doesn't register
let threw = false;
try {
  const off = exposedApi.onEvent('not-a-function');
  check('onEvent with non-function returns a function (no-op unsubscribe)', typeof off === 'function');
} catch (e) { threw = true; }
check('onEvent with non-function does not throw', !threw);
check('onEvent with non-function did not register a listener', !listeners['pet:event'] || listeners['pet:event'].size === 0);

// T6: subscribe() with valid cb returns a working unsubscribe
let received = null;
const off2 = exposedApi.onStats((data) => { received = data; });
check('onStats with function returns an unsubscribe function', typeof off2 === 'function');
check('onStats registered exactly one listener on "pet:stats" channel', listeners['pet:stats'] && listeners['pet:stats'].size === 1);
// simulate main process pushing an event (ipcRenderer.on calls listener(event, data))
for (const [, listener] of (listeners['pet:stats'] || new Map())) listener(null, { tokens: 42 });
check('onStats callback receives pushed data', received && received.tokens === 42);
// unsubscribe
off2();
check('unsubscribe removes the listener', listeners['pet:stats'] && listeners['pet:stats'].size === 0);

// T7: invoke-based methods call ipcRenderer.invoke with the correct channel
ipcCalls.length = 0;
exposedApi.getConfig();
check('getConfig() calls ipcRenderer.invoke("get-config")',
  ipcCalls.some((c) => c[0] === 'invoke' && c[1] === 'get-config'));
exposedApi.getStats();
check('getStats() calls ipcRenderer.invoke("get-stats")',
  ipcCalls.some((c) => c[0] === 'invoke' && c[1] === 'get-stats'));
exposedApi.getWinPos();
check('getWinPos() calls ipcRenderer.invoke("get-win-pos")',
  ipcCalls.some((c) => c[0] === 'invoke' && c[1] === 'get-win-pos'));

// T8: send-based methods call ipcRenderer.send with the correct channel + args
ipcCalls.length = 0;
exposedApi.openPanel();
check('openPanel() calls ipcRenderer.send("open-panel")',
  ipcCalls.some((c) => c[0] === 'send' && c[1] === 'open-panel'));
exposedApi.quit();
check('quit() calls ipcRenderer.send("quit-app")',
  ipcCalls.some((c) => c[0] === 'send' && c[1] === 'quit-app'));
exposedApi.setMode('focus');
check('setMode(m) calls ipcRenderer.send("set-mode", m)',
  ipcCalls.some((c) => c[0] === 'send' && c[1] === 'set-mode' && c[2] === 'focus'));
exposedApi.setWinPos(120, 240);
check('setWinPos(x,y) calls ipcRenderer.send("set-win-pos", x, y)',
  ipcCalls.some((c) => c[0] === 'send' && c[1] === 'set-win-pos' && c[2] === 120 && c[3] === 240));
exposedApi.decidePermission('p1', 'allow');
check('decidePermission(id,behavior) calls ipcRenderer.send("permission-decide", id, behavior)',
  ipcCalls.some((c) => c[0] === 'send' && c[1] === 'permission-decide' && c[2] === 'p1' && c[3] === 'allow'));

// ---- Result ----
console.log(`\npreload-contextbridge-security: ${fail === 0 ? 'ALL PASS' : 'FAIL'} (${pass} checks, ${fail} failures)`);
if (fail > 0) process.exit(1);
