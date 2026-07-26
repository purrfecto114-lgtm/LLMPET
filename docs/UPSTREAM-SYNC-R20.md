# Upstream Sync Assessment — myunwang/LLMPET → purrfecto114-lgtm/LLMPET

> **Date**: 2026-07-26
> **Upstream HEAD**: `ee00ead` (docs: add English and Japanese homepages)
> **Our fork HEAD**: `e0ca44c` (after R20 cherry-pick of ee00ead)
> **Merge base**: `d51311e` (our fork's v1.0.3 baseline)
> **Upstream versions since baseline**: v1.0.0 → v1.0.1 → v1.0.2 → v1.0.3 → **v1.1.0** → **v1.1.1**

---

## 1. Summary

Upstream has advanced **two minor releases** (v1.0.3 → v1.1.1) since our fork's
baseline. The upstream tree changed **47 files, +5324 / −511 lines**. Our fork
changed **119 files** over the same period (our 5-provider hook system, metering,
security hardening, CI). **25 files overlap** (changed by both sides) → high
conflict surface for a blanket merge.

**Decision**: do NOT attempt a blanket `git merge upstream/main`. Instead,
cherry-pick selectively by value/risk. **Round 20** executed the safest pick
(`ee00ead` docs). The remaining candidates are classified below.

---

## 2. Already synced (no action)

| Upstream commit | How | Round |
|---|---|---|
| `c2669ba` fix(codex): keep active turns in working state | manual sync as `a3331e2` (codewhale loafing) | R2 |

---

## 3. Cherry-pick candidates (ranked by value ÷ risk)

### ✅ DONE — R20: `ee00ead` docs: EN/JA homepages
- **Value**: medium (i18n docs for our fork)
- **Risk**: low (1 small README.md conflict, resolved; +2 new doc files)
- **Localization**: rewrote intro/feature list for our 5-provider fork (not verbatim)
- **Commit**: `e0ca44c`, 33/33 tests PASS

### 🟡 MEDIUM — `cebb10d` fix patrol false-negative status race
- **Value**: high (bugfix — patrol mode misses some status races)
- **Risk**: high conflict. Our `backend/territory.js` diverged heavily
  (+41/−123 vs merge-base) — we rewrote it; upstream added +72/−22 in the same
  area. A cherry-pick will conflict on nearly every hunk.
- **Upstream fix**: adds `manualRunPromise` + a shared race-guard in
  `patrol()`; also touches `renderer/pet.js` (+4) and `test/territory.js` (+86).
- **Recommendation**: **defer** unless patrol false-negatives are observed in
  our fork. If needed, re-implement the *concept* (shared promise + race guard)
  against our current territory.js rather than cherry-picking the patch.

### 🟡 MEDIUM — popup layout fixes (PR #9: `266a37a` + `c49c424` + `738e1bf` + `ac66d68`)
- **Value**: medium (issue #7: popup shadow clipping + scrollbar overflow +
  multi-session layout)
- **Risk**: medium-high. The 4 commits form a sequence; the later two
  (`738e1bf`, `ac66d68`) refactor `renderer/pet.js` (+38/+7) and `pet.html`
  (+28) which our fork also edits. The final `.ask` rule in upstream differs
  structurally from ours (different `max-width`/`max-height`/`overflow`).
- **Test**: upstream added `test/popup-style.js` (24→52 lines) with assertions
  referencing the final rule state — picking only the first 2 commits would
  fail the test.
- **Recommendation**: **defer as a batch**. If popup clipping is reported,
  port all 4 commits together and re-validate `test/popup-style.js`.

### 🟠 HIGH VALUE, HIGH EFFORT — `cc955a1` + `3895ecb` i18n (三语界面)
- **Value**: high (English + Japanese UI + tray language switch)
- **Risk**: very high conflict. Touches `main.js` (+114/−), `backend/adapter.js`
  (+87/−), `renderer/panel.html` (+59/−), `renderer/panel.js` (+111/−),
  `backend/config.js`, `backend/meme-catalog.js`, `package.json` — all files our
  fork also modified. New file `shared/i18n.js` (917 lines) is clean, but the
  integration points (main.js tray menu, panel rendering) will conflict.
- **Recommendation**: **dedicated merge session**. This is a multi-day effort:
  1. Port `shared/i18n.js` + `test/i18n.js` as-is (pure new files).
  2. Re-apply the i18n integration against our current `main.js` / panel
     (upstream's hunks won't apply cleanly — manual re-implementation).
  3. Localize our fork-specific strings (provider names, hook installer UI).
- **Estimated effort**: 1-2 full rounds.

### 🟠 HIGH VALUE, HIGH EFFORT — meme actions (`ca12d67` → `be00279`, 5 commits)
- **Value**: high (user-facing feature: GIF + voice + structured prompt)
- **Risk**: very high. New files (`backend/command-dispatch.js`, `backend/meme-catalog.js`,
  `assets/memes/*`) are clean, BUT the feature integrates into `backend/core.js`,
  `backend/server.js`, `hook/octopus-hook.js`, `main.js`, `renderer/pet.js` — all
  heavily modified by our fork. The `33352e2` commit also patches
  `backend/codex-watch.js` which **we do not have** (we use a different codex
  provider path via `providers/codex.js` + `hook/codex-hook.js`).
- **Recommendation**: **defer**. Meme actions are a large feature that needs
  adaptation to our 5-provider architecture (dispatch should work for all
  providers, not just Claude Code + Codex). Not a quick cherry-pick.

### 🟢 LOW — `1500e8f` fix Windows release publishing
- **Value**: low (1-line `package.json` fix + 1-line test/branding.js)
- **Risk**: low-medium. `package.json` overlaps (version/deps differ). The fix
  itself is tiny.
- **Recommendation**: **skip** — our fork's release workflow (`.github/workflows/release.yml`)
  already handles Windows publishing correctly (R10 verified 5/5 jobs PASS).
  The upstream fix predates our CI work.

---

## 4. Files overlap analysis (25 files changed by both sides)

**High-conflict core** (do NOT cherry-pick without dedicated merge):
- `main.js`, `renderer/pet.js`, `renderer/panel.js`, `renderer/panel.html`,
  `backend/core.js`, `backend/adapter.js`, `backend/server.js`,
  `backend/territory.js`, `hook/octopus-hook.js`, `preload.js`

**Low-conflict** (could cherry-pick with care):
- `renderer/pet.css`, `renderer/pet.html` (popup fixes)
- `README.md`, `package.json` (trivial)
- test files (`test/smoke.js`, `test/territory.js`)

---

## 5. Recommendation for next rounds

| Priority | Candidate | Effort | Round |
|---|---|---|---|
| ✅ done | R20: ee00ead EN/JA READMEs | low | R20 |
| next | port `shared/i18n.js` + `test/i18n.js` (pure new files, no integration yet) | low | R21 (prep) |
| then | i18n integration into our fork's main.js + panel (manual re-impl) | high | R22-23 |
| later | popup layout batch (4 commits) IF clipping reported | medium | TBD |
| later | meme actions (adapt to 5-provider dispatch) | high | TBD |
| skip | cebb10d patrol race, 1500e8f win release | — | — |

---

## 6. How this assessment was produced

```bash
cd /home/z/my-project/repo/fork
git remote add upstream https://github.com/myunwang/LLMPET.git
git fetch upstream
git merge-base main upstream/main      # → d51311e
git log --oneline d51311e..upstream/main
git diff --stat d51311e..upstream/main  # 47 files, +5324/-511
comm -12 <(git diff --name-only d51311e..main|sort) <(git diff --name-only d51311e..upstream/main|sort)  # 25 overlap
```

Sources: GitHub API `repos/myunwang/LLMPET/commits`, `git ls-remote --tags upstream`,
per-commit `git show --stat`.
