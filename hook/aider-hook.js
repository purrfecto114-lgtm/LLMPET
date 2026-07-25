#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Aider notification bridge — run by aider's --notifications-command
// ─────────────────────────────────────────────────────────────────────────────
//
// Aider (https://aider.chat) has NO native lifecycle hook system. It only has
// a --notifications-command flag that runs a shell command (no args, no env
// vars) when the LLM response is ready and aider is waiting for input.
//
// This bridge is invoked as: node aider-hook.js
// (configured in ~/.aider.conf.yml as `notifications_command: "node /path/aider-hook.js"`)
//
// The bridge:
//   1. Inherits aider's cwd (the project directory aider is running in)
//   2. Derives a session_id from the .aider.chat.history.md file path + mtime
//      (aider has no native session_id, so we synthesize one)
//   3. Reads .aider.chat.history.md tail to extract last assistant message
//   4. POSTs a turn_end event to the Octopus /state endpoint
//   5. Exits 0 immediately (best-effort, never blocks aider)
//
// Limitations (by design — aider's notification system is minimal):
//   - Only turn_end events (no session_start, message_submit, tool_call)
//   - No usage/cost data (aider doesn't pass it to the command)
//   - No permission bridge (aider confirms in-terminal)
//
// Round 18 (#p21): First implementation. This gives aider the minimum viable
// pet integration — the pet shows "done/attention" when aider finishes a turn.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RUNTIME_PATH = path.join(os.homedir(), '.octopus', 'runtime.json');
const STATE_PATH = '/state';
const POST_TIMEOUT_MS = 2000;
const HISTORY_FILE = '.aider.chat.history.md';
const MAX_HISTORY_BYTES = 64 * 1024; // read last 64KB of chat history

// Read the Octopus server port + token from the runtime file.
function readRuntime() {
  try {
    const obj = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
    if (obj && obj.app === 'octopus' && Number.isInteger(obj.port) && typeof obj.token === 'string') {
      return { port: obj.port, token: obj.token };
    }
  } catch {}
  return null;
}

// POST a state update to the Octopus server. Best-effort, fire-and-forget.
function postState(body) {
  const runtime = readRuntime();
  if (!runtime) return;
  const payload = JSON.stringify(body);
  const req = http.request({
    hostname: '127.0.0.1',
    port: runtime.port,
    path: STATE_PATH,
    method: 'POST',
    timeout: POST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Octopus-Token': runtime.token,
    },
  }, (res) => { res.resume(); });
  req.on('error', () => {});
  req.on('timeout', () => { req.destroy(); });
  req.end(payload);
}

// Derive a stable session_id from the chat history file path.
// Uses the absolute path hash — stable per project, unique per project.
// (mtime is NOT included so the id stays stable across turns within one session.)
function deriveSessionId(historyPath) {
  try {
    const abs = path.resolve(historyPath);
    const hash = crypto.createHash('sha256').update(abs).digest('hex');
    return 'aider-' + hash.slice(0, 12);
  } catch {
    return null;
  }
}

// Extract the last assistant message from the markdown history.
// Format: "## assistant\n<message text>\n"
function extractLastAssistant(text) {
  if (!text || typeof text !== 'string') return null;
  // Find all "## assistant" sections, take the last one
  const parts = text.split(/^## assistant\s*$/m);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].trim();
  // Truncate to 500 chars for the pet bubble
  return last.slice(0, 500);
}

// Read the tail of the chat history file.
function readHistoryTail(historyPath) {
  try {
    const st = fs.statSync(historyPath);
    if (!st.isFile()) return null;
    const fd = fs.openSync(historyPath, 'r');
    try {
      const len = Math.min(st.size, MAX_HISTORY_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

function main() {
  const cwd = process.cwd();
  const historyPath = path.join(cwd, HISTORY_FILE);

  // If no history file, aider may have just started — send session_start-like
  // event. But since notification only fires at turn end, this is unlikely.
  // We skip if no history file (aider hasn't chatted yet).
  if (!fs.existsSync(historyPath)) {
    // Still POST a minimal turn_end so the pet updates
    const sid = deriveSessionId(path.join(cwd, HISTORY_FILE)) || 'aider-unknown';
    postState({
      provider: 'aider',
      agentId: 'aider',
      event: 'Stop',
      state: 'idle',
      session_id: sid,
      cwd: cwd,
      background_tasks_count: 0,
      session_crons_count: 0,
    });
    // Give the HTTP POST time to complete before exiting
    setTimeout(() => process.exit(0), 300);
    return;
  }

  const sid = deriveSessionId(historyPath);
  if (!sid) process.exit(0);

  const historyTail = readHistoryTail(historyPath);
  const lastAssistant = historyTail ? extractLastAssistant(historyTail) : null;

  const body = {
    provider: 'aider',
    agentId: 'aider',
    event: 'Stop',
    state: 'idle',
    session_id: sid,
    cwd: cwd,
    background_tasks_count: 0,
    session_crons_count: 0,
  };
  if (lastAssistant) {
    body.assistant_last_output = lastAssistant;
  }

  postState(body);
  // Give the HTTP POST time to complete before exiting
  // (postState is fire-and-forget; without this delay the process exits
  // before the request finishes, and the server never sees the event)
  setTimeout(() => process.exit(0), 300);
}

if (require.main === module) main();
module.exports = { main, _deriveSessionId: deriveSessionId, _extractLastAssistant: extractLastAssistant, _readHistoryTail: readHistoryTail };
