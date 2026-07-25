'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode provider — stub/skeleton for the SST OpenCode AI coding agent.
// ─────────────────────────────────────────────────────────────────────────────
//
// ROUND 5 (2026-07-25): Added per user priority update
//   "Codewhale > Claude Code > Codex (新版ChatGPT) > Opencode > aider"
//
// OpenCode (https://opencode.ai, https://github.com/sst/opencode) is SST's
// terminal-based AI coding agent. Unlike Claude Code / CodeWhale / Codex,
// OpenCode does NOT use a TOML/JSON hook config — it has a plugin system:
//   • Config: ~/.config/opencode/opencode.json (preferred) or opencode.jsonc
//   • Plugins: JS/TS modules that hook into 25+ lifecycle events
//     (see https://opencode.ai/docs/plugins)
//   • Known events: session.created, session.compacted, agent.finished,
//     tool.call.before, tool.call.after, message.send, message.render, etc.
//   • MCP (Model Context Protocol) support
//   • SDK with event streaming for real-time integration
//
// ROUND 9 (2026-07-25): Path alignment verified against REAL OpenCode CLI v1.18.5
//   binary (installed via `npm install -g opencode-ai`). Real CLI behavior:
//   • `opencode debug paths` reports: config=~/.config/opencode,
//     data=~/.local/share/opencode, cache=~/.cache/opencode
//   • Config file discovery order: opencode.json → opencode.jsonc →
//     .opencode/opencode.json → .opencode/opencode.jsonc
//   • Real CLI creates opencode.jsonc on first run (with $schema header)
//   • Real env vars (3 sources: opencode.ai/docs/config, /docs/cli,
//     computingforgeeks.com cheat sheet):
//     - OPENCODE_CONFIG (single file path override)
//     - OPENCODE_CONFIG_DIR (entire config directory override)  ← we use this
//     - OPENCODE_CONFIG_CONTENT (inline JSON config for CI)
//   • Previous stub used nonexistent 'OPENCODE_HOME' env var — fixed in #r9-fix
//
// This stub validates that the provider abstraction layer can accommodate
// OpenCode. It mirrors the aider.js / codex.js stub pattern: parseHookStdin
// is a minimal working implementation, installHooks/uninstallHooks are
// no-ops, and the remaining methods throw ENOTIMPL. Future rounds (P12)
// will flesh out:
//   (a) Plugin installer (write an opencode plugin JS module that POSTs
//       lifecycle events to Octopus's /state endpoint)
//   (b) JSONL transcript reader (if OpenCode writes one)
//   (c) Metering from message events
//
// IMPORTANT: This stub does NOT modify any existing behavior. It only
// registers 'opencode' as a known provider id so users can opt into it
// via OCTOPUS_PROVIDER=opencode (no-op until P12 implements installHooks).

const path = require('path');
const os = require('os');
const { makeNotImplemented } = require('./base');

const ID = 'opencode';

// OpenCode respects XDG_CONFIG_HOME on Linux; on macOS/Windows it uses
// ~/.config/opencode (OpenCode v1.x). We honor OPENCODE_CONFIG_DIR override
// for testing / custom installs (real env var per opencode.ai/docs/config).
// #r9-fix: previous stub used nonexistent 'OPENCODE_HOME' env var.
function resolveConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}
const CONFIG_DIR = resolveConfigDir();

// #r9: Real OpenCode CLI v1.18.5 separates config (XDG_CONFIG_HOME) from
// runtime data (XDG_DATA_HOME) and cache (XDG_CACHE_HOME). Verified via
// `opencode debug paths` against real binary. These dirs hold:
//   • data: opencode.db (SQLite), log/, repos/  — sessions, transcripts
//   • cache: bin/, models.json                  — model catalog cache
function resolveRuntimeDataDir() {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}
function resolveRuntimeCacheDir() {
  if (process.env.OPENCODE_CACHE_DIR) return process.env.OPENCODE_CACHE_DIR;
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.cache', 'opencode');
}
const RUNTIME_DATA_DIR = resolveRuntimeDataDir();
const RUNTIME_CACHE_DIR = resolveRuntimeCacheDir();

// Backward-compat alias: existing tests/code may reference DATA_HOME. Keep it
// pointing at CONFIG_DIR (where settingsFile lives) so behavior is unchanged
// for callers that only read config. New code should use CONFIG_DIR or
// RUNTIME_DATA_DIR explicitly. (#r9)
const DATA_HOME = CONFIG_DIR;

