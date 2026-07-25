'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode plugin — Octopus pet bridge (#p12)
// ─────────────────────────────────────────────────────────────────────────────
//
// This file is installed to ~/.config/opencode/plugins/octopus.js by the
// opencode provider's installHooks(). OpenCode auto-loads all .js/.ts files
// in that directory at startup.
//
// Plugin structure (from https://opencode.ai/docs/plugins):
//   export const Plugin = async (ctx) => {
//     return {
//       "tool.execute.before": async (input, output) => { ... },
//       "tool.execute.after":  async (input, output) => { ... },
//       "session.idle":        async (input, output) => { ... },
//       ...
//     }
//   }
//
// Hook events we register (mapped to internal pet state machine):
//   tool.execute.before  → PreToolUse / working
//   tool.execute.after   → PostToolUse / working
//   session.idle         → Stop / attention (session completed)
//   chat.prompt          → UserPromptSubmit / thinking (user sent a message)
//   chat.abort           → StopFailure / error
//   message.part.updated → (enrichment only, no state change)
//
// Each hook reads the runtime config (~/.octopus/runtime.json) to find the
// Octopus server port + token, then POSTs a normalized event to /state.
// Best-effort: never throws, never blocks (fire-and-forget HTTP).
//
// Round 12 (#p12): First implementation. The plugin runs INSIDE the opencode
// process (Bun/Node), so we use the http module directly (not transport.js,
// which is a CommonJS module in the Octopus repo).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_PATH = path.join(os.homedir(), '.octopus', 'runtime.json');
const STATE_PATH = '/state';
const POST_TIMEOUT_MS = 2000;
const MARKER = 'octopus-plugin'; // #p12: used by markerPresent() to detect our plugin

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

// Derive a session_id from opencode's session object.
function getSessionId(input) {
  if (!input) return null;
  if (typeof input.session_id === 'string' && input.session_id) return input.session_id;
  if (input.session && typeof input.session.id === 'string') return input.session.id;
  if (input.session && typeof input.session.sessionID === 'string') return input.session.sessionID;
  return null;
}

function getCwd(input) {
  if (!input) return null;
  if (typeof input.cwd === 'string') return input.cwd;
  if (input.session && typeof input.session.cwd === 'string') return input.session.cwd;
  if (input.session && typeof input.session.project === 'string') return input.session.project;
  return null;
}

function getModel(input) {
  if (!input) return null;
  if (typeof input.model === 'string') return input.model;
  if (input.session && typeof input.session.model === 'string') return input.session.model;
  return null;
}

// ── Plugin export (opencode plugin format) ──────────────────────────────────
// OpenCode calls this async function at startup with a context object.
// We return a hooks object mapping event names → handlers.
async function OctopusPlugin(ctx) {
  return {
    // User sent a prompt → thinking state
    'chat.prompt': async (input, output) => {
      const sid = getSessionId(input);
      if (!sid) return;
      postState({
        provider: 'opencode',
        agentId: 'opencode',
        event: 'UserPromptSubmit',
        state: 'thinking',
        session_id: sid,
        cwd: getCwd(input) || undefined,
        model: getModel(input) || undefined,
        background_tasks_count: 0,
        session_crons_count: 0,
      });
    },

    // Tool about to execute → working state
    'tool.execute.before': async (input, output) => {
      const sid = getSessionId(input);
      if (!sid) return;
      const toolName = (input && typeof input.tool === 'string') ? input.tool
        : (input && input.tool && typeof input.tool.name === 'string') ? input.tool.name : 'Unknown';
      postState({
        provider: 'opencode',
        agentId: 'opencode',
        event: 'PreToolUse',
        state: 'working',
        session_id: sid,
        tool_name: toolName,
        cwd: getCwd(input) || undefined,
        model: getModel(input) || undefined,
        background_tasks_count: 0,
        session_crons_count: 0,
      });
    },

    // Tool finished → working state (turn continues)
    'tool.execute.after': async (input, output) => {
      const sid = getSessionId(input);
      if (!sid) return;
      const toolName = (input && typeof input.tool === 'string') ? input.tool
        : (input && input.tool && typeof input.tool.name === 'string') ? input.tool.name : 'Unknown';
      postState({
        provider: 'opencode',
        agentId: 'opencode',
        event: 'PostToolUse',
        state: 'working',
        session_id: sid,
        tool_name: toolName,
        cwd: getCwd(input) || undefined,
        model: getModel(input) || undefined,
        background_tasks_count: 0,
        session_crons_count: 0,
      });
    },

    // Session idle (turn complete) → attention/idle + requiresCompletionAck
    'session.idle': async (input, output) => {
      const sid = getSessionId(input);
      if (!sid) return;
      postState({
        provider: 'opencode',
        agentId: 'opencode',
        event: 'Stop',
        state: 'idle',
        session_id: sid,
        cwd: getCwd(input) || undefined,
        model: getModel(input) || undefined,
        background_tasks_count: 0,
        session_crons_count: 0,
      });
    },

    // Chat aborted → error state
    'chat.abort': async (input, output) => {
      const sid = getSessionId(input);
      if (!sid) return;
      postState({
        provider: 'opencode',
        agentId: 'opencode',
        event: 'StopFailure',
        state: 'error',
        session_id: sid,
        api_error_type: 'aborted',
        cwd: getCwd(input) || undefined,
        model: getModel(input) || undefined,
        background_tasks_count: 0,
        session_crons_count: 0,
      });
    },
  };
}

// Export both as default and named for compatibility with different opencode
// plugin loader versions.
module.exports = OctopusPlugin;
module.exports.OctopusPlugin = OctopusPlugin;
module.exports.MARKER = MARKER;
module.exports._postState = postState; // for testing
module.exports._readRuntime = readRuntime; // for testing
