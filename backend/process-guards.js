'use strict';

// Process-level error guards — Round 10 (#r10)
//
// Registers global handlers for unhandled promise rejections and uncaught
// exceptions.  Without these, Node 15+ terminates the process on the first
// unhandled rejection — a silent crash that is terrible UX for a desktop pet.
//
// Design decisions:
//   - unhandledRejection: LOG but do NOT crash.  Many async paths in the
//     codebase are best-effort (pricing sync, model catalog refresh, etc.).
//     A single rejected promise should not kill the entire Electron app.
//   - uncaughtException: LOG and EXIT gracefully.  Per Node.js docs, the
//     process state is undefined after an uncaught exception; continuing
//     risks corrupted state.  We log the error and exit(1) so the user sees
//     something in the log file rather than a silent disappearance.
//
// Sources (R10 web research):
//   - dev.to (Jun 2025): "The Silent Killers in Node.js: uncaughtException
//     and unhandledRejection" — warns against leaving handlers empty.
//   - markus.oberlehner.net: "try/catch: The Right Way" — when empty catches
//     are justified vs harmful.
//   - medium.com (Jul 2025): "Stop Writing Try/Catch Like This in Node.js"
//     — silently swallowing errors makes production debugging impossible.
//
// Usage:  require('./process-guards')  at the top of main.js, before any
// other module that might throw during require().

const { log } = require('./log');

let _installed = false;

function installProcessGuards() {
  if (_installed) return;
  _installed = true;

  // #r10: unhandledRejection — log warning, do NOT crash the desktop app.
  // Node 15+ default is process.exit(1), which is wrong for an Electron pet.
  process.on('unhandledRejection', (reason, promise) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : '';
    log('process-guard', 'unhandledRejection:', msg);  // #r10
    if (stack) log('process-guard', '  stack:', stack.split('\n').slice(0, 3).join('\n  '));
  });

  // #r10: uncaughtException — log error and exit gracefully.
  // Node.js docs: "It is not safe to resume normal operation after
  // an 'uncaughtException' event."  We log to ~/.octopus/log.txt
  // so the user has a clue, then exit(1).
  process.on('uncaughtException', (err) => {
    log('process-guard', 'UNCAUGHT EXCEPTION:', err.message);  // #r10
    if (err.stack) log('process-guard', '  stack:', err.stack.split('\n').slice(0, 5).join('\n  '));
    // Give the log writer a tick to flush before exiting.
    setImmediate(() => process.exit(1));
  });
}

module.exports = { installProcessGuards, _installed: () => _installed };
