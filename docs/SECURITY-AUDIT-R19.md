# Security Audit — IPC contextBridge Surface (Round 19, #p24-fix)

> **Date**: 2026-07-25
> **Scope**: `preload.js` contextBridge surface + `main.js` webPreferences posture
> **Risk**: Low (read-only audit + regression test; only JSDoc comments added to prod code)
> **Baseline**: 33/33 tests PASS (32 → 33, +1 new test file)

---

## 1. Threat Model

The Electron renderer (pet.html / panel.html) runs in a sandboxed, context-isolated
world. The **only** privileged bridge to the main process is the `window.pet` object
exposed by `preload.js` via `contextBridge.exposeInMainWorld`. If a compromised
renderer (e.g. via XSS in panel content or a malicious provider transcript) could
reach the raw `ipcRenderer`, `require`, or any Node primitive, it would escape the
sandbox. This audit verifies that escape path is closed and **stays** closed.

---

## 2. Audit Findings

### 2.1 `main.js` webPreferences ✅ SECURE

Both the pet window and the panel window declare:

```js
webPreferences: {
  preload: PRELOAD,
  contextIsolation: true,   // default since Electron 12, explicitly set
  nodeIntegration: false,   // no Node in renderer
  sandbox: true,            // OS-level sandbox (default since Electron 20)
}
```

Verified by `scripts/round19-ipc-audit-smoke.js`:
- `contextIsolation: true` appears **twice** (both windows)
- `nodeIntegration: false` appears **twice**
- `sandbox: true` appears **twice**
- No `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false`, or
  `allowRunningInsecureContent: true` anywhere in `main.js`.

This matches the [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security):
- "Do not enable Node.js integration for remote content" ✅
- "Enable contextIsolation" ✅
- "Enable process sandboxing" ✅

### 2.2 `preload.js` contextBridge surface ✅ SECURE

`preload.js` uses `contextBridge.exposeInMainWorld('pet', { ... })` to expose a
**flat object of 38 functions**. Audit confirms:

| Property | Status | Evidence |
|---|---|---|
| Uses `contextBridge.exposeInMainWorld` | ✅ | only privileged API used |
| `require('electron')` called exactly once | ✅ | destructures `contextBridge` + `ipcRenderer` |
| No `ipcRenderer` key exposed | ✅ | grep `'ipcRenderer'\s*:` → no match |
| No `require` key exposed | ✅ | grep `'require'\s*:` → no match |
| No `electron` key exposed | ✅ | grep `'electron'\s*:` → no match |
| Every exposed value is a Function | ✅ | 38/38 keys are functions |
| No exposed function aliases `ipcRenderer` / `.send` / `.invoke` | ✅ | identity check |
| `subscribe()` validates `cb` is a function | ✅ | returns no-op unsubscribe for non-functions |
| `subscribe()` returns a working unsubscribe | ✅ | removes the listener |

Per the [contextBridge API docs](https://www.electronjs.org/docs/latest/api/context-bridge),
exposed values may be Function/string/number/Array/boolean/object — but exposing the
raw `ipcRenderer` object (or any object holding it) would let a compromised renderer
send arbitrary IPC. The audit confirms only thin wrapper functions are exposed, each
calling a single hardcoded channel with the renderer's args.

### 2.3 Channel map (documented in preload.js JSDoc)

**Renderer → Main (`invoke`, request/response):**
`get-config` · `get-stats` · `get-win-pos`

**Renderer → Main (`send`, fire-and-forget):**
`open-panel` · `close-panel` · `set-mode` · `set-skin` · `set-budget` · `set-currency`
· `toggle-mute` · `set-providers` · `territory-run-now` · `territory-toggle-auto`
· `quit-app` · `set-win-pos` · `launch-claude` · `launch-codewhale`
· `permission-decide` · `cw-permission-decide` · `cw-permission-decide-batch`
· `focus-session` · `primary-action` · `set-ignore-mouse` · `pet-tall` · `pet-big`
· `set-pet-size` · `set-panel-height` · `pet-focus` · `pet-blur` · `open-log`
· `pet-log` · `ui-busy` · `pet-visual-bounds`

**Main → Renderer (via `subscribe` wrappers):**
`pet:event` · `pet:stats` · `pet:config` · `panel:stats` · `panel:config` · `panel:price`

---

## 3. Regression Guard

New test **`test/preload-contextbridge-security.js`** (24 checks) loads the REAL
`preload.js` with a mocked `electron` module and asserts:

1. `exposeInMainWorld` called once with apiKey `'pet'`
2. exposed api is a non-null object
3. all exposed values are functions (no raw primitive/object leak)
4. no `ipcRenderer` / `require` / `electron` key exposed
5. no exposed function aliases `ipcRenderer` or its methods
6. exact key set matches the locked-down 38-key surface (add/remove/rename → fail)
7. `subscribe()` with non-function returns no-op, doesn't throw, doesn't register
8. `subscribe()` with function returns working unsubscribe
9. `invoke`-based methods call `ipcRenderer.invoke` with correct channel
10. `send`-based methods call `ipcRenderer.send` with correct channel + args

New smoke **`scripts/round19-ipc-audit-smoke.js`** (19 checks) re-validates the
on-disk production files + runs the regression test inline.

Any future change that adds a new IPC method, disables contextIsolation, or
accidentally exposes `ipcRenderer` will now **fail CI**.

---

## 4. Out of Scope (deferred)

- **Defensive input coercion** in preload wrappers (e.g. `Number(x)` for
  `setPetSize`) — deferred as medium-risk (could break legit calls if the main
  process expects specific types). The main process handlers are the correct
  place for input validation; the preload surface lock-down is the first line.
- **`petLog(tag, msg)`** log-injection hardening — low value; main process
  logger already sanitises.

---

## 5. Sources

1. Electron contextBridge API — https://www.electronjs.org/docs/latest/api/context-bridge
2. Electron Security Tutorial — https://www.electronjs.org/docs/latest/tutorial/security
