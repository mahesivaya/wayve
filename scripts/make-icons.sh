#!/usr/bin/env bash
# Regenerate every app icon from the one brand logo.
#
#   Source:  frontend/public/brand/fluxze.png   (black logo; also the in-app header logo)
#   Writes:  frontend/public/brand/fluxze-icon.png                          browser tab icon (white on dark)
#            desktop/build/icon.icns                                        macOS app (white on dark)
#            frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/…      iPhone app icon
#            frontend/ios/App/App/Assets.xcassets/Splash.imageset/…         iPhone launch screen
#
# The generated files are committed (each platform needs its own copy inside
# its project), but never edit them by hand: change the source logo and re-run
#
#   ./scripts/make-icons.sh          (or `npm run icon` in desktop/)
#
# macOS only: uses the built-in `sips`, `iconutil` and `swift` (tint-logo.swift
# recolours the logo, which sips can't).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/frontend/public/brand/fluxze.png"
FAVICON="$ROOT/frontend/public/brand/fluxze-icon.png"
FAVICON_SIZE=256
ICNS="$ROOT/desktop/build/icon.icns"
IOS_ASSETS="$ROOT/frontend/ios/App/App/Assets.xcassets"
IOS_ICON="$IOS_ASSETS/AppIcon.appiconset/AppIcon-512@2x.png"
IOS_SPLASH_DIR="$IOS_ASSETS/Splash.imageset"

BG="FFFFFF"            # iPhone icon / splash background (black logo)
DESKTOP_BG="0F172A"    # macOS icon background (white logo); dark slate
ICON_SIZE=1024
ICON_LOGO=700          # logo size inside the 1024 icon (leaves a safe margin)
SPLASH_SIZE=2732
SPLASH_LOGO=640        # logo size on the launch screen

for tool in sips iconutil swift; do
  command -v "$tool" >/dev/null || { echo "make-icons: needs macOS ($tool not found)" >&2; exit 1; }
done
[ -f "$SRC" ] || { echo "make-icons: missing source logo $SRC" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# square_on_bg <canvas px> <logo px> <out.png> [logo file] [bg hex]
# The logo centred on an opaque square (default: black logo on $BG). App Store
# icons must not have an alpha channel, so the result is flattened through JPEG
# and back to PNG.
square_on_bg() {
  local canvas=$1 logo=$2 out=$3 src=${4:-$SRC} bg=${5:-$BG}
  sips -s format png -z "$logo" "$logo" "$src" --out "$TMP/logo.png" >/dev/null
  # (--padColor prints a CGColor debug line on stderr; drop it.)
  sips -p "$canvas" "$canvas" --padColor "$bg" "$TMP/logo.png" --out "$TMP/padded.png" >/dev/null 2>&1
  sips -s format jpeg -s formatOptions 100 "$TMP/padded.png" --out "$TMP/flat.jpg" >/dev/null
  sips -s format png "$TMP/flat.jpg" --out "$out" >/dev/null
}

# White logo (transparent background), the mark on the dark icons.
SRC_WHITE="$TMP/logo-white.png"
swift "$ROOT/scripts/tint-logo.swift" "$SRC" "$SRC_WHITE" FFFFFF

# iPhone master 1024: black logo on white.
square_on_bg "$ICON_SIZE" "$ICON_LOGO" "$TMP/master.png"

# macOS master 1024: white logo on dark.
square_on_bg "$ICON_SIZE" "$ICON_LOGO" "$TMP/master-desktop.png" "$SRC_WHITE" "$DESKTOP_BG"

# Browser tab icon: the desktop icon, scaled down. Its own dark background keeps
# the white lines visible on light and dark tab bars alike.
sips -z "$FAVICON_SIZE" "$FAVICON_SIZE" "$TMP/master-desktop.png" --out "$FAVICON" >/dev/null
echo "make-icons: wrote ${FAVICON#$ROOT/}"

# iPhone app icon.
if [ -d "$(dirname "$IOS_ICON")" ]; then
  cp "$TMP/master.png" "$IOS_ICON"
  echo "make-icons: wrote ${IOS_ICON#$ROOT/}"
fi

# iPhone launch screen: the asset catalog lists three copies of one image.
if [ -d "$IOS_SPLASH_DIR" ]; then
  square_on_bg "$SPLASH_SIZE" "$SPLASH_LOGO" "$TMP/splash.png"
  for name in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do
    cp "$TMP/splash.png" "$IOS_SPLASH_DIR/$name"
  done
  echo "make-icons: wrote ${IOS_SPLASH_DIR#$ROOT/}/splash-2732x2732*.png"
fi

# macOS .icns: the standard iconset matrix, packed by iconutil.
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET" "$(dirname "$ICNS")"
while read -r size name; do
  sips -z "$size" "$size" "$TMP/master-desktop.png" --out "$ICONSET/$name" >/dev/null
done <<'EOF'
16 icon_16x16.png
32 icon_16x16@2x.png
32 icon_32x32.png
64 icon_32x32@2x.png
128 icon_128x128.png
256 icon_128x128@2x.png
256 icon_256x256.png
512 icon_256x256@2x.png
512 icon_512x512.png
1024 icon_512x512@2x.png
EOF
iconutil -c icns "$ICONSET" -o "$ICNS"
echo "make-icons: wrote ${ICNS#$ROOT/}"
