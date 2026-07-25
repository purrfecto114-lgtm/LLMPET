'use strict';

// Merge-safe Aider notification bridge installer.
//
// Aider config is ~/.aider.conf.yml (YAML). We add a `notifications_command`
// line pointing to our aider-hook.js bridge. Aider's notification system runs
// this command (via shell, no args) when the LLM response is ready.
//
// This installer:
//   1. Reads existing ~/.aider.conf.yml (if any)
//   2. Removes any existing `notifications_command:` line containing our marker
//   3. Adds `notifications_command: "node /abs/path/aider-hook.js"`
//   4. Also sets `notifications: true` (required for the command to fire)
//   5. Writes atomically (tmp + rename, mode 0o600)
//   6. Never touches other YAML keys/comments
//
// Round 18 (#p21): First implementation. Aider has no full hook system —
// this only gives turn_end events (pet shows "done" when aider finishes).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');
const { readTextBoundedSync } = require('./safe-json');

const aider = require('../providers/aider');

const MARKER = 'aider-hook.js'; // #p21: identifies our notifications_command line
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'aider-hook.js');
const MAX_CONFIG_BYTES = 1 * 1024 * 1024;
const ENABLE_NOTIFICATIONS = true;

function getConfigPath() {
  return aider.dirs.settingsFile; // ~/.aider.conf.yml
}

// Build the command string: `node /abs/path/aider-hook.js`
// Forward slashes work on all platforms (Node resolves them).
function buildCommand() {
  const scriptPosix = HOOK_SCRIPT.split(path.sep).join('/');
  return `node "${scriptPosix}"`;
}

// Check if a line is our notifications_command line.
function isOurNotifLine(line) {
  return typeof line === 'string' &&
    /^\s*notifications_command\s*:/.test(line) &&
    line.includes(MARKER);
}

// Check if a line is ANY notifications_command line (including non-octopus).
function isAnyNotifLine(line) {
  return typeof line === 'string' && /^\s*notifications_command\s*:/.test(line);
}

// Check if a line is the `notifications:` boolean key.
function isNotificationsBoolLine(line) {
  return typeof line === 'string' && /^\s*notifications\s*:\s*(true|false)\s*$/.test(line);
}

function registerHooks() {
  const configPath = getConfigPath();
  let content = '';
  try {
    content = readTextBoundedSync(configPath, MAX_CONFIG_BYTES);
  } catch {
    content = ''; // file doesn't exist — create new
  }

  const lines = content.split('\n');
  const out = [];
  let replacedOurLine = false;
  let hasNotifBool = false;
  let notifBoolValue = false;

  for (const line of lines) {
    if (isOurNotifLine(line)) {
      // Replace our existing line
      out.push(`notifications_command: "${buildCommand()}"  # ${MARKER}`);
      replacedOurLine = true;
    } else if (isAnyNotifLine(line)) {
      // Non-octopus notifications_command — preserve it, DON'T add ours
      // (aider only supports one notifications_command)
      out.push(line);
      // Log a warning
      log('aider-hooks', `WARNING: existing non-octopus notifications_command found, not overwriting`);
      return { added: 0, updated: 0, skipped: 1, collision: true, configPath };
    } else if (isNotificationsBoolLine(line)) {
      notifBoolValue = /true/.test(line.trim());
      hasNotifBool = true;
      if (ENABLE_NOTIFICATIONS && !notifBoolValue) {
        out.push('notifications: true');
      } else {
        out.push(line);
      }
    } else {
      out.push(line);
    }
  }

  // If no existing notifications_command (ours or other), add ours
  if (!replacedOurLine && !out.some(isAnyNotifLine)) {
    out.push(`notifications_command: "${buildCommand()}"  # ${MARKER}`);
  }

  // If no notifications: bool line, add one (required for command to fire)
  if (!hasNotifBool) {
    out.push('notifications: true');
  }

  // Write atomically
  const newContent = out.join('\n');
  if (newContent === content) {
    return { added: 0, updated: 0, skipped: 1, configPath, upToDate: true };
  }

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.aider.conf.${process.pid}.${Date.now()}.yml.tmp`);
  fs.writeFileSync(tmp, newContent, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch {}

  log('aider-hooks', `installed notifications_command -> ${configPath}`);
  return { added: 1, updated: replacedOurLine ? 1 : 0, skipped: 0, configPath };
}

function unregisterHooks(opts = {}) {
  const configPath = getConfigPath();
  let removed = 0;

  try {
    const content = readTextBoundedSync(configPath, MAX_CONFIG_BYTES);
    const lines = content.split('\n');
    const out = [];
    let hadOurLine = false;

    for (const line of lines) {
      if (isOurNotifLine(line)) {
        removed++;
        hadOurLine = true;
        // Skip this line (remove it)
      } else {
        out.push(line);
      }
    }

    if (!hadOurLine) {
      return { removed: 0, configPath, skipped: true };
    }

    // Write back without our line
    const newContent = out.join('\n').replace(/\n{3,}/g, '\n\n'); // collapse extra blank lines
    const dir = path.dirname(configPath);
    const tmp = path.join(dir, `.aider.conf.${process.pid}.${Date.now()}.yml.tmp`);
    fs.writeFileSync(tmp, newContent, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, configPath);
    try { fs.chmodSync(configPath, 0o600); } catch {}

    log('aider-hooks', `uninstalled notifications_command from ${configPath}`);
    return { removed, configPath };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('aider-hooks', 'uninstall failed:', err.message);
    }
    return { removed: 0, configPath, error: err.message };
  }
}

function markerPresent() {
  try {
    const content = readTextBoundedSync(getConfigPath(), MAX_CONFIG_BYTES);
    const lines = content.split('\n');
    return lines.some(isOurNotifLine);
  } catch {
    return false;
  }
}

module.exports = {
  registerHooks,
  unregisterHooks,
  markerPresent,
  getConfigPath,
  buildCommand,
  MARKER,
  HOOK_SCRIPT,
  _isOurNotifLine: isOurNotifLine,
  _isAnyNotifLine: isAnyNotifLine,
};
