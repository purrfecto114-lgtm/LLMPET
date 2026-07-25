#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Codex hook — run by Codex CLI as: node codex-hook.js <Event>
// ─────────────────────────────────────────────────────────────────────────────
//
// Codex CLI (https://github.com/openai/codex) is OpenAI's Rust-based CLI coding
// agent. It has a hook system (feature flag `hooks`, stable as of v0.145.0)
// configured via `~/.codex/hooks.json` (referenced from config.toml as
// `hooks = "./hooks.json"`).
//
// Hook events (snake_case, from codex binary strings analysis):
//   session_start, session_end, user_prompt_submit,
//   pre_tool_use, post_tool_use, pre_compact, post_compact,
//   subagent_start, subagent_stop, permission_request, stop
//
// This bridge:
//   1. Reads the hook event name from argv[2]
//   2. Reads JSON payload from stdin (Codex pipes JSON on stdin)
//   3. Normalizes via codex.parseHookStdin (maps to internal Claude-equivalent
//      event + pet state)
//   4. POSTs to the running Octopus server via transport.postState
//   5. Exits 0 immediately (best-effort, never block Codex)
//
// Must be fast and never throw — Codex waits on hook completion. A 250ms
// safety timeout ensures we never hang the CLI even if stdin never closes.
//
// Round 11 (#p11): First implementation. Permission bridge (tool_call_before
// blocking decision) is NOT yet wired — Codex's permission_request event uses
// a different schema than CodeWhale's tool_call_before. Future rounds may add
// a /codex-permission endpoint if users request permission bubbles.

const transport = require('../backend/transport');
const codex = require('../providers/codex');

const STDIN_READ_TIMEOUT_MS = 300;
const STDIN_MAX_BYTES = 1024 * 1024;

// Codex CLI event names (snake_case) → codex provider parseHookStdin keys.
// The provider's EVENT_MAP already covers these; we just pass through.
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let payload = {};
      try {
        if (!tooLarge) {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) payload = JSON.parse(raw);
        }
      } catch {}
      resolve(payload);
    };
    process.stdin.on('data', (c) => {
      if (tooLarge) return;
      bytes += c.length;
      if (bytes > STDIN_MAX_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        finish();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, STDIN_READ_TIMEOUT_MS);
  });
}

function main() {
  const event = process.argv[2];
  if (!event) process.exit(0);

  // Codex may also pass hook_event_name in the stdin payload; prefer argv.
  readStdin().then((payload) => {
    let body;
    try {
      // If argv event is empty but payload has hook_event_name, use that.
      const ev = event || (payload && typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '');
      if (!ev) process.exit(0);
      body = codex.parseHookStdin(ev, payload || {});
    } catch {
      body = null;
    }
    if (!body) process.exit(0);
    transport.postState(body, () => process.exit(0));
    setTimeout(() => process.exit(0), 250); // never hang Codex CLI
  }).catch(() => process.exit(0));
}

if (require.main === module) main();
module.exports = { main };
