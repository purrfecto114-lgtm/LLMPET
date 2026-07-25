'use strict';

// Merge-safe Codex hook installer.
//
// Codex CLI (v0.145.0+) uses a `hooks.json` sidecar file referenced from
// `~/.codex/config.toml` via `hooks = "./hooks.json"`. The hooks.json format
// (discovered via binary strings analysis, Round 11):
//
//   {
//     "hooks": {
//       "session_start": [{"command": "...", "timeoutSec": 5}],
//       "turn_end":      [{"command": "...", "timeoutSec": 5}],
//       ...
//     }
//   }
//
// Key fields per hook entry (from codex binary `ConfiguredHookHandler::Command`):
//   - command (string, required): shell command to run
//   - timeoutSec (number, optional, default 5): timeout in seconds
//   - async (bool, optional, default false): run without blocking
//
// This installer:
//   1. Reads existing hooks.json (if any), parses JSON
//   2. Removes any entry whose command contains our marker (idempotent)
//   3. Adds our entries for the 7 registered events
//   4. Writes atomically (tmp + rename, mode 0o600)
//   5. Also ensures `hooks = "./hooks.json"` exists in config.toml
//      (merge-safe: only adds if missing, never modifies existing lines)
//
// Round 11 (#p11): First implementation. Permission bridge NOT yet wired —
// Codex's permission_request event has a different schema than CodeWhale's
// tool_call_before. Future rounds may add /codex-permission endpoint.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');
const { readTextBoundedSync } = require('./safe-json');

const codex = require('../providers/codex');

const MARKER = codex.hookMarker; // 'codex-hook.js'
const HOOK_SCRIPT = codex.hookScript; // /abs/path/hook/codex-hook.js
const HOOK_EVENTS = codex.hookEvents; // ['session_start', 'session_end', ...]

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_HOOKS_JSON_BYTES = 1 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 5;

function getHooksJsonPath() {
  return path.join(codex.dirs.dataHome, 'hooks.json');
}

function getConfigTomlPath() {
  return codex.dirs.settingsFile; // ~/.codex/config.toml
}

// Build the command string for a given event.
// `node /abs/path/codex-hook.js <event>` — forward slashes work on all platforms.
function buildCommand(event) {
  const scriptPosix = HOOK_SCRIPT.split(path.sep).join('/');
  return `node "${scriptPosix}" ${event}`;
}

// Parse existing hooks.json safely. Returns {} on missing/corrupt.
function readHooksJson(filePath) {
  try {
    const raw = readTextBoundedSync(filePath, MAX_HOOKS_JSON_BYTES);
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.hooks && typeof obj.hooks === 'object') {
      return obj;
    }
  } catch {}
  return { hooks: {} };
}

// Check if a command string belongs to us (contains our marker).
function isOurCommand(command) {
  return typeof command === 'string' && command.includes(MARKER);
}

// Remove all our entries from a hooks object. Returns the cleaned hooks object.
function removeOurEntries(hooksObj) {
  const out = {};
  for (const [event, entries] of Object.entries(hooksObj)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => {
      if (!e || typeof e !== 'object') return true;
      return !isOurCommand(e.command);
    });
    if (kept.length) out[event] = kept;
  }
  return out;
}

// Add our entries for all registered events.
function addOurEntries(hooksObj) {
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(hooksObj[event])) hooksObj[event] = [];
    // Avoid duplicates: remove our existing entries first
    hooksObj[event] = hooksObj[event].filter((e) => !isOurCommand(e && e.command));
    hooksObj[event].push({
      command: buildCommand(event),
      timeoutSec: DEFAULT_TIMEOUT_SEC,
    });
  }
  return hooksObj;
}

