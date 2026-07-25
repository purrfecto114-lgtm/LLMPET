'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Codex provider — stub/skeleton for the new ChatGPT Codex CLI.
// ─────────────────────────────────────────────────────────────────────────────
//
// ROUND 5 (2026-07-25): Added per user priority update
//   "Codewhale > Claude Code > Codex (新版ChatGPT) > Opencode > aider"
//
// Codex (https://github.com/openai/codex) is OpenAI's Rust-based CLI coding
// agent (the "new ChatGPT" CLI). Unlike the legacy Codex model, this is a
// standalone agentic CLI with:
//   • Config: ~/.codex/config.toml (TOML, same format family as CodeWhale)
//   • Hooks system: 13 lifecycle events (PreToolUse, PostToolUse, Stop,
//     SessionStart, SessionEnd, etc.) — see https://learn.chatgpt.com/docs/hooks
//   • Hook scripts can be inline in config.toml under [hooks] or in a sidecar
//     hooks.json file
//   • Sessions stored as JSONL rollout files (~/.codex/sessions/)
//   • MCP (Model Context Protocol) support
//
// This stub validates that the provider abstraction layer can accommodate
// Codex. It mirrors the aider.js stub pattern: parseHookStdin is a minimal
// working implementation, installHooks/uninstallHooks are no-ops, and the
// remaining methods throw ENOTIMPL. Future rounds (P11) will flesh out:
//   (a) TOML hook installer (write ~/.codex/config.toml [[hooks]] entries)
//   (b) JSONL transcript reader for sessions/*.jsonl
//   (c) Metering from rollout usage events
//
// IMPORTANT: This stub does NOT modify any existing Codex/ChatGPT behavior.
// The territory.js "Codex 桌宠识别" (external pet exclusion) feature is
// UNRELATED to this provider — it identifies the ChatGPT.app Electron pet
// window (356x320) to avoid visual collision. This provider, by contrast,
// tracks Codex CLI *sessions* (like Claude Code / CodeWhale sessions).
// The two coexist without conflict.

const path = require('path');
const os = require('os');
const { makeNotImplemented } = require('./base');

const ID = 'codex';

const DATA_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// Future hook script (does not exist yet — installHooks is a no-op stub).
// Declared here so future rounds can reference it without re-declaring.
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'codex-hook.js');
const HOOK_MARKER = 'codex-hook.js';

// Codex CLI lifecycle events (from https://learn.chatgpt.com/docs/hooks).
// Modeled on the 13 documented events; we register the 7 that map cleanly
// to the pet state machine. Future rounds may add the remaining 6
// (e.g. tool_call_error, message_render, permission_request, etc.).
const HOOK_EVENTS = Object.freeze([
  'session_start',
  'session_end',
  'message_submit',
  'tool_call_before',
  'tool_call_after',
  'turn_end',
  'on_error',
]);

// Codex native event → (internal Claude-equivalent event, pet state).
// Mirrors codewhale.js EVENT_MAP shape for consistency.
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
// codex-hook.js bridge) and produces the standard internal body shape.
// The bridge would be invoked by Codex CLI's hook system (config.toml
// [[hooks]] entry) and call this with parsed stdin JSON.
function parseHookStdin(event, payload) {
  const p = payload || {};
  const mapping = EVENT_MAP[event];
  if (!mapping) return null;

  const sid = p.session_id;
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
  if (typeof p.model === 'string' && p.model) body.model = p.model;

  switch (event) {
    case 'session_start':
      // Codex CLI startup. session_source not yet documented; default to startup.
      body.session_source = 'startup';
      break;
    case 'message_submit':
      if (typeof p.text === 'string' && p.text.trim()) body.user_prompt = p.text;
      break;
    case 'tool_call_before':
      if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
      break;
    case 'tool_call_after':
      if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
      break;
    case 'turn_end': {
      // Codex CLI emits usage info at turn_end. Shape TBI — modeled on codewhale.
      const u = p.usage && typeof p.usage === 'object' ? p.usage : null;
      if (u) {
        body.turn_usage = {
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cache_read: Number(u.prompt_cache_hit_tokens) || 0,
          cache_create: Number(u.prompt_cache_miss_tokens) || 0,
        };
      }
      const status = typeof p.status === 'string' ? p.status : '';
      if (status === 'failed' || status === 'interrupted') {
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

// ── Hook installer (Round 11, #p11) ─────────────────────────────────────────
// Writes ~/.codex/hooks.json (referenced from config.toml as `hooks = "./hooks.json"`).
// Delegates to backend/codex-hooks.js (merge-safe JSON manipulation).
// Idempotent: re-running installHooks() replaces our entries without touching
// hooks from other tools.
function installHooks() {
  const codexHooks = require('../backend/codex-hooks');
  return codexHooks.registerHooks();
}

function uninstallHooks(opts) {
  const codexHooks = require('../backend/codex-hooks');
  return codexHooks.unregisterHooks(opts || {});
}

function markerPresent() {
  const codexHooks = require('../backend/codex-hooks');
  return codexHooks.markerPresent();
}

// ── Provider descriptor ─────────────────────────────────────────────────────
const provider = {
  id: ID,
  displayName: 'Codex',

  dirs: {
    settingsFile: path.join(DATA_HOME, 'config.toml'),
    settingsFormat: 'toml',
    dataHome: DATA_HOME,
    configDir: DATA_HOME,
    envOverride: 'CODEX_HOME',
    // Codex CLI writes session JSONL rollouts here (P10/P11 will use this)
    sessionsDir: path.join(DATA_HOME, 'sessions'),
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
      message_submit:   ['text'],
      tool_call_before: ['tool_name'],
      tool_call_after:  ['tool_name', 'tool_result', 'status'],
      turn_end:         ['status', 'error', 'usage', 'duration_ms'],
      on_error:         ['error', 'reason'],
    },
    notes: 'Codex CLI pipes JSON on stdin for lifecycle hooks (config.toml [[hooks]]). Hook script (codex-hook.js) TBI in P11.',
  },

  permission: {
    // Codex CLI uses in-terminal confirmation by default; the hook system
    // can intercept tool_call_before for permission gating (like CodeWhale).
    // Future rounds may implement a tool_call_before_decision bridge.
    mechanism: 'none',
    notes: 'Codex CLI uses in-terminal confirmation. Permission bubble not yet wired (P11+).',
  },

  transcript: {
    // Codex CLI writes JSONL rollout files in ~/.codex/sessions/.
    // Format TBI — assumed JSONL similar to Claude Code's transcript format.
    rootGlob: 'sessions/*.jsonl',
    format: 'jsonl',
    notes: 'Codex CLI transcripts are JSONL rollout files. Reader TBI in P11.',
  },

  pricing: {
    // Codex CLI reports usage in turn_end. Cost would be computed from
    // OpenAI's pricing catalog (gpt-5, o3, etc.).
    source: 'none',
    notes: 'Codex cost tracking not yet integrated. Would use OpenAI pricing catalog (P11+).',
  },

  capabilities: {
    permissionBubble: false,  // #p11: hooks installed but permission bridge TBI
    metering: false,          // TBI in P11+
    sessionList: false,       // TBI in P11+
    transcriptBubble: false,  // TBI in P11+
    focus: false,             // TBI
    launch: false,            // TBI: find codex binary and open terminal
    greetSleep: true,         // #p11: session_start/session_end hooks installed
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
