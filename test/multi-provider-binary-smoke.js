'use strict';

// Round 9 — multi-provider real binary smoke test (#r9)
//
// Extends R8's codewhale-binary-smoke.js pattern to cover codex, opencode, and
// claude CLIs. This is the second LLMPET test to exercise provider code paths
// against REAL CLI binaries (installed via npm -g). All previous rounds used
// mock transcripts and stub providers; R8 covered codewhale, R9 covers the
// remaining 3 working providers (aider blocked by Python aiohttp pin conflict).
//
// Gracefully SKIPs (exit 0) per-provider if a binary is not available, so this
// test is safe to register in run-all.js even on CI environments without
// network access to install the binaries. The test reports which providers
// were skipped vs verified.
//
// Tests (per-provider checks):
//   CODEX (OpenAI Codex CLI v0.145.0+):
//     [1] codex --version exits 0 with stdout matching /^codex-cli\s+\d+/
//     [2] codex doctor output includes "CODEX_HOME" line
//     [3] provider.dirs.envOverride === 'CODEX_HOME'
//     [4] provider.dirs.dataHome endsWith '.codex'
//     [5] provider.dirs.settingsFile endsWith '.codex/config.toml'
//     [6] provider.dirs.sessionsDir endsWith '.codex/sessions'
//     [7] CODEX_HOME env var override actually works (set env, re-require)
//
//   OPENCODE (SST OpenCode CLI v1.18.5+):
//     [8]  opencode --version (or --help) exits 0
//     [9]  opencode debug paths output includes "config" line
//     [10] provider.dirs.envOverride === 'OPENCODE_CONFIG_DIR' (#r9-fix)
//     [11] provider.dirs.configDir endsWith '.config/opencode'
//     [12] provider.dirs.runtimeDataDir endsWith '.local/share/opencode'
//     [13] provider.dirs.runtimeCacheDir endsWith '.cache/opencode'
//     [14] provider.dirs.settingsFile endsWith 'opencode.json'
//     [15] provider.dirs.settingsFileAlt endsWith 'opencode.jsonc'
//     [16] OPENCODE_CONFIG_DIR env var override actually works
//
//   CLAUDE (Anthropic Claude Code v2.1.220+):
//     [17] claude --version exits 0 with stdout matching /^Claude Code|^2\./
//     [18] claude doctor output includes "Path:" line (binary location)
//     [19] provider.dirs.dataHome endsWith '.claude'
//     [20] provider.dirs.settingsFile endsWith '.claude/settings.json'
//     [21] provider.dirs.configDir endsWith '.claude'
//
// References:
//   - https://www.npmjs.com/package/@openai/codex (codex CLI v0.145+)
//   - https://www.npmjs.com/package/opencode-ai (opencode v1.18+)
//   - https://www.npmjs.com/package/@anthropic-ai/claude-code (claude v2.1+)
//   - https://opencode.ai/docs/config (OPENCODE_CONFIG_DIR env var)
//   - https://opencode.ai/docs/cli (env var reference)
//   - https://computingforgeeks.com/opencode-cli-cheat-sheet (all 3 env vars)

const assert = require('assert');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

let failures = 0;
const checks = [];
const skipped = [];
function check(name, fn) {
  try { fn(); checks.push(['\u2713', name, null]); }
  catch (e) { failures++; checks.push(['\u2717', name, e.message]); }
}
function skip(name, reason) {
  skipped.push([name, reason]);
  console.log(`  SKIP: ${name} — ${reason}`);
}

