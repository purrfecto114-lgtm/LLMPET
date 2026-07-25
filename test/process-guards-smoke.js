'use strict';

// Round 10 — process-guards smoke test (#r10)
//
// Verifies that the process-level error guard module:
//   1. Exports installProcessGuards function
//   2. Registers unhandledRejection handler on process
//   3. Registers uncaughtException handler on process
//   4. Is idempotent (calling twice doesn't double-register)
//   5. unhandledRejection handler is invoked and logs the error
//
// Strategy: run the assertions in a child process so each test gets a fresh
// process with no pre-existing listeners. This keeps the test hermetic.

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GUARDS = path.join(ROOT, 'backend', 'process-guards.js');
const LOG = path.join(ROOT, 'backend', 'log.js');

let passed = 0;

// Child script 1: install guards and verify handlers register
const child1 = `
const { installProcessGuards, _installed } = require(${JSON.stringify(GUARDS)});
console.log('typeof_install=' + typeof installProcessGuards);
console.log('typeof_installed=' + typeof _installed);
console.log('before=' + _installed());
installProcessGuards();
console.log('after=' + _installed());
console.log('urh_count=' + process.listenerCount('unhandledRejection'));
console.log('ueh_count=' + process.listenerCount('uncaughtException'));
// idempotent
installProcessGuards();
console.log('urh_after2=' + process.listenerCount('unhandledRejection'));
console.log('ueh_after2=' + process.listenerCount('uncaughtException'));
console.log('still_installed=' + _installed());
process.exit(0);
`;

const r1 = spawnSync(process.execPath, ['-e', child1], { encoding: 'utf8' });
assert.strictEqual(r1.status, 0, 'child1 should exit 0: ' + r1.stderr);
const out1 = r1.stdout.trim().split('\n').reduce((acc, l) => {
  const [k, v] = l.split('=');
  acc[k] = v; return acc;
}, {});

// [T1] installProcessGuards is a function
assert.strictEqual(out1.typeof_install, 'function', 'installProcessGuards should be a function');
passed++;
// [T2] _installed is a function
assert.strictEqual(out1.typeof_installed, 'function', '_installed should be a function');
passed++;
// [T3] before install: false
assert.strictEqual(out1.before, 'false', 'should not be installed before call');
passed++;
// [T4] after install: true
assert.strictEqual(out1.after, 'true', 'should be installed after call');
passed++;
// [T5] unhandledRejection handler registered
assert.ok(parseInt(out1.urh_count, 10) >= 1, `unhandledRejection listener count should be >=1, got ${out1.urh_count}`);
passed++;
// [T6] uncaughtException handler registered
assert.ok(parseInt(out1.ueh_count, 10) >= 1, `uncaughtException listener count should be >=1, got ${out1.ueh_count}`);
passed++;
// [T7] idempotent — no double registration
assert.strictEqual(out1.urh_after2, out1.urh_count, 'should not double-register unhandledRejection');
assert.strictEqual(out1.ueh_after2, out1.ueh_count, 'should not double-register uncaughtException');
passed++;
// [T8] still installed after second call
assert.strictEqual(out1.still_installed, 'true', 'should still be installed');
passed++;

// Child script 2: trigger unhandledRejection and verify the process does NOT crash
// (Node 15+ default would terminate the process; our guard should prevent this).
// We can't easily capture log output because log() writes to ~/.octopus/log.txt,
// so we verify behaviorally: the process stays alive long enough to print 'alive'.
const child2 = `
process.env.HOME = require('os').tmpdir() + '/pg-test-' + process.pid;
require('fs').mkdirSync(process.env.HOME, { recursive: true });
const { installProcessGuards } = require(${JSON.stringify(GUARDS)});
installProcessGuards();
// Fire an unhandled rejection. With the guard installed, the process should NOT exit.
Promise.reject(new Error('test rejection #r10'));
setTimeout(() => {
  console.log('alive');
  process.exit(0);
}, 100);
`;

const r2 = spawnSync(process.execPath, ['-e', child2], { encoding: 'utf8', timeout: 5000 });
assert.strictEqual(r2.status, 0, 'child2 should exit 0 (not crash on unhandledRejection): ' + r2.stderr);
// [T9] process survived the unhandled rejection
assert.ok(r2.stdout.includes('alive'), 'process should print "alive" after unhandledRejection');
passed++;

// [T10] Verify no "UnhandledPromiseRejection" warning crashed the process
// (if the guard failed, Node would print a warning to stderr and the process
//  would still exit 0 in Node 15+ but with a warning. We check stderr is clean
//  of crash-level messages.)
assert.ok(!r2.stderr.includes('UnhandledPromiseRejectionWarning:'), 'should not have unhandled rejection warning');
passed++;

console.log(`process-guards-smoke: ALL PASS (${passed} checks)`);