// Future hook plugin (does not exist yet — installHooks is a no-op stub).
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'opencode-hook.js');
const HOOK_MARKER = 'opencode-hook.js';

// OpenCode plugin events (subset of the 25+ documented events).
// We register the 7 that map cleanly to the pet state machine.
// Future rounds may add more (message.render, session.compacted, etc.).
// See https://opencode.ai/docs/plugins for the full event catalog.
const HOOK_EVENTS = Object.freeze([
  'session_start',     // ~= session.created
  'session_end',       // ~= session.deleted / app exit
  'message_submit',    // ~= message.send
  'tool_call_before',  // ~= tool.call.before
  'tool_call_after',   // ~= tool.call.after
  'turn_end',          // ~= agent.finished
  'on_error',          // ~= tool.call.error / agent.error
]);

// OpenCode plugin event → (internal Claude-equivalent event, pet state).
const EVENT_MAP = Object.freeze({
  session_start:    { internal: 'SessionStart',    state: 'idle' },
  session_end:      { internal: 'SessionEnd',      state: 'sleeping' },
  message_submit:   { internal: 'UserPromptSubmit', state: 'thinking' },
  tool_call_before: { internal: 'PreToolUse',      state: 'working' },
  tool_call_after:  { internal: 'PostToolUse',     state: 'working' },
  turn_end:         { internal: 'Stop',            state: 'attention' },
  on_error:         { internal: 'StopFailure',     state: 'error' },
});

const eventToPetState = {};
for (const [ev, m] of Object.entries(EVENT_MAP)) eventToPetState[ev] = m.state;

// ── parseHookStdin ──────────────────────────────────────────────────────────
// Minimal implementation: accepts a synthetic payload (from a future
// opencode plugin bridge) and produces the standard internal body shape.
// The bridge would be an OpenCode plugin JS module that calls this with
// the event payload.
function parseHookStdin(event, payload) {
  const p = payload || {};
  const mapping = EVENT_MAP[event];
  if (!mapping) return null;

  // OpenCode session IDs are strings (UUIDs or session.id from the SDK).
  const sid = p.session_id || (p.session && typeof p.session === 'object' ? p.session.id : null);
  if (typeof sid !== 'string' || !sid) return null;

  const body = {
    provider: ID,
    agentId: ID,  // #r5: set agentId so core.toEntry doesn't default to 'claude-code'
    event: mapping.internal,
    state: mapping.state,
    session_id: sid,
    background_tasks_count: 0,
    session_crons_count: 0,
  };
  if (typeof p.cwd === 'string' && p.cwd) body.cwd = p.cwd;
  else if (p.session && typeof p.session.cwd === 'string') body.cwd = p.session.cwd;
  if (typeof p.model === 'string' && p.model) body.model = p.model;

  switch (event) {
    case 'session_start':
      body.session_source = 'startup';
      break;
    case 'message_submit':
      if (typeof p.text === 'string' && p.text.trim()) body.user_prompt = p.text;
      else if (typeof p.message === 'string' && p.message.trim()) body.user_prompt = p.message;
      break;
    case 'tool_call_before':
      if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
      else if (p.tool && typeof p.tool === 'object' && typeof p.tool.name === 'string') {
        body.tool_name = p.tool.name;
      }
      break;
    case 'tool_call_after':
      if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
      else if (p.tool && typeof p.tool === 'object' && typeof p.tool.name === 'string') {
        body.tool_name = p.tool.name;
      }
      break;
    case 'turn_end': {
      // OpenCode agent.finished may carry usage info. Shape TBI.
      const u = p.usage && typeof p.usage === 'object' ? p.usage : null;
      if (u) {
        body.turn_usage = {
          input: Number(u.input_tokens || u.input) || 0,
          output: Number(u.output_tokens || u.output) || 0,
        };
      }
      const status = typeof p.status === 'string' ? p.status : '';
      if (status === 'failed' || status === 'error') {
        body.state = 'error';
        body.event = 'StopFailure';
        body.api_error_type = (typeof p.error === 'string' && p.error) ? p.error : status;
      }
      break;
    }
    case 'on_error':
      if (typeof p.error === 'string' && p.error) body.api_error_type = p.error;
      else if (typeof p.reason === 'string' && p.reason) body.api_error_type = p.reason;
      break;
    default:
      break;
  }
  return body;
}

