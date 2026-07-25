# Release Builds

This document describes the automated release build process for the Octopus
desktop pet (LLMPET fork).

## How to trigger a release

### Option 1: Push a version tag (automatic)

```bash
git tag v0.1.2-pre
git push origin v0.1.2-pre
```

The `Release` workflow triggers automatically on any tag matching `v*.*.*`.
The tag name determines whether the GitHub Release is marked as a prerelease:

| Tag suffix            | Prerelease? |
|-----------------------|-------------|
| `v1.0.0`              | No          |
| `v0.1.2-pre`          | Yes         |
| `v1.0.0-rc1`          | Yes         |
| `v1.0.0-beta.2`       | Yes         |

### Option 2: Manual dispatch (workflow_dispatch)

Go to **Actions → Release → Run workflow**, enter an existing tag name
(e.g. `v0.1.2-pre`), and run. This is useful for re-building artifacts for
an already-published release without creating a new tag.

## What the workflow does

```
┌─────────────┐     ┌──────────────────────────────┐     ┌──────────────┐
│  test-gate  │────▶│  build (ubuntu, macos, win)  │────▶│   release    │
│  npm test   │     │  package-{linux,mac,win}.sh  │     │  attach to   │
│  (27 tests) │     │  → tar.gz / zip / zip        │     │  GH release  │
└─────────────┘     └──────────────────────────────┘     └──────────────┘
```

1. **test-gate** (ubuntu-latest): Runs the full test suite (`node test/run-all.js`)
   on the tagged commit. A single failing test aborts the entire release — no
   artifact is published for a broken build. This job also validates the tag
   name matches `^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$` to prevent
   accidental triggers from malformed tags.

2. **build** (matrix: ubuntu / macos / ubuntu-for-windows): Each OS runs its
   packaging script:
   - **Linux**: `scripts/package-linux.sh` → `Octopus-linux-x64-<ver>.tar.gz`
     (portable tarball, includes Electron runtime, runs on glibc ≥ 2.27)
   - **macOS**: `scripts/package-mac.sh` → `Octopus-mac-arm64.zip`
     (native .app bundle, ad-hoc signed, includes SkyLight drag helper)
   - **Windows**: `scripts/package-win.sh` → `Octopus-win-x64-<ver>.zip`
     (portable zip, downloads win32 Electron from npm mirror, includes run.bat)

   `fail-fast: false` means all three OSes build even if one fails, so a
   partial release (e.g. Linux + Windows, macOS failed) is still visible in
   the workflow run artifacts.

3. **release** (ubuntu-latest, only if test-gate + build both succeed):
   Downloads all build artifacts and attaches them to the GitHub Release
   corresponding to the tag. Uses `softprops/action-gh-release@v2` with
   `fail_on_unmatched_files: true` so a missing artifact fails loudly.

## Security model

- **No secrets required.** The workflow uses only `permissions: contents: write`
  (the minimum scope needed to upload release assets). No signing certificates,
  no API tokens, no cloud credentials.
- **Unsigned builds.** All three platforms produce unsigned builds (ad-hoc
  signed on macOS, unsigned on Linux/Windows). This matches the existing
  manual packaging scripts. Users who need signed builds should run the
  scripts locally with their own certificates.
- **No user input execution.** The only dynamic value is the tag name, which
  is validated against a strict regex before use. The workflow never
  `eval`s or `run`s user-supplied strings.
- **Concurrency control.** Only one release build per tag can run at a time;
  a re-push of the same tag cancels the in-flight run (no duplicate artifacts).

## Local reproduction

To reproduce a release build locally:

```bash
# Linux (on Linux)
npm ci
npm test                # gate
npm run package:linux   # → dist/Octopus-linux-x64-<ver>.tar.gz

# macOS (on macOS, needs Xcode for swiftc)
npm ci
npm test
npm run package:mac     # → dist/Octopus-mac-arm64.zip

# Windows (cross-build from Linux, downloads win32 Electron)
npm ci
npm test
npm run package:win     # → dist/Octopus-win-x64-<ver>.zip
```

## Known limitations

- **macOS SkyLight helper**: `scripts/package-mac.sh` compiles
  `backend/drag-window.swift` against the SkyLight private framework using
  `/usr/bin/swiftc`. This requires a real macOS environment (the GitHub
  Actions `macos-latest` runner provides this). Cross-compiling from Linux
  is not supported.
- **Windows signing**: The Windows build is a portable zip, not a signed
  `.exe` installer. Users will see SmartScreen warnings on first run.
- **Electron download size**: Each build job downloads the Electron binary
  (~100MB for Linux/Windows, ~150MB for macOS). The first run of a release
  takes ~10 minutes; subsequent runs benefit from the npm cache.
- **Test gate coverage**: The test suite uses only Node built-ins (no
  Electron require), so it runs identically on all OSes. Renderer-specific
  tests that need Electron are not in the gate (they would require a display
  server on Linux CI).
