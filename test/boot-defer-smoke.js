'use strict';

// Round 7 — boot defer smoke test (#r7-fix)
//
// Verifies that core.startStaleCleanup() defers the initial backfill to the
// next event-loop tick via setImmediate, so Electron boot (BrowserWindow
// creation, IPC handler registration, first paint) is not blocked by the
// synchronous filesystem scan of ~/.claude/projects.
//
// Also verifies:
//   - Before setImmediate fires, sessions stay empty (defer confirmed).
//   - After one setImmediate tick, backfill has seeded sessions from transcripts.
//   - onDirty fires after the deferred backfill (so UI gets a refresh tick).
//   - buildSnapshot() works correctly post-backfill (the /state HTTP path).
//   - startStaleCleanup() is idempotent (no double timer, no throw).
//   - A rapid start→stop cycle cancels the pending backfill (no leak).
//
// References:
//   - https://electronjs.org/docs/latest/tutorial/performance
//     "If you have expensive setup operations, consider deferring those."
//   - https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick
//     setImmediate schedules after I/O events in the current loop.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set HOME to a tmp dir BEFORE requiring core.js so PROJECTS_DIR resolves
// to our mock transcript tree (core.js computes PROJECTS_DIR at require time
// via os.homedir()).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-r7-'));
process.env.HOME = TMP_HOME;

// Build a mock transcript tree: ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
const PROJECTS = path.join(TMP_HOME, '.claude', 'projects', 'mock-proj');
fs.mkdirSync(PROJECTS, { recursive: true });
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TRANSCRIPT = path.join(PROJECTS, `${SID}.jsonl`);
const recent = new Date().toISOString();
fs.writeFileSync(TRANSCRIPT, JSON.stringify({
  type: 'assistant',
  timestamp: recent,
  requestId: 'r1',
  message: {
    id: 'm1',
    model: 'claude-sonnet',
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  cwd: '/tmp/mock-proj',
}) + '\n');

// Require core AFTER HOME is set so PROJECTS_DIR points at TMP_HOME.
const { createCore } = require('../backend/core');

function nextTick() { return new Promise((r) => setImmediate(r)); }

(async () => {
  let dirtyCount = 0;
  const core = createCore({
    onActivity: () => {},
    onDirty: () => { dirtyCount++; },
  });

  // [T1] startStaleCleanup returns immediately — initial backfill is deferred
  // to setImmediate, so the call must complete in well under the time it
  // would take to scan the transcript tree synchronously.
  const t0 = Date.now();
  core.startStaleCleanup();
  const t1 = Date.now();
  assert.ok(
    t1 - t0 < 5,
    `startStaleCleanup should return in <5ms (took ${t1 - t0}ms); initial backfill must be deferred`,
  );
  console.log(`  ✓ T1: startStaleCleanup returned in ${t1 - t0}ms (backfill deferred to setImmediate)`);

  // [T2] before setImmediate fires, sessions map is empty — proves defer
  assert.strictEqual(
    core.sessions.size, 0,
    'sessions should be empty before deferred backfill fires',
  );
  console.log('  ✓ T2: sessions empty before setImmediate fires (defer confirmed)');

  // [T3] after one setImmediate tick, deferred backfill has run and seeded
  // the session from our mock transcript.
  await nextTick();
  assert.ok(
    core.sessions.size >= 1,
    `sessions should have 1+ entry after deferred backfill (got ${core.sessions.size})`,
  );
  assert.ok(
    core.sessions.has(SID),
    `sessions should contain our mock SID ${SID}`,
  );
  console.log(`  ✓ T3: deferred backfill seeded ${core.sessions.size} session(s) after setImmediate`);

  // [T4] onDirty was called by the deferred backfill (seeding triggers dirty)
  assert.ok(
    dirtyCount >= 1,
    `onDirty should fire after backfill seeds sessions (got ${dirtyCount})`,
  );
  console.log(`  ✓ T4: onDirty fired ${dirtyCount} time(s) after deferred backfill`);

  // [T5] buildSnapshot works post-backfill — the /state HTTP path
  const snap = core.buildSnapshot();
  assert.ok(Array.isArray(snap.sessions), 'snapshot.sessions should be array');
  assert.ok(snap.sessions.length >= 1, 'snapshot should have 1+ session');
  const found = snap.sessions.find((s) => s.id === SID);
  assert.ok(found, 'snapshot should include the backfilled session');
  assert.strictEqual(found.agentId, 'claude-code', 'backfilled session default agentId');
  console.log(`  ✓ T5: buildSnapshot returns ${snap.sessions.length} session(s), backfilled SID present`);

  // [T6] startStaleCleanup is idempotent — second/third call no-op
  core.startStaleCleanup();
  core.startStaleCleanup();
  console.log('  ✓ T6: startStaleCleanup idempotent (no throw on repeat calls)');

  // [T7] rapid start→stop cancels the pending deferred backfill
  // (critical for test teardown and rapid app-quit-during-boot race)
  const core2 = createCore({ onActivity: () => {}, onDirty: () => {} });
  core2.startStaleCleanup();
  core2.stopStaleCleanup(); // cancel before setImmediate fires
  await nextTick();
  await nextTick(); // extra tick to be safe
  assert.strictEqual(
    core2.sessions.size, 0,
    'rapid start→stop must cancel pending backfill (sessions should stay empty)',
  );
  console.log('  ✓ T7: rapid start→stop cancels pending backfill (0 sessions after stop)');

  // [T8] stopStaleCleanup on the already-backfilled core is clean
  core.stopStaleCleanup();
  console.log('  ✓ T8: stopStaleCleanup on backfilled core clean (no throw, no leak)');

  // [T9] after stop, subsequent setImmediate callbacks from a fresh start
  // still work — verifies the pendingBackfill flag resets correctly.
  dirtyCount = 0;
  core.startStaleCleanup();
  await nextTick();
  assert.ok(
    core.sessions.size >= 1,
    `restart after stop should re-seed sessions via deferred backfill (got ${core.sessions.size})`,
  );
  core.stopStaleCleanup();
  console.log('  ✓ T9: restart after stop re-defers backfill correctly (flag resets)');

  // Cleanup tmp HOME
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

  console.log('\n=== boot-defer-smoke: ALL PASS (9/9) ===');
  process.exit(0);
})().catch((err) => {
  console.error('boot-defer-smoke FAILED:', err);
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
