#!/usr/bin/env bash
# build-icons.sh
# Generates macOS .icns, Windows .ico, and a Linux PNG set
# from a single 1024×1024 master PNG.
#
# Usage:  ./build-icons.sh path/to/icon-1024.png
# Output: ./build/icon.icns, ./build/icon.ico (if ImageMagick installed),
#         ./build/icons/<size>.png

set -euo pipefail

SRC="${1:-icon-1024.png}"
OUT="${OUT:-./build}"
TMP="$(mktemp -d)"
ICONSET="$TMP/icon.iconset"

if [[ ! -f "$SRC" ]]; then
  echo "✗ source not found: $SRC" >&2
  echo "  usage: $0 path/to/icon-1024.png" >&2
  exit 1
fi

mkdir -p "$OUT/icons" "$ICONSET"

# macOS .icns sizes (1x and 2x retina pairs)
declare -a SIZES=(16 32 64 128 256 512 1024)
for s in "${SIZES[@]}"; do
  sips -z "$s" "$s" "$SRC" --out "$OUT/icons/${s}.png" >/dev/null
done

# .iconset layout (the names macOS expects)
sips -z 16   16   "$SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z 64   64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128  128  "$SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_512x512.png"    >/dev/null
cp "$SRC" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$OUT/icon.icns"
echo "✓ wrote $OUT/icon.icns"

# Windows .ico (needs ImageMagick: brew install imagemagick)
if command -v magick >/dev/null 2>&1; then
  magick "$OUT/icons/16.png" "$OUT/icons/32.png" "$OUT/icons/64.png" \
         "$OUT/icons/128.png" "$OUT/icons/256.png" \
         "$OUT/icon.ico"
  echo "✓ wrote $OUT/icon.ico"
elif command -v convert >/dev/null 2>&1; then
  convert "$OUT/icons/16.png" "$OUT/icons/32.png" "$OUT/icons/64.png" \
          "$OUT/icons/128.png" "$OUT/icons/256.png" \
          "$OUT/icon.ico"
  echo "✓ wrote $OUT/icon.ico"
else
  echo "⚠ ImageMagick not installed — skipping .ico"
  echo "  install with: brew install imagemagick"
fi

rm -rf "$TMP"
echo "✓ done. icons in $OUT/"
