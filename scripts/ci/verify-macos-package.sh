#!/usr/bin/env bash
# Verify the packaged producer app using native macOS tools.
# Usage: bash scripts/ci/verify-macos-package.sh <x64|arm64> [dist-directory]
# Success stdout is exactly x64\n or arm64\n. Diagnostics use stderr.
#
# Producer contract: clean dist, run one build:mac -- --<arch> --publish never,
# then verify and generate artifact-proof.json without rebuilding or replacing
# any output. electron-builder 26.15.7 passes the same completed appPath to both
# DMG and ZIP targets (macPackager.packMacTargets). The configured DMG file entry
# uses that appPath; ArchiveTarget archives it. This is producer-level binding,
# not independent inspection of either container's contents.
#
# Artifact names, inventory and SHA-256 belong to artifact-manifest.js and
# verify-artifacts.js. Stage this producer's DMG and ZIP and hash both there.
# For --detected-arch, translate THIS script's detected stdout through exported
# ARQUITECTURA_NATIVA (x64 -> x86_64, arm64 -> arm64); never use the job label or
# artifact filename as the detected value. No proof is emitted on failure.
set -euo pipefail
export LC_ALL=C

fail() { printf 'verify-macos-package: %s\n' "$*" >&2; exit 1; }

[[ $# == 1 || $# == 2 ]] || fail 'usage: verify-macos-package.sh <x64|arm64> [dist-directory]'
case "$1" in
  x64) EXPECTED=x64; APP_DIR=mac; OPPOSITE=mac-arm64 ;;
  arm64) EXPECTED=arm64; APP_DIR=mac-arm64; OPPOSITE=mac ;;
  *) fail 'expected architecture must be x64 or arm64' ;;
esac
[[ "$(uname -s)" == Darwin ]] || fail 'native macOS tools are required'
for tool in lipo plutil; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing native tool: $tool"
done

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DIST=${2-"$ROOT/dist"}
[[ -d "$DIST" && ! -L "$DIST" ]] || fail "missing or linked output directory: $DIST"
DIST="$(cd -- "$DIST" && pwd -P)"
APP="$DIST/$APP_DIR/MIKA5.app"
[[ ! -e "$DIST/$OPPOSITE" && ! -L "$DIST/$OPPOSITE" ]] || fail 'opposite architecture output is present'

# Match the producer's top-level app layout, not nested Electron helper apps.
# Arrays preserve spaces/newlines and include hidden/linked/invalid candidates.
# No line-oriented find/ls output, sorting or first-match selection.
shopt -s nullglob dotglob
APPS=("$DIST"/*.app "$DIST"/*/*.app)
[[ ${#APPS[@]} == 1 ]] || fail "expected exactly one packaged app, found ${#APPS[@]}"
[[ "${APPS[0]}" == "$APP" ]] || fail "app is not at the expected producer path: $APP"
for directory in "$DIST/$APP_DIR" "$APP" "$APP/Contents" "$APP/Contents/MacOS" "$APP/Contents/Resources"; do
  [[ -d "$directory" && ! -L "$directory" ]] || fail "missing or linked app directory: $directory"
done

PLIST="$APP/Contents/Info.plist"
BIN="$APP/Contents/MacOS/MIKA5"
ASAR="$APP/Contents/Resources/app.asar"
for file in "$PLIST" "$BIN" "$ASAR"; do
  [[ -f "$file" && -s "$file" && ! -L "$file" ]] || fail "missing, empty or linked app file: $file"
done
[[ -x "$BIN" ]] || fail "packaged main binary is not executable: $BIN"

# Read a typed plist field, not a human listing. Do not turn an unchecked plist
# value into a filesystem path; the current product executable is MIKA5.
EXECUTABLE="$(plutil -extract CFBundleExecutable raw -expect string -o - "$PLIST" && printf '.')" \
  || fail 'cannot read CFBundleExecutable'
[[ "$EXECUTABLE" == $'MIKA5\n.' ]] || fail 'unexpected CFBundleExecutable or plutil output'

# lipo -archs is the explicit architecture interface. Accept only one exact
# native token; universal, opposite, unknown and decorative output all fail.
# The sentinel preserves trailing newlines instead of trimming malformed data.
ARCHS="$(lipo -archs "$BIN" && printf '.')" || fail "lipo could not inspect: $BIN"
case "$ARCHS" in
  $'x86_64\n.') DETECTED=x64 ;;
  $'arm64\n.') DETECTED=arm64 ;;
  *) fail 'main binary must contain exactly one supported native architecture' ;;
esac
[[ "$DETECTED" == "$EXPECTED" ]] || fail "expected $EXPECTED, detected $DETECTED"
printf 'verify-macos-package: verified main binary: %s\n' "$BIN" >&2
printf '%s\n' "$DETECTED"
