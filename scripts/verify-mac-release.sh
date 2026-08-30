#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
ARCH="$(node -p "process.arch")"
APP="${LLMPET_MAC_APP:-$ROOT/dist/LLMPET.app}"
ZIP="${LLMPET_MAC_ZIP:-$ROOT/dist/LLMPET-$VERSION-mac-$ARCH.zip}"

if [[ ! -d "$APP" ]]; then
  echo "Missing macOS application bundle: $APP" >&2
  exit 1
fi
if [[ ! -f "$ZIP" ]]; then
  echo "Missing macOS release archive: $ZIP" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP"
SIGNATURE="$(codesign -dvvv "$APP" 2>&1)"
if grep -qi 'Signature=adhoc' <<<"$SIGNATURE"; then
  echo "Refusing release: application is ad-hoc signed." >&2
  exit 1
fi
if grep -qi 'TeamIdentifier=not set' <<<"$SIGNATURE"; then
  echo "Refusing release: application has no Apple Developer Team identifier." >&2
  exit 1
fi
if ! grep -q 'Authority=Developer ID Application:' <<<"$SIGNATURE"; then
  echo "Refusing release: Developer ID Application authority not found." >&2
  exit 1
fi
if ! grep -Eq 'flags=.*runtime' <<<"$SIGNATURE"; then
  echo "Refusing release: Hardened Runtime is not enabled." >&2
  exit 1
fi

xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"
unzip -tq "$ZIP"

# Exercise the actual browser-download path: quarantine a copy of the ZIP,
# extract it, and require Gatekeeper to accept that extracted application too.
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llmpet-gatekeeper.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
cp "$ZIP" "$TMP_DIR/download.zip"
xattr -w com.apple.quarantine '0083;00000000;Safari;' "$TMP_DIR/download.zip"
mkdir -p "$TMP_DIR/extracted"
ditto -x -k "$TMP_DIR/download.zip" "$TMP_DIR/extracted"
DOWNLOADED_APP="$TMP_DIR/extracted/LLMPET.app"
if [[ ! -d "$DOWNLOADED_APP" ]]; then
  echo "Release ZIP does not contain LLMPET.app at its root." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$DOWNLOADED_APP"
xcrun stapler validate "$DOWNLOADED_APP"
spctl --assess --type execute --verbose=4 "$DOWNLOADED_APP"
echo "macOS release passed Developer ID, notarization, archive and quarantined Gatekeeper checks."
