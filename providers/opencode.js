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
//   • Config: ~/.config/opencode/opencode.json (JSON) or ~/.opencode/
//   • Plugins: JS/TS modules that hook into 25+ lifecycle events
//     (see https://opencode.ai/docs/plugins)
//   • Known events: session.created, session.compacted, agent.finished,
//     tool.call.before, tool.call.after, message.send, message.render, etc.
//   • MCP (Model Context Protocol) support
//   • SDK with event streaming for real-time integration
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
// ~/.config/opencode (Opencode v0.x). We honor OPENCODE_HOME override
// for testing / custom installs.
function resolveDataHome() {
  if (process.env.OPENCODE_HOME) return process.env.OPENCODE_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}
const DATA_HOME = resolveDataHome();

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

// ── Hook installer (stub — does not write opencode plugin yet) ──────────────
// A future implementation (P12) would write an opencode plugin JS module
// to ~/.config/opencode/plugins/octopus.js that POSTs lifecycle events to
// Octopus's /state endpoint. For now it returns a no-op result.
function installHooks() {
  // TODO (P12): write opencode plugin JS module to ~/.config/opencode/plugins/
  return { added: 0, skipped: true, reason: 'opencode plugin not yet implemented (stub provider, Round 5)' };
}

function uninstallHooks() {
  return { removed: 0, reason: 'opencode plugin not yet implemented (stub provider, Round 5)' };
}

function markerPresent() {
  return false; // No plugin installed yet
}

// ── Provider descriptor ─────────────────────────────────────────────────────
const provider = {
  id: ID,
  displayName: 'OpenCode',

  dirs: {
    settingsFile: path.join(DATA_HOME, 'opencode.json'),
    settingsFormat: 'json',
    dataHome: DATA_HOME,
    configDir: DATA_HOME,
    envOverride: 'OPENCODE_HOME',
    pluginsDir: path.join(DATA_HOME, 'plugins'),
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
    permissionBubble: false,  // TBI in P12+
    metering: false,          // TBI in P12+
    sessionList: false,       // TBI in P12+
    transcriptBubble: false,  // TBI in P12+
    focus: false,             // TBI
    launch: false,            // TBI: find opencode binary and open terminal
    greetSleep: true,         // session_start/session_end events exist
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
