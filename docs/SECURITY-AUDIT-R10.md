# LLMPET Global Security Audit — Round 10 (2026-07-25)

## Executive Summary

A comprehensive security audit was performed across the entire LLMPET fork
codebase. **No critical or high-severity vulnerabilities were found.** The
codebase demonstrates strong security practices throughout. Two low-severity
defensive hardening improvements were applied.

## Audit Scope

| Area | Files Scanned | Method |
|------|---------------|--------|
| Command injection | backend/ (exec/spawn/execFile) | grep + manual review |
| Path traversal | backend/server.js, transcript.js | code review of normTranscriptPath |
| Prototype pollution | backend/metering-state.js, permission.js | grep __proto__/constructor + code review |
| ReDoS | backend/ (all RegExp usage) | grep + pattern analysis |
| Secrets in code | all .js files | grep ghp_/sk-/AKIA patterns |
| XSS | renderer/pet.js, panel.js, icons.js | grep innerHTML + escapeHtml review |
| Insecure HTTP | backend/ (http://) | grep |
| File permissions | backend/ (writeFileSync/mkdirSync) | grep mode: |
| Electron IPC | preload.js, main.js (webPreferences) | code review |
| Dependencies | package.json | npm audit |
| eval/Function | all .js files | grep |

## Findings

### ✅ No Issues Found (Strong Existing Practices)

1. **Path traversal protection (server.js:175-190)** — `normTranscriptPath()`
   is exemplary:
   - Rejects non-absolute paths, non-`.jsonl` extensions
   - `pathInside()` check ensures path stays within configured roots
   - `lstatSync` rejects symlinks
   - `realpathSync` + second `pathInside` check prevents symlink escape
   - Rejects null bytes, newlines, and paths > 4096 chars

2. **Prototype pollution prevention** — `UNSAFE_KEYS` set blocks
   `__proto__`, `prototype`, `constructor` in both `metering-state.js`
   and `permission.js`. `safeMapKey()` also rejects CR/LF.

3. **Electron security** — Both BrowserWindows use:
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - `sandbox: true`
   - `contextBridge.exposeInMainWorld` (no direct ipcRenderer leak)

4. **HTTP server** — Binds `127.0.0.1` only (not `0.0.0.0`). Token auth
   uses `crypto.timingSafeEqual` (no timing side-channel). Body size limits
   enforced (`MAX_STATE_BODY_BYTES = 16KB`, `MAX_PERMISSION_BODY_BYTES = 1MB`).

5. **Shell quoting** — `posixQuote()` correctly escapes `'` as `'\''`.
   `appleEscape()` escapes `\` and `"`. `execFile` used (not `exec`) so
   args are not shell-interpreted.

6. **XSS prevention** — `escapeHtml()` in icons.js and `esc()` in pet.js
   escape all 5 HTML special characters (`& < > " '`) before innerHTML
   assignment.

7. **No eval/Function** — 0 occurrences of `eval(` or `new Function(` in
   41 production files.

8. **No hardcoded secrets** — 0 matches for `ghp_`, `sk-`, `AKIA` patterns.

9. **npm audit clean** — 0 vulnerabilities across 20 dependencies.

10. **Bounded file reads** — `readTextBoundedSync`/`readJsonBoundedSync`
    enforce size limits before allocation, preventing memory exhaustion
    from malicious dotfiles.

11. **HTTPS fetch hardening** — `models-dev-sync.js` and `pricing-sync.js`
    enforce: HTTPS-only, timeout, max response bytes, content-type check,
    no auth headers. `OCTOPUS_MODELS_DEV_URL` env override is a documented
    user config (not remote-controllable).

### 🔧 Hardening Applied (Low Severity)

#### F1: Windows cmd.exe quote escaping (launch.js)

**Before**: `cd /d "${workDir}" && "${claude}"` — if `workDir` or `claude`
contained a `"` character, it could close the quote early and enable
command injection.

**After**: New `winQuote()` helper doubles `"` as `""` (cmd.exe escape
convention). Applied to both `workDir` and `claude` in buildCandidates.

**Severity**: Low (in practice `workDir` is always `os.homedir()` and NTFS
paths cannot contain `"`, but defensive escaping is cheap and future-proof).

**Tag**: `#r10-security`

#### F2: tray-icon.js file mode (tray-icon.js)

**Before**: `fs.writeFileSync(tmp, icoBuf)` — default mode (depends on
umask, could be 0o644).

**After**: `fs.writeFileSync(tmp, icoBuf, { mode: 0o600 })` — owner
read/write only, consistent with all other config/state files.

**Severity**: Very Low (ico file is not sensitive — just a tray icon —
but consistency with the rest of the codebase's `0o600` convention).

**Tag**: `#r10-security`

### ℹ️ Observations (No Action Needed)

1. **Empty catch blocks** — 130+ `catch {}` in backend/. R10 already
   added logging to the 3 highest-value ones (core.js refreshContextUsage,
   pricing-sync onUpdate, providers/index readConfigSelection). The
   remainder are defensive best-effort operations (chmod, kill, accessSync)
   where logging adds noise without value.

2. **process-guards** — R10 added `process.on('unhandledRejection')` and
   `process.on('uncaughtException')` handlers. Previously the project had
   zero global error handlers (Node 15+ default terminates on unhandled
   rejection — wrong for an Electron desktop pet).

3. **130+ empty catches** are intentional defensive coding for best-effort
   cleanup operations (chmod that may fail on read-only FS, kill that may
   fail if process already dead). Adding logging to all would create noise.

4. **metering.js loadPricing empty catches** left intentionally silent —
   the metering-security test spawns a child process and parses stdout as
   JSON; adding log() there would pollute stdout and break the test.

## Test Coverage

New test `test/global-security-audit.js` (10 checks) verifies:
- winQuote escapes `"` as `""`
- buildCandidates returns valid candidates
- No eval/new Function in 41 production files
- No hardcoded secrets (ghp_/sk-/AKIA)
- process-guards module exports
- normTranscriptPath rejects path traversal (7 sub-checks)
- safeMapKey rejects prototype pollution keys (6 sub-checks)
- renderer escapeHtml/esc functions present
- Electron webPreferences secure (2 windows)
- HTTP server binds 127.0.0.1 + timingSafeEqual

Registered in `test/run-all.js` (27→28 tests).

## Verification

- **28/28 tests PASS** (27→28, +global-security-audit.js)
- **0 regressions**
- **npm audit: 0 vulnerabilities**

## References

- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Node.js unhandledRejection: https://nodejs.org/api/process.html#event-unhandledrejection
- OWASP Command Injection: https://owasp.org/www-community/attacks/Command_Injection
- OWASP Path Traversal: https://owasp.org/www-community/attacks/Path_Traversal
- OWASP Prototype Pollution: https://owasp.org/www-community/attacks/Prototype_Pollution
