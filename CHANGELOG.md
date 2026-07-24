# Changelog

## 0.1.2-pre — three-bug state machine fixes + autonomous Round 1 (2026-07-24)

### 修复的三个 bug

用户报告 `needsinput` / `attention` / `greet` 三个状态在运行中未观察到触发。本轮自主推进完成根因分析 + 修复 + 回归测试。

#### Bug#1 — attention 未触发

**根因**：core.js 第 191-208 行的 Stop 处理明确把 `resolvedState` 设为 `'idle'`（注释 "Store idle (NOT a lingering 'attention')"），adapter.js 第 104 行 `mapState` 把 `attention` 归并到 `idle`，pet.js 渲染端从不调用 `setState('attention')`。即 attention 状态在 stats 路径上根本不显示——这是设计偏离 STATES.md §3 的描述（"Stop → attention(oneshot 15s) → idle+done"）。

**修复**（方案C，事件驱动，最小侵入）：在 `adapter.js` 的 `activityToEvents` Stop 分支补 push 一个 `attention` event（1.6s transient），让 cat-attention.gif 有显示窗口。不改 core.js 的 Stop=idle 设计选择（保持与上游一致），不改 mapState 归并逻辑（聚合态仍走 turn-done → idle）。`pet.js` 加 `case 'attention'` + `MASCOT_EYES.attention`。

**为何不选方案B（启用 oneshot attention）**：会让 attention 优先级 5 在多会话场景中盖住 working/thinking/needsinput，需要重写聚合梯子；改动面大、风险高、与上游偏离更深。方案C 仅在事件流里加 transient，完成后由 applyStats 自然接管，零干扰。

#### Bug#2 — needsinput 未触发

**根因**：代码路径已齐全（adapter.js buildPetStats 第 264-281 行三个分支 + activityToEvents 第 459-469 行 + pet.js 第 1082-1084 + 1230-1231 行 + hookinstall.js 第 49 行注册 Notification/Elicitation hook）。问题不在代码，而在事件可能未真正上报（Claude Code 配置问题）或被 headless 误判。

**修复**：补 `test/three-bug-smoke.js` 覆盖三条触发路径（Notification event / AskUserQuestion permission / ExitPlanMode），防止未来回归。

#### Bug#3 — greet 未触发

**根因**：`adapter.js` 第 422 行的 `toolSpawned = /\/\./.test(session.cwd)` 正则过宽，会误判 `/home/z/.local/...`、`/home/z/.config/...` 等合法路径为"工具拉起的入口进程"，导致 `greetPending` 不被设置；第 432 行的 5 分钟窗口太短，用户启动 claude 后超过 5 分钟才发首条 prompt 就不欢迎。

**修复**：`GREET_PENDING_WINDOW_MS` 5min → 15min（匹配真实使用节奏）；`toolSpawned` 正则 `/\/\./` → `/\/\.(claude|codex)\/sessions\//`（只匹配真实已知的 Claude Code / Codex sessions 一次性目录）。同步更新 `test/smoke.js` [19] 用例使用真实 `.claude/sessions/` 路径。

### 测试

- 新增 `test/three-bug-smoke.js`（6 个用例：Bug#1 attention event / Bug#2 needsinput 三路径 / Bug#3 greet 窗口+正则 / 回归 basic states）
- 全量 `npm test` 21 个文件全部 PASS（~9s）
- 修复 `test/smoke.js` [19] 用例以匹配新正则

### Web 交叉验证

本轮对 3 个关键工程决策做了 Web 交叉验证（6 个独立来源，详见 `work/web-verification.md`）：

1. **Electron 43.1.1** — contextBridge + contextIsolation 仍是官方推荐做法，未发现活跃 CVE
2. **Claude Code Hook 协议** — fork 注册的 13 个事件名与官方文档完全一致（包括 Notification/Elicitation）
3. **CodeWhale provider** — 真实开源产品（npm `codewhale` v0.9.0, github Hmbown/CodeWhale, Rust+MIT），fork 实现的 `tool_call_before` + `{"decision":"allow|deny|ask","reason":"..."}` JSON 契约与官方文档完全一致

### CodeWhale 冒烟测试

