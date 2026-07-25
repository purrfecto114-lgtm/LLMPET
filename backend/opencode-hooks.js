'use strict';

// Merge-safe OpenCode plugin installer.
//
// OpenCode auto-loads all .js/.ts files in ~/.config/opencode/plugins/ at
// startup. We install our plugin as `octopus.js` in that directory.
//
// This installer:
//   1. Copies hook/opencode-plugin.js to ~/.config/opencode/plugins/octopus.js
//   2. Idempotent: re-running installHooks() overwrites our file (content hash check)
//   3. Atomic write (tmp + rename, mode 0o600)
//   4. Never touches other plugins in the directory
//
// Round 12 (#p12): First implementation. The plugin file is self-contained
// (uses only Node http/fs/os/path built-ins, no external deps) so it works
// in both Node and Bun runtimes.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { log } = require('./log');
const { readTextBoundedSync } = require('./safe-json');

const opencode = require('../providers/opencode');

const PLUGIN_NAME = 'octopus.js';
const MARKER = 'octopus-plugin'; // #p12: must match hook/opencode-plugin.js MARKER
const SOURCE_PLUGIN = path.join(__dirname, '..', 'hook', 'opencode-plugin.js');
const MAX_PLUGIN_BYTES = 1 * 1024 * 1024;

function getPluginsDir() {
  return path.join(opencode.dirs.configDir, 'plugins');
}

function getPluginPath() {
  return path.join(getPluginsDir(), PLUGIN_NAME);
}

// Read our source plugin template.
function readSourcePlugin() {
  return fs.readFileSync(SOURCE_PLUGIN, 'utf8');
}

// Check if a file contains our marker (identifies it as our plugin).
function isOurPlugin(content) {
  return typeof content === 'string' && content.includes(MARKER);
}

// Check if the installed plugin is up-to-date (content hash matches source).
function isUpToDate(installedPath, sourceContent) {
  try {
    const installed = fs.readFileSync(installedPath, 'utf8');
    if (!isOurPlugin(installed)) return false;
    const installedHash = crypto.createHash('sha256').update(installed).digest('hex');
    const sourceHash = crypto.createHash('sha256').update(sourceContent).digest('hex');
    return installedHash === sourceHash;
  } catch {
    return false;
  }
}

// Write the plugin file atomically with restrictive permissions.
function writePlugin(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = path.join(dir, `.octopus.${process.pid}.${Date.now()}.js.tmp`);
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function registerHooks() {
  const pluginPath = getPluginPath();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  const sourceContent = readSourcePlugin();

  // Check if already up-to-date
  if (isUpToDate(pluginPath, sourceContent)) {
    skipped = 1;
    log('opencode-hooks', `plugin already up-to-date: ${pluginPath}`);
    return { added, updated, skipped, pluginPath, sourcePlugin: SOURCE_PLUGIN };
  }

  // Check if a non-octopus file exists at our path (collision)
  try {
    const existing = fs.readFileSync(pluginPath, 'utf8');
    if (!isOurPlugin(existing)) {
      log('opencode-hooks', `WARNING: non-octopus file exists at ${pluginPath}, skipping`);
      return { added: 0, updated: 0, skipped: 0, pluginPath, collision: true };
    }
    updated = 1; // replacing our previous version
  } catch {
    added = 1; // new install
  }

  writePlugin(pluginPath, sourceContent);
  log('opencode-hooks', `installed plugin: ${pluginPath}${updated ? ' (updated)' : ' (new)'}`);

  return { added, updated, skipped, pluginPath, sourcePlugin: SOURCE_PLUGIN };
}

function unregisterHooks(opts = {}) {
  const pluginPath = getPluginPath();
  let removed = 0;
  let backupPath = null;

  try {
    const content = fs.readFileSync(pluginPath, 'utf8');
    if (!isOurPlugin(content)) {
      log('opencode-hooks', `WARNING: ${pluginPath} is not our plugin, not removing`);
      return { removed: 0, backupPath: null, skipped: true };
    }

    if (opts.backup) {
      backupPath = pluginPath + '.bak';
      try { fs.copyFileSync(pluginPath, backupPath); } catch {}
    }

    fs.unlinkSync(pluginPath);
    removed = 1;
    log('opencode-hooks', `uninstalled plugin: ${pluginPath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('opencode-hooks', 'uninstall failed:', err.message);
    }
    // File doesn't exist — nothing to remove
  }

  return { removed, backupPath };
}

function markerPresent() {
  try {
    const content = fs.readFileSync(getPluginPath(), 'utf8');
    return isOurPlugin(content);
  } catch {
    return false;
  }
}

module.exports = {
  registerHooks,
  unregisterHooks,
  markerPresent,
  getPluginsDir,
  getPluginPath,
  MARKER,
  PLUGIN_NAME,
  _isOurPlugin: isOurPlugin,
  _isUpToDate: isUpToDate,
};