// ── Hook installer (Round 12, #p12) ─────────────────────────────────────────
// Writes ~/.config/opencode/plugins/octopus.js (auto-loaded by opencode at startup).
// Delegates to backend/opencode-hooks.js (atomic file copy with content hash check).
// Idempotent: re-running installHooks() overwrites only if content changed.
function installHooks() {
  const opencodeHooks = require('../backend/opencode-hooks');
  return opencodeHooks.registerHooks();
}

function uninstallHooks(opts) {
  const opencodeHooks = require('../backend/opencode-hooks');
  return opencodeHooks.unregisterHooks(opts || {});
}

function markerPresent() {
  const opencodeHooks = require('../backend/opencode-hooks');
  return opencodeHooks.markerPresent();
}

// ── Provider descriptor ─────────────────────────────────────────────────────
const provider = {
  id: ID,
  displayName: 'OpenCode',

  dirs: {
    // Primary config file (real CLI checks opencode.json FIRST, then .jsonc).
    settingsFile: path.join(CONFIG_DIR, 'opencode.json'),
    // #r9: Real CLI creates opencode.jsonc on first run; both are valid.
    settingsFileAlt: path.join(CONFIG_DIR, 'opencode.jsonc'),
    settingsFormat: 'json',
    // #r9: dataHome kept as CONFIG_DIR for backward compat (where settings
    // live). Use runtimeDataDir for actual session/transcript data.
    dataHome: DATA_HOME,
    configDir: CONFIG_DIR,
    // #r9-fix: real env var (was 'OPENCODE_HOME' which doesn't exist).
    // Sources: opencode.ai/docs/config, opencode.ai/docs/cli,
    // computingforgeeks.com opencode-cli-cheat-sheet.
    envOverride: 'OPENCODE_CONFIG_DIR',
    // #r9: real runtime data dir (sessions, opencode.db, logs).
    runtimeDataDir: RUNTIME_DATA_DIR,
    // #r9: real cache dir (bin/, models.json).
    runtimeCacheDir: RUNTIME_CACHE_DIR,
    pluginsDir: path.join(CONFIG_DIR, 'plugins'),
  },

  hookScript: HOOK_SCRIPT,
  hookMarker: HOOK_MARKER,
  hookEvents: HOOK_EVENTS,
  eventToPetState,

  stdinShape: {
    common: ['event', 'session_id', 'cwd', 'model'],
    perEvent: {
      session_start:    [],
      session_end:      [],
      message_submit:   ['text', 'message'],
      tool_call_before: ['tool_name', 'tool'],
      tool_call_after:  ['tool_name', 'tool', 'tool_result', 'status'],
      turn_end:         ['status', 'error', 'usage', 'duration_ms'],
      on_error:         ['error', 'reason'],
    },
    notes: 'OpenCode plugins are JS/TS modules that receive event payloads as function args. Bridge (opencode-hook.js) TBI in P12.',
  },

  permission: {
    // OpenCode uses in-terminal confirmation. The plugin system can intercept
    // tool.call.before for permission gating in a future round.
    mechanism: 'none',
    notes: 'OpenCode uses in-terminal confirmation. Permission bubble not yet wired (P12+).',
  },

  transcript: {
    // OpenCode may store transcripts/sessions internally; format TBI.
    rootGlob: 'sessions/*',
    format: 'jsonl',
    notes: 'OpenCode transcript format not yet documented. Reader TBI in P12.',
  },

  pricing: {
    // OpenCode reports usage per message. Cost would depend on the model
    // (Anthropic, OpenAI, or custom).
    source: 'none',
    notes: 'OpenCode cost tracking not yet integrated (P12+).',
  },

  capabilities: {
    permissionBubble: false,  // #p12: plugin installed but permission bridge TBI
    metering: false,          // TBI in P12+
    sessionList: false,       // TBI in P12+
    transcriptBubble: false,  // TBI in P12+
    focus: false,             // TBI
    launch: false,            // TBI: find opencode binary and open terminal
    greetSleep: true,         // #p12: plugin installed (session.idle + chat.prompt)
  },

  installHooks,
  uninstallHooks,
  markerPresent,
  parseHookStdin,

  // Stub implementations — will throw ENOTIMPL if called
  launch: makeNotImplemented(ID, 'launch'),
  readTranscriptTail: makeNotImplemented(ID, 'readTranscriptTail'),
  lastAssistantText: makeNotImplemented(ID, 'lastAssistantText'),
};

module.exports = provider;