- `npm install -g codewhale` 安装成功
- `codewhale --version` → `codewhale 0.9.0 (d167c07c9628)`
- `codewhale doctor` → version OK, 30 个 provider 可选
- fork 的 codewhale-hook.js 设计假设与官方 hook 协议一致

### 已知限制

- 上游已发布 v1.0.3（含 meme actions / codex backend / command-dispatch / popup-style test 等），fork 仍落后约 6 天 + 一批 feat。Phase 3 的 cherry-pick 7 天计划见 `download/03-merge-plan.md`
- 上游用 electron-builder，fork 用 png-to-ico + 自实现打包脚本，打包链不兼容，不能直接 cherry-pick 上游打包相关 commit
- GitHub pre-release 推送需要真实 PAT（用户提供的是 `[REDACTED:github_token]` 占位符），本轮完成所有本地准备（commit + tag + changelog），实际推送由用户手动执行（见 `download/RELEASE-HANDOFF.md`）

---

## 0.1.1 — deep runtime hardening + CodeWhale catalog v2 + models.dev sync (2026-07-20)

### CodeWhale catalog v2 + live sync

- Expanded `backend/model-catalog.bundled.json` from 31 to **49 entries**, now covering every model registered in CodeWhale's `crates/agent/src/lib.rs` ModelRegistry: added `deepseek-chat`, `deepseek-reasoner`, `kimi-k3`, `moonshotai/kimi-k3`, `glm-5.1`, `glm-5-turbo`, `z-ai/glm-5.1`, `z-ai/glm-5-turbo`, `gpt-5.5`, `gpt-5.5-pro`, `grok-4.5`, `grok-4.3`, `grok-build`, `grok-composer-2.5-fast`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `LongCat-2.0`, `longcat-2.0`, `minimax-m3`.
- Added vendor-published `cache_read_usd_per_million` / `cache_write_usd_per_million` fields per catalog entry. Previously the metering code used a single `0.1× input / 1.25× input` heuristic for all models; vendor reality differs significantly:
  - Xiaomi MiMo: cache_read ≈ 2% of input (heuristic over-charged 5×)
  - Z.AI GLM-5.x: cache_read ≈ 18.6% of input
  - xAI Grok: cache_read 15-20% of input
  - Meta Muse Spark: cache_read 12% of input
  - MiniMax M3: cache_read 20% of input
  - Meituan LongCat-2.0: cache_read 2% of input
  - Xiaomi MiMo / Z.AI GLM-5.x cache_write: vendor-limited-time-free ($0)
- Fixed wrong prices:
  - `deepseek-v4-pro` was $2/$8 (CNY misread as USD) → correct $0.435/$0.87 per DeepSeek's official pricing page + models.dev catalog
  - `deepseek-v4-flash` was $0.5/$2 → correct $0.14/$0.28
  - `gpt-5.6-terra` was $3/$20 → correct $2.50/$15 per OpenAI pricing page
  - `gpt-5.6-luna` was $2/$10 → correct $1/$6