// Write hooks.json atomically with restrictive permissions.
function writeHooksJson(filePath, hooksObj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = path.join(dir, `.hooks.${process.pid}.${Date.now()}.json.tmp`);
  const content = JSON.stringify({ hooks: hooksObj }, null, 2) + '\n';
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

// Ensure `hooks = "./hooks.json"` exists in config.toml (merge-safe).
// Only adds the line if missing; never modifies existing content.
function ensureConfigTomlReference(configPath) {
  let content = '';
  try {
    content = readTextBoundedSync(configPath, MAX_CONFIG_BYTES);
  } catch {
    // File doesn't exist — we'll create it with just our reference.
    content = '';
  }

  // Check if the reference already exists (any line matching hooks = "..."hooks.json)
  const lines = content.split('\n');
  let hasRef = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^hooks\s*=\s*["']\.?\/?hooks\.json["']/.test(trimmed)) {
      hasRef = true;
      break;
    }
  }

  if (hasRef) return false; // already present, no change

  // Append the reference. If content is non-empty and doesn't end with newline, add one.
  const addition = (content && !content.endsWith('\n') ? '\n' : '') +
    '# Added by Octopus pet — hook system entrypoint\n' +
    'hooks = "./hooks.json"\n';

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.toml.tmp`);
  fs.writeFileSync(tmp, content + addition, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch {}
  return true;
}

function registerHooks() {
  const hooksJsonPath = getHooksJsonPath();
  const configTomlPath = getConfigTomlPath();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  // 1. Read + modify hooks.json
  const existing = readHooksJson(hooksJsonPath);
  const beforeKeys = Object.keys(existing.hooks || {});
  const cleaned = removeOurEntries(existing.hooks || {});
  const withOurs = addOurEntries(cleaned);

  // Count changes
  added = HOOK_EVENTS.length;
  updated = beforeKeys.length > 0 ? 1 : 0;

  writeHooksJson(hooksJsonPath, withOurs);

  // 2. Ensure config.toml references hooks.json
  let configChanged = false;
  try {
    configChanged = ensureConfigTomlReference(configTomlPath);
  } catch (err) {
    log('codex-hooks', 'config.toml reference failed:', err.message);
  }

  log('codex-hooks', `installed: ${added} events -> ${hooksJsonPath}${configChanged ? ' (+ config.toml reference)' : ''}`);

  return { added, updated, skipped, hooksJsonPath, configTomlPath, configChanged };
}

function unregisterHooks(opts = {}) {
  const hooksJsonPath = getHooksJsonPath();
  let removed = 0;

  try {
    const existing = readHooksJson(hooksJsonPath);
    const before = Object.values(existing.hooks || {}).flat().length;
    const cleaned = removeOurEntries(existing.hooks || {});
    const after = Object.values(cleaned).flat().length;
    removed = before - after;

    if (after === 0) {
      // All hooks were ours — remove the file entirely
      try { fs.unlinkSync(hooksJsonPath); } catch {}
      log('codex-hooks', `uninstalled: removed ${removed} entries, deleted ${path.basename(hooksJsonPath)}`);
    } else {
      // Other hooks remain — write back the cleaned version
      writeHooksJson(hooksJsonPath, cleaned);
      log('codex-hooks', `uninstalled: removed ${removed} entries, kept ${after} non-octopus entries`);
    }
  } catch (err) {
    log('codex-hooks', 'uninstall failed:', err.message);
  }

  // Note: we do NOT remove the `hooks = "./hooks.json"` line from config.toml.
  // The user may have other hooks; removing the reference would break them.
  // The hooks.json file itself signals "no hooks" by being absent or empty.

  let backupPath = null;
  if (opts.backup) {
    // Best-effort backup (not critical for codex since hooks.json is JSON, easily rebuilt)
  }

  return { removed, backupPath };
}

function markerPresent() {
  const hooksJsonPath = getHooksJsonPath();
  const existing = readHooksJson(hooksJsonPath);
  for (const entries of Object.values(existing.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (e && typeof e === 'object' && isOurCommand(e.command)) return true;
    }
  }
  return false;
}

module.exports = {
  registerHooks,
  unregisterHooks,
  markerPresent,
  getHooksJsonPath,
  getConfigTomlPath,
  buildCommand,
  _removeOurEntries: removeOurEntries,
  _addOurEntries: addOurEntries,
  _readHooksJson: readHooksJson,
  MARKER,
  HOOK_EVENTS,
};
