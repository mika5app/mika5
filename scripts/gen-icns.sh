#!/usr/bin/env bash
# Generate build/icon.icns from src/renderer/assets/icon.png
# Requires: macOS with sips + iconutil (pre-installed on all macOS systems)
# Usage: bash scripts/gen-icns.sh

set -euo pipefail

SRC="src/renderer/assets/icon.png"
ICONSET="build/icon.iconset"
OUT="build/icon.icns"

if [[ ! -f "$SRC" ]]; then
  echo "ERROR: Source icon not found at $SRC"
  exit 1
fi

mkdir -p "$ICONSET" build

echo "Generating ICNS from $SRC..."

sips -z 16   16   "$SRC" --out "$ICONSET/icon_16x16.png"      --setProperty format png
sips -z 32   32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"   --setProperty format png
sips -z 32   32   "$SRC" --out "$ICONSET/icon_32x32.png"      --setProperty format png
sips -z 64   64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"   --setProperty format png
sips -z 128  128  "$SRC" --out "$ICONSET/icon_128x128.png"    --setProperty format png
sips -z 256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png" --setProperty format png
sips -z 256  256  "$SRC" --out "$ICONSET/icon_256x256.png"    --setProperty format png
sips -z 512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png" --setProperty format png
sips -z 512  512  "$SRC" --out "$ICONSET/icon_512x512.png"    --setProperty format png
cp "$SRC"          "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$OUT"
rm -rf "$ICONSET"

echo "✓ Generated: $OUT"