- Fixed wrong context windows: `grok-build` was 512K (correct 256K, official SKU `grok-build-0.1`), `grok-4.20-0309-reasoning/non-reasoning` were 2M (correct 1M per xAI docs).
- **New: Models.dev live catalog sync** (`backend/models-dev-sync.js`). Mirrors CodeWhale upstream's `crates/tui/src/models_dev_live.rs` design:
  - Background async fetch from `https://models.dev/catalog.json` (MIT-licensed, ~3 MB, 5000+ models)
  - 24-hour TTL, 15-second timeout, 64 MiB response cap, no credentials/cookies
  - Atomic write to `~/.octopus/catalog/models-dev.json` (0600 permissions)
  - Three-layer lookup: live cache > bundled seed > null (token-only)
  - Official-provider priority: when multiple providers serve the same model id (e.g. `deepseek-v4-pro` is served by both `deepseek` at $0.435/$0.87 and aggregator `frogbot` at $1.74/$3.48), the official provider wins
  - Graceful degradation: failure to fetch falls back to stale cache or bundled seed; never blocks startup
  - Env knobs: `OCTOPUS_MODELS_DEV_URL`, `OCTOPUS_MODELS_DEV_PATH`, `OCTOPUS_DISABLE_MODELS_DEV_FETCH`, `OCTOPUS_NO_NET`
  - Schema validation: rejects absurd prices (>$1000/M), oversized context (>100M), malformed JSON; preserves `null` distinct from `0` (free)
  - HTTPS-only (refuses http:// URLs to prevent MITM)

### Metering behavior

- Removed `DEFAULT_FALLBACK` ($1/$5 fabricated estimate) for unknown models. `priceFor()` now returns `null`, the metering records tokens honestly with `cost=0`, and the per-model daily aggregate carries an `unknownPrice` counter so the UI can show an "unknown price" badge instead of implying the user spent $0.
- Removed the parallel `FALLBACK_PRICING` table; the catalog is now the single source of truth. Previously a fallback table could silently mask data loss if the catalog lost an entry.
- Cache pricing now uses vendor-published rates when available and only falls back to the 10%/1.25× heuristic when the vendor truly doesn't publish (e.g. Arcee Trinity, grok-composer).
- Fixed `loadCatalog` to preserve `null` cache_write/cache_read distinct from explicit `0` (free) — previous code coerced `Number(null)` to `0`, hiding the "vendor doesn't publish" signal.

### Security

- Upgraded Electron from 33.x to 43.1.1 and enabled renderer sandboxing, context isolation, web security, restrictive CSP, sender-validated IPC, navigation/webview/window blocking, download denial and deny-by-default browser permissions.
- Added a cryptographically random per-launch token to all local hook/server routes, private runtime-file permissions, constant-time token comparison, slow-body timeouts and HTTP connection/header limits.
- Reworked permission bridges to fail closed to `ask`, bounded pending/duplicate queues and made CodeWhale batch approval session-scoped with inactivity expiry and lifecycle cleanup.
- Hardened all persisted metering data against prototype-pollution keys, malformed maps, non-finite numbers and unbounded collections; private file modes are restored after atomic rename.
- Added bounded startup JSON/TOML readers, shell-safe command quoting and strict transcript/session path, symlink and size checks.

### Performance and reliability

- Replaced whole-unread-transcript allocation with 4 MiB fixed-memory JSONL chunks, a 32 MiB per-scan global budget, round-robin progress, a 5000-file cap and oversized-line forward progress.
- Cached unchanged transcript tails, capped live sessions at 256, bounded startup/backfill scans and limited CodeWhale session-list parsing to 100 candidates / 64 MiB total.
- Changed periodic stats refresh to non-overlapping one-shot scheduling, bounded asynchronous logging, added HTTP recovery after incomplete requests and retried hook installation during slow startup.
- Repaired pet/panel bounds after monitor removal or resolution changes; panel opens on the pet's display.
- Fixed model aliases with missing catalog prices, Unix CLI discovery, quoting of paths with spaces, Windows Node-mode hook uninstall and default `--no-sandbox` packaging regressions.

### Packaging, tests and documentation

- Added missing provider/runtime files to package manifests, retained production dependencies in Windows portable builds and kept the Chromium sandbox enabled unless an explicit diagnostic environment variable is set.
- Expanded the core suite to **20 files** (was 18), 60+ file syntax traversal and 92 Windows assertions; added security, oversized-input, persistence, package-consistency, models.dev sync (unit + integration), and stress tests.
- New test files:
  - `test/models-dev-sync.js`: unit tests for transform/validate/cache logic (20+ assertions, includes live fetch verification)
  - `test/models-dev-sync-integration.js`: end-to-end tests covering bundled-only, live-override, stale-cache, corrupted-cache, live-fetch, non-blocking, env-override scenarios (8 tests)
- Updated `CODEWHALE.md` §Token 计量与花费 with the new pricing model, vendor cache rate table, models.dev sync architecture, and the list of price corrections.
- Updated README "CodeWhale 一等公民支持" section to highlight the catalog v2 upgrade and models.dev sync.
- Added `MODEL-PRICING-RESEARCH.md` and `MODEL-PRICE-SYNC-RESEARCH.md` (shipped with source tarball, not in portable zip) documenting every price's vendor URL, access date, and the sync design rationale.
- All 20 core tests pass; all 92 Windows adaptation assertions pass.

## 0.1.0 — initial audited fork

- Initial Claude Code / CodeWhale desktop pet fork and first-round upstream synchronization.
