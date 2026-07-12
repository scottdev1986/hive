#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$ROOT/../assets/hive_app_icon.png"
MODERN_RECIPE="$ROOT/Resources/AppIcon.icon.json"
ICONSET="$ROOT/Resources/AppIcon.iconset"
ICNS="$ROOT/Resources/AppIcon.icns"
ASSETS="$ROOT/Resources/Assets.car"
PREVIEW="$ROOT/../docs/assets/hive-workspace-icon.png"

command -v sips >/dev/null 2>&1 || {
  echo "error: sips is required (ships with macOS)" >&2
  exit 1
}
command -v iconutil >/dev/null 2>&1 || {
  echo "error: iconutil is required (ships with macOS)" >&2
  exit 1
}
xcrun --find actool >/dev/null 2>&1 || {
  echo "error: actool from Xcode 26 or newer is required" >&2
  exit 1
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-app-icon.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

rm -rf "$ICONSET"
mkdir -p "$ICONSET" "$(dirname -- "$PREVIEW")"

render() {
  pixels=$1
  name=$2
  sips --resampleHeightWidth "$pixels" "$pixels" "$SOURCE" \
    --out "$ICONSET/$name" >/dev/null
}

render 16   icon_16x16.png
render 32   icon_16x16@2x.png
render 32   icon_32x32.png
render 64   icon_32x32@2x.png
render 128  icon_128x128.png
render 256  icon_128x128@2x.png
render 256  icon_256x256.png
render 512  icon_256x256@2x.png
render 512  icon_512x512.png
render 1024 icon_512x512@2x.png

iconutil --convert icns --output "$ICNS" "$ICONSET"

# macOS 26 applies a compatibility plate to legacy bitmap icons. Compile the
# the same artwork into its native icon stack so Tahoe can render system glass,
# dark, and mono treatments; AppIcon.icns remains the macOS 14–15 fallback.
mkdir -p "$TMP/AppIcon.icon/Assets" "$TMP/out"
cp "$SOURCE" "$TMP/AppIcon.icon/Assets/AppIcon.png"
cp "$MODERN_RECIPE" "$TMP/AppIcon.icon/icon.json"
xcrun actool "$TMP/AppIcon.icon" \
  --compile "$TMP/out" \
  --output-partial-info-plist "$TMP/partial.plist" \
  --app-icon AppIcon \
  --enable-on-demand-resources NO \
  --target-device mac \
  --minimum-deployment-target 14.0 \
  --platform macosx >/dev/null
cp "$TMP/out/Assets.car" "$ASSETS"

cp "$ICONSET/icon_512x512.png" "$PREVIEW"

echo "Generated $ICNS"
echo "Generated $ASSETS"
echo "Preview: $PREVIEW"