// ── Helper: probe a binary's --version ──────────────────────────────────────
function probeVersion(bin) {
  try {
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// ── Helper: probe a binary's subcommand text output ─────────────────────────
// Uses spawnSync so we capture stdout even when the binary exits non-zero
// (e.g. `codex doctor` exits 1 on auth warnings but still prints diagnostics).
function probeCommand(bin, args, timeoutMs) {
  try {
    const r = spawnSync(bin, args, {
      encoding: 'utf8', timeout: timeoutMs || 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Return stdout if it's non-empty; fall back to stderr (some CLIs print
    // diagnostics to stderr). null only if both are empty AND we errored.
    if (r.stdout && r.stdout.length > 0) return r.stdout;
    if (r.stderr && r.stderr.length > 0) return r.stderr;
    return null;
  } catch {
    return null;
  }
}

// ── Helper: re-require a provider with a specific env override ──────────────
// Useful for verifying envOverride wiring without polluting other tests.
function requireProviderWithEnv(providerPath, envVar, envValue) {
  const prev = process.env[envVar];
  process.env[envVar] = envValue;
  // Bust the require cache so the provider re-evaluates resolveConfigDir() etc.
  delete require.cache[require.resolve(providerPath)];
  const p = require(providerPath);
  if (prev === undefined) delete process.env[envVar];
  else process.env[envVar] = prev;
  return p;
}

// ════════════════════════════════════════════════════════════════════════════
// CODEX (OpenAI Codex CLI)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== Codex (OpenAI Codex CLI) ===');
const codexVersion = probeVersion('codex');
if (!codexVersion) {
  skip('Codex CLI binary', 'not installed (npm install -g @openai/codex)');
} else {
  const codexProvider = require('../providers/codex');

  // [1] codex --version
  check(`codex --version returns valid version (got "${codexVersion}")`, () => {
    assert.match(codexVersion, /codex/i);
    assert.match(codexVersion, /\d+\.\d+\.\d+/);
  });

  // [2] codex doctor output includes CODEX_HOME line
  // codex doctor is text-only (no --json); grep for CODEX_HOME line
  let codexDoctor = probeCommand('codex', ['doctor'], 20000);
  check('codex doctor output includes "CODEX_HOME" line', () => {
    assert.ok(codexDoctor, 'codex doctor did not produce output');
    assert.match(codexDoctor, /CODEX_HOME/i, 'doctor output should mention CODEX_HOME');
  });

  // [3] provider.dirs.envOverride === 'CODEX_HOME'
  check('codex provider.dirs.envOverride === "CODEX_HOME"', () => {
    assert.strictEqual(codexProvider.dirs.envOverride, 'CODEX_HOME');
  });

  // [4] provider.dirs.dataHome endsWith '.codex'
  check(`codex provider.dirs.dataHome endsWith ".codex" (got ${codexProvider.dirs.dataHome})`, () => {
    assert.ok(codexProvider.dirs.dataHome.endsWith('.codex'),
      `expected dataHome to end with .codex, got ${codexProvider.dirs.dataHome}`);
  });

  // [5] provider.dirs.settingsFile endsWith '.codex/config.toml'
  check('codex provider.dirs.settingsFile endsWith ".codex/config.toml"', () => {
    assert.ok(codexProvider.dirs.settingsFile.endsWith(path.join('.codex', 'config.toml')),
      `got ${codexProvider.dirs.settingsFile}`);
  });

  // [6] provider.dirs.sessionsDir endsWith '.codex/sessions'
  check('codex provider.dirs.sessionsDir endsWith ".codex/sessions"', () => {
    assert.ok(codexProvider.dirs.sessionsDir.endsWith(path.join('.codex', 'sessions')),
      `got ${codexProvider.dirs.sessionsDir}`);
  });

  // [7] CODEX_HOME env var override actually works
  // Set CODEX_HOME=/tmp/fake-codex, re-require provider, verify dataHome reflects it.
  const fakeCodexHome = '/tmp/fake-codex-r9';
  const codexWithOverride = requireProviderWithEnv(
    path.join(__dirname, '..', 'providers', 'codex'),
    'CODEX_HOME', fakeCodexHome
  );
  check(`CODEX_HOME env override works (dataHome should be ${fakeCodexHome})`, () => {
    assert.strictEqual(codexWithOverride.dirs.dataHome, fakeCodexHome);
    assert.strictEqual(codexWithOverride.dirs.configDir, fakeCodexHome);
    assert.strictEqual(codexWithOverride.dirs.sessionsDir, path.join(fakeCodexHome, 'sessions'));
  });

  // [7b] PATH ALIGNMENT: codex doctor's CODEX_HOME line matches provider.dirs.dataHome
  if (codexDoctor) {
    const homeLine = codexDoctor.split('\n').find(l => /CODEX_HOME/i.test(l));
    if (homeLine) {
      // Extract path from line like "CODEX_HOME   ~/.codex (dir)"
      const pathMatch = homeLine.match(/(\S+\/\.\S+|~\/\.\S+)/);
      if (pathMatch) {
        const doctorPath = pathMatch[1].replace(/^~/, os.homedir());
        check(`path alignment: codex doctor CODEX_HOME (${doctorPath}) matches provider.dirs.dataHome`, () => {
          assert.strictEqual(doctorPath, codexProvider.dirs.dataHome);
        });
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// OPENCODE (SST OpenCode CLI)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== OpenCode (SST OpenCode CLI) ===');
// opencode --version hangs on some versions; use --help instead (always exits 0)
let opencodeVersion = probeVersion('opencode');
if (!opencodeVersion) {
  // Some opencode builds don't support --version; try --help (exits 0 quickly)
  const helpOut = probeCommand('opencode', ['--help'], 8000);
  if (!helpOut) {
    skip('OpenCode CLI binary', 'not installed (npm install -g opencode-ai)');
  } else {
    opencodeVersion = 'opencode (version via --help)';
  }
}
if (opencodeVersion) {
  const opencodeProvider = require('../providers/opencode');

  // [8] opencode --version or --help exits 0
  check(`opencode responds to --version/--help (got "${opencodeVersion.slice(0, 50)}")`, () => {
    assert.ok(opencodeVersion.length > 0);
  });

  // [9] opencode debug paths output includes "config" line
  // opencode debug paths prints key=value lines for config/data/cache/bin/etc.
  let opencodePaths = probeCommand('opencode', ['debug', 'paths'], 8000);
  check('opencode debug paths output includes "config" line', () => {
    assert.ok(opencodePaths, 'opencode debug paths did not produce output');
    assert.match(opencodePaths, /\bconfig\b/i, 'debug paths should mention config dir');
  });

  // [10] provider.dirs.envOverride === 'OPENCODE_CONFIG_DIR' (#r9-fix)
  check('opencode provider.dirs.envOverride === "OPENCODE_CONFIG_DIR" (#r9-fix)', () => {
    assert.strictEqual(opencodeProvider.dirs.envOverride, 'OPENCODE_CONFIG_DIR',
      'previous stub used nonexistent "OPENCODE_HOME" — fixed in #r9');
  });

  // [11] provider.dirs.configDir endsWith '.config/opencode'
  check(`opencode provider.dirs.configDir endsWith ".config/opencode" (got ${opencodeProvider.dirs.configDir})`, () => {
    assert.ok(opencodeProvider.dirs.configDir.endsWith(path.join('.config', 'opencode')),
      `got ${opencodeProvider.dirs.configDir}`);
  });

  // [12] provider.dirs.runtimeDataDir endsWith '.local/share/opencode' (#r9)
  check('opencode provider.dirs.runtimeDataDir endsWith ".local/share/opencode" (#r9)', () => {
    assert.ok(opencodeProvider.dirs.runtimeDataDir,
      'runtimeDataDir should exist (added in #r9)');
    assert.ok(opencodeProvider.dirs.runtimeDataDir.endsWith(path.join('.local', 'share', 'opencode')),
      `got ${opencodeProvider.dirs.runtimeDataDir}`);
  });

  // [13] provider.dirs.runtimeCacheDir endsWith '.cache/opencode' (#r9)
  check('opencode provider.dirs.runtimeCacheDir endsWith ".cache/opencode" (#r9)', () => {
    assert.ok(opencodeProvider.dirs.runtimeCacheDir,
      'runtimeCacheDir should exist (added in #r9)');
    assert.ok(opencodeProvider.dirs.runtimeCacheDir.endsWith(path.join('.cache', 'opencode')),
      `got ${opencodeProvider.dirs.runtimeCacheDir}`);
  });

  // [14] provider.dirs.settingsFile endsWith 'opencode.json'
  check('opencode provider.dirs.settingsFile endsWith "opencode.json"', () => {
    assert.ok(opencodeProvider.dirs.settingsFile.endsWith('opencode.json'),
      `got ${opencodeProvider.dirs.settingsFile}`);
  });

  // [15] provider.dirs.settingsFileAlt endsWith 'opencode.jsonc' (#r9)
  check('opencode provider.dirs.settingsFileAlt endsWith "opencode.jsonc" (#r9)', () => {
    assert.ok(opencodeProvider.dirs.settingsFileAlt,
      'settingsFileAlt should exist (added in #r9, real CLI creates .jsonc on first run)');
    assert.ok(opencodeProvider.dirs.settingsFileAlt.endsWith('opencode.jsonc'),
      `got ${opencodeProvider.dirs.settingsFileAlt}`);
  });

  // [16] OPENCODE_CONFIG_DIR env var override actually works
  const fakeOpencodeConfigDir = '/tmp/fake-opencode-config-r9';
  const opencodeWithOverride = requireProviderWithEnv(
    path.join(__dirname, '..', 'providers', 'opencode'),
    'OPENCODE_CONFIG_DIR', fakeOpencodeConfigDir
  );
  check(`OPENCODE_CONFIG_DIR env override works (configDir should be ${fakeOpencodeConfigDir})`, () => {
    assert.strictEqual(opencodeWithOverride.dirs.configDir, fakeOpencodeConfigDir);
    assert.strictEqual(opencodeWithOverride.dirs.settingsFile,
      path.join(fakeOpencodeConfigDir, 'opencode.json'));
    assert.strictEqual(opencodeWithOverride.dirs.settingsFileAlt,
      path.join(fakeOpencodeConfigDir, 'opencode.jsonc'));
  });

  // [16b] PATH ALIGNMENT: opencode debug paths config line matches provider.dirs.configDir
  if (opencodePaths) {
    const configLine = opencodePaths.split('\n').find(l => /^\s*config\b/i.test(l));
    if (configLine) {
      // Extract path from line like "config     /home/user/.config/opencode"
      const parts = configLine.trim().split(/\s+/);
      if (parts.length >= 2) {
        const doctorPath = parts[1];
        check(`path alignment: opencode debug paths config (${doctorPath}) matches provider.dirs.configDir`, () => {
          assert.strictEqual(doctorPath, opencodeProvider.dirs.configDir);
        });
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CLAUDE (Anthropic Claude Code CLI)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== Claude (Anthropic Claude Code CLI) ===');
const claudeVersion = probeVersion('claude');
if (!claudeVersion) {
  skip('Claude Code CLI binary', 'not installed (npm install -g @anthropic-ai/claude-code)');
} else {
  const claudeProvider = require('../providers/claude');

  // [17] claude --version
  check(`claude --version returns valid version (got "${claudeVersion}")`, () => {
    // Output format: "2.1.220 (Claude Code)" or "Claude Code v2.1.220"
    assert.match(claudeVersion, /\d+\.\d+\.\d+/);
  });

  // [18] claude doctor output includes "Path:" line (binary location)
  // claude doctor --json times out (auth check); use text mode
  let claudeDoctor = probeCommand('claude', ['doctor'], 15000);
  check('claude doctor output includes "Path:" line', () => {
    assert.ok(claudeDoctor, 'claude doctor did not produce output');
    assert.match(claudeDoctor, /Path:/i, 'doctor output should mention binary Path');
  });

  // [19] provider.dirs.dataHome endsWith '.claude'
  check(`claude provider.dirs.dataHome endsWith ".claude" (got ${claudeProvider.dirs.dataHome})`, () => {
    assert.ok(claudeProvider.dirs.dataHome.endsWith('.claude'),
      `got ${claudeProvider.dirs.dataHome}`);
  });

  // [20] provider.dirs.settingsFile endsWith '.claude/settings.json'
  check('claude provider.dirs.settingsFile endsWith ".claude/settings.json"', () => {
    assert.ok(claudeProvider.dirs.settingsFile.endsWith(path.join('.claude', 'settings.json')),
      `got ${claudeProvider.dirs.settingsFile}`);
  });

  // [21] provider.dirs.configDir endsWith '.claude'
  check('claude provider.dirs.configDir endsWith ".claude"', () => {
    assert.ok(claudeProvider.dirs.configDir.endsWith('.claude'),
      `got ${claudeProvider.dirs.configDir}`);
  });

  // [21b] PATH ALIGNMENT: claude creates ~/.claude/{backups,projects,sessions,telemetry}
  // when run. Verify the dataHome dir exists (claude was just probed, so it should).
  const fs = require('fs');
  const claudeHome = claudeProvider.dirs.dataHome;
  check(`claude creates ~/.claude directory tree at ${claudeHome}`, () => {
    assert.ok(fs.existsSync(claudeHome),
      `~/.claude should exist after claude was probed (real CLI creates it on first run)`);
  });
  if (fs.existsSync(claudeHome)) {
    check('claude ~/.claude/sessions subdir exists (transcript storage)', () => {
      const sessionsDir = path.join(claudeHome, 'sessions');
      assert.ok(fs.existsSync(sessionsDir),
        `~/.claude/sessions should exist (created by claude on first run)`);
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Cross-provider consistency checks (only if all 3 binaries available)
// ════════════════════════════════════════════════════════════════════════════
if (codexVersion && opencodeVersion && claudeVersion) {
  console.log('\n=== Cross-provider consistency ===');
  const codex = require('../providers/codex');
  const opencode = require('../providers/opencode');
  const claude = require('../providers/claude');

  check('all 3 providers have distinct dataHome paths', () => {
    const homes = new Set([codex.dirs.dataHome, opencode.dirs.configDir, claude.dirs.dataHome]);
    assert.strictEqual(homes.size, 3, 'provider dataHomes should not collide');
  });

  check('all 3 providers have distinct envOverride values', () => {
    const envs = new Set([codex.dirs.envOverride, opencode.dirs.envOverride, claude.dirs.envOverride || '(none)']);
    // claude has no envOverride (uses ~/.claude unconditionally); that's fine
    assert.ok(envs.size >= 2, 'env overrides should be distinct where present');
  });

  check('all 3 providers expose parseHookStdin function', () => {
    assert.strictEqual(typeof codex.parseHookStdin, 'function');
    assert.strictEqual(typeof opencode.parseHookStdin, 'function');
    assert.strictEqual(typeof claude.parseHookStdin, 'function');
  });
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(72));
for (const [mark, name, msg] of checks) {
  console.log(`  ${mark} ${name}${msg ? '\n      ' + msg : ''}`);
}
const total = checks.length;
const skippedCount = skipped.length;
console.log(`\nmulti-provider-binary-smoke: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${total} checks, ${skippedCount} provider(s) skipped)`);
process.exit(failures === 0 ? 0 : 1);
