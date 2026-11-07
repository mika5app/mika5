#!/usr/bin/env bash
# Validate the generated icon without regenerating or changing source files.
# Usage: bash scripts/ci/check-icon.sh
# mac.icon and dmg.icon in electron-builder.json use build/icon.icns.
# Member names and sizes come from scripts/gen-icns.sh; its unscaled source
# supplies the 1024px icon_512x512@2x.png representation.
set -euo pipefail
export LC_ALL=C

fail() { printf 'check-icon: %s\n' "$*" >&2; exit 1; }

[[ $# == 0 ]] || fail 'usage: bash scripts/ci/check-icon.sh'
[[ "$(uname -s)" == Darwin ]] || fail 'native macOS tools are required'
for tool in iconutil sips mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing native tool: $tool"
done

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SOURCE="$ROOT/src/renderer/assets/icon.png"
ICON="$ROOT/build/icon.icns"
for input in "$SOURCE" "$ICON"; do
  [[ -f "$input" && -s "$input" && ! -L "$input" ]] || fail "missing, empty or linked icon: $input"
done

# Do not honor TMPDIR: extraction must stay outside the tracked source tree.
TEMP_DIR="$(mktemp -d /tmp/mika5-check-icon.XXXXXX)"
cleanup() {
  local status=$?
  trap - EXIT
  if ! rm -rf -- "$TEMP_DIR"; then
    printf 'check-icon: cannot clean temporary extraction: %s\n' "$TEMP_DIR" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TEMP_DIR="$(cd -- "$TEMP_DIR" && pwd -P)"

check_png() {
  local png=$1 size=$2 actual expected
  [[ -f "$png" && -s "$png" && ! -L "$png" ]] || fail "missing, empty or linked PNG: $png"
  # Explicit property queries, fixed locale, exact schema. The sentinel keeps
  # trailing newlines observable; warnings or extra output must fail closed.
  actual="$(sips -g pixelWidth -g pixelHeight -g format "$png" && printf '.')" \
    || fail "sips could not decode: $png"
  printf -v expected '%s\n  pixelWidth: %s\n  pixelHeight: %s\n  format: png\n.' "$png" "$size" "$size"
  [[ "$actual" == "$expected" ]] || fail "unexpected PNG dimensions, format or sips output: $png"
}

check_png "$SOURCE" 1024
ICONSET="$TEMP_DIR/icon.iconset"
iconutil -c iconset "$ICON" -o "$ICONSET" >&2 || fail 'iconutil could not decode build/icon.icns'
[[ -d "$ICONSET" && ! -L "$ICONSET" ]] || fail 'iconutil did not produce an iconset directory'

MEMBERS=(
  icon_16x16.png icon_16x16@2x.png icon_32x32.png icon_32x32@2x.png
  icon_128x128.png icon_128x128@2x.png icon_256x256.png icon_256x256@2x.png
  icon_512x512.png icon_512x512@2x.png
)
SIZES=(16 32 32 64 128 256 256 512 512 1024)
shopt -s nullglob dotglob
PRESENT=("$ICONSET"/*)
[[ ${#PRESENT[@]} == ${#MEMBERS[@]} ]] || fail 'unexpected iconset member count'
for index in "${!MEMBERS[@]}"; do
  check_png "$ICONSET/${MEMBERS[$index]}" "${SIZES[$index]}"
done
printf 'check-icon: all generated representations decoded with expected PNG dimensions\n' >&2
