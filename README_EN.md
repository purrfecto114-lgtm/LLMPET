# 🐙 Octopus (LLMPET fork) — A Desktop Pet for 5 AI Coding Agents

[简体中文](README.md) | **English** | [日本語](README_JA.md)

Octopus is a desktop companion that makes **five AI coding agents** visible at a glance — **CodeWhale, Claude Code, Codex, OpenCode, and aider**. Its expression changes while your agent is thinking, using tools, waiting for you, celebrating a completed turn, or taking a nap. It surfaces the agent's latest reply in a speech bubble and shows sessions, token usage, estimated cost, and usage trends in a compact dashboard.

> **Ready to use:** download the latest Linux, macOS, or Windows build from [GitHub Releases](https://github.com/purrfecto114-lgtm/LLMPET/releases/tag/v0.1.2-pre). The packaged app includes Electron, so regular users do not need Node.js or a terminal.

> **Note:** this is an enhanced fork of [myunwang/LLMPET](https://github.com/myunwang/LLMPET). The interface is currently **Simplified Chinese**; English/Japanese UI localization is on the roadmap (the upstream i18n work has not been merged yet).

## What it does

- **Live agent state** — see thinking, working, parallel subagents, context cleanup, waiting, errors, completion, and idle time as pet animations.
- **Five providers** — watch **CodeWhale**, **Claude Code**, **Codex**, **OpenCode**, and **aider** at the same time, each with its own hook installer.
- **Hook installers** — one-click install of the bridge hook for every provider (Claude Code `settings.json`, CodeWhale TOML, Codex `hooks.json`, OpenCode plugin system, aider `--notifications-command`).
- **Permission approvals** — allow or deny a Claude Code / CodeWhale permission request directly from the pet, with batch-decide support.
- **Session switcher** — click the pet to open a scrollable session list, inspect context usage, and bring the selected terminal or desktop session forward.
- **Usage dashboard** — inspect token history, model breakdowns, cost estimates, rate-limit windows, background processes, and live operations.
- **Three skins** — Octopus 🐙, Pixel Monster 👾, and Salary Cat 🐱.
- **Patrol mode on macOS** — Octopus can detect supported rival desktop pets, stay above them, and attempt to push their windows to the nearest screen edge.
- **Security hardened** — `contextIsolation` + `sandbox` + `nodeIntegration:false`, IPC contextBridge surface audit, process-level error guards.

The state machine, metering, permission flow, process reconciliation, and desktop UI are implemented in this repository. Each provider connects through its public hook/plugin system; Octopus does not inject into agent processes.

## Salary Cat states

| Animation | State | When it appears |
|:---:|:---|:---|
| <img src="assets/cat/cat-working.gif" width="72" alt="Working"> <img src="assets/cat/cat-working-2.gif" width="72" alt="Working variation"> | 🛠️ **Working** | Running tools, editing files, or executing commands |
| <img src="assets/cat/cat-thinking.gif" width="72" alt="Thinking"> <img src="assets/cat/cat-thinking-2.gif" width="72" alt="Thinking variation"> | 🤔 **Thinking** | Reasoning before the first tool call |
| <img src="assets/cat/cat-talking.gif" width="72" alt="Replying"> | 💬 **Replying** | Producing the assistant response |
| <img src="assets/cat/cat-juggling.gif" width="72" alt="Parallel tasks"> | 🤹 **Parallel tasks** | Subagents are working in parallel |
| <img src="assets/cat/cat-waiting.gif" width="72" alt="Waiting for approval"> | ✋ **Waiting** | Claude Code needs approval |
| <img src="assets/cat/cat-needsinput.gif" width="72" alt="Waiting for input"> | ❓ **Needs input** | The agent needs an answer or selection |
| <img src="assets/cat/cat-happy.gif" width="72" alt="Completed"> | 🎉 **Completed** | A turn has finished |
| <img src="assets/cat/cat-error.gif" width="72" alt="Error"> | 💥 **Error** | A command or API request failed |
| <img src="assets/cat/cat-loafing.gif" width="72" alt="Loafing"> | 🍦 **Loafing** | The previous step ended and nothing new is happening |
| <img src="assets/cat/cat-sleeping.gif" width="72" alt="Sleeping"> | 😴 **Sleeping** | The session ended or has been inactive for a while |

Salary Cat assets are credited to Douyin creator **@月薪喵**. See [`assets/cat/CREDITS.md`](assets/cat/CREDITS.md).

## Download and run

### Packaged app

[Download the latest release](https://github.com/myunwang/LLMPET/releases/latest)

- **macOS (Apple Silicon):** download `LLMPET-*-mac-arm64.zip`, extract it, and open `LLMPET.app`. If Gatekeeper blocks the first launch, right-click the app in Finder and choose **Open**. Patrol mode also requires Accessibility permission.
- **Windows (x64):** use `LLMPET-*-Windows-x64.exe` for the installer, or download the matching `.zip` for a portable build.

On first launch, LLMPET merge-installs its Claude Code hooks without overwriting existing hooks.

### Run from source

Requirements:

- macOS or Windows
- Node.js 18 or newer
- Claude Code and/or OpenAI Codex installed and used at least once

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm install
npm start
```

Useful commands:

```bash
npm test                 # full headless regression suite
npm run package:mac      # macOS ARM64 package
npm run package:win      # Windows installer + portable ZIP
npm run uninstall:hooks  # remove LLMPET's Claude hooks safely
```

## How the integrations work

### Claude Code

LLMPET registers merge-safe lifecycle and permission hooks in `~/.claude/settings.json`.

- Lifecycle events such as `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SubagentStart` are sent to a local server bound to `127.0.0.1`.
- Permission requests stay open until the user chooses allow or deny.
- Local transcripts are scanned incrementally for token counts, model IDs, and timestamps. Assistant text is only read when needed for the short reply bubble.

### OpenAI Codex

LLMPET does not install Codex hooks. It incrementally and read-only tails:

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

It maps rollout events into the same state machine, filters internal subagent threads, restores long-running sessions without replaying old events, and reads Codex rate-limit windows when available.

## Meme actions

Each meme is stored as structured data under:

```text
assets/memes/<meme-id>/
  visual.gif
  voice.mp3
```

The catalog keeps the label, description, playback behavior, pet reaction, prompt version, and localized prompt together. Selecting a meme plays the media beside the pet and sends the matching prompt to the selected Claude or Codex session.

The localized prompts are adapted to the culture of each language rather than translated word for word. For example, the Chinese “你这瓜保熟吗？” challenge becomes **“Source: trust me bro?”** in English because both jokes serve the same purpose: demanding proof instead of an unverified claim.

## macOS patrol mode

From the pet's context menu, choose **Patrol now**, or enable automatic patrol from the tray.

1. **Paw stays on top:** when a supported rival pet is detected, LLMPET reasserts its topmost window level.
2. **Push to the edge:** with Accessibility permission, LLMPET approaches the rival and attempts to move it to the nearest horizontal edge.

The drag helper avoids acting while the user is actively using the mouse. Global input fallback is guarded by idle checks and restores mouse state on completion or failure.

Patrol mode is currently macOS-only.

## Privacy and security

- The HTTP server binds only to `127.0.0.1` and validates loopback requests.
- Session data, configuration, and usage history stay on the local machine.
- Codex rollout access is read-only.
- Pricing is the only optional network fetch: once every 24 hours LLMPET downloads public LiteLLM pricing data. Set `OCTOPUS_NO_NET=1` for fully offline mode.
- Electron runs with `contextIsolation` enabled and `nodeIntegration` disabled.
- Claude hook installation is merge-safe, atomic, reversible, and backed up before uninstall.

## Configuration and development flags

- `OCTOPUS_NO_HOOKS=1 npm start` — launch without changing Claude settings.
- `OCTOPUS_ALLOW_MULTI=1 npm start` — bypass single-instance protection for development.
- `OCTOPUS_NO_NET=1 npm start` — disable all external network requests.
- `OCTOPUS_DEBUG=1 npm start` — expose the local `/debug` endpoint.
- `LLMPET_NO_CODEX=1 npm start` — disable Codex rollout watching.
- `LLMPET_CODEX_DIR=<dir> npm start` — use a custom rollout directory for testing.

## Contributor

[@james6666-max](https://github.com/james6666-max) contributed Windows session focusing, terminal PID-chain resolution and caching, electron-builder packaging, and the Windows CI test matrix in [PR #6](https://github.com/myunwang/LLMPET/pull/6).

Contributions and issue reports are welcome.
