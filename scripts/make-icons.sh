#!/usr/bin/env bash
# Regenerate every app icon from the one brand logo.
#
#   Source:  frontend/public/brand/fluxze.png   (black logo; also the in-app header logo)
#   Writes:  frontend/public/brand/fluxze-icon.png                          browser tab icon (white on dark)
#            desktop/build/icon.icns                                        macOS app (white on dark)
#            ios/Fluxze/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png  iPhone app icon (white on dark)
#            ios/Fluxze/Assets.xcassets/Logo.imageset/Logo.png               iPhone sign-in logo (same image)
#
# Every platform shows the same dark icon: the white logo on dark slate.
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
IOS_ASSETS="$ROOT/ios/Fluxze/Assets.xcassets"
IOS_ICON="$IOS_ASSETS/AppIcon.appiconset/AppIcon-1024.png"
IOS_LOGO="$IOS_ASSETS/Logo.imageset/Logo.png"

BG="0F172A"            # icon background (white logo); dark slate
ICON_SIZE=1024
ICON_LOGO=700          # logo size inside the 1024 icon (leaves a safe margin)

for tool in sips iconutil swift; do
  command -v "$tool" >/dev/null || { echo "make-icons: needs macOS ($tool not found)" >&2; exit 1; }
done
[ -f "$SRC" ] || { echo "make-icons: missing source logo $SRC" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# square_on_bg <canvas px> <logo px> <out.png> [logo file] [bg hex]
# The logo centred on an opaque square (default: the source logo on $BG). App Store
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

# White logo (transparent background), the mark on the dark icon.
SRC_WHITE="$TMP/logo-white.png"
swift "$ROOT/scripts/tint-logo.swift" "$SRC" "$SRC_WHITE" FFFFFF

# The one 1024 master: white logo on dark, for macOS, iPhone and the browser tab.
square_on_bg "$ICON_SIZE" "$ICON_LOGO" "$TMP/master.png" "$SRC_WHITE"

# Browser tab icon: the app icon, scaled down. Its own dark background keeps
# the white lines visible on light and dark tab bars alike.
sips -z "$FAVICON_SIZE" "$FAVICON_SIZE" "$TMP/master.png" --out "$FAVICON" >/dev/null
echo "make-icons: wrote ${FAVICON#$ROOT/}"

# iPhone app icon, and the same image as the logo on the sign-in screen.
if [ -d "$(dirname "$IOS_ICON")" ]; then
  cp "$TMP/master.png" "$IOS_ICON"
  cp "$TMP/master.png" "$IOS_LOGO"
  echo "make-icons: wrote ${IOS_ICON#$ROOT/} and ${IOS_LOGO#$ROOT/}"
fi

# macOS .icns: the standard iconset matrix, packed by iconutil.
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET" "$(dirname "$ICNS")"
while read -r size name; do
  sips -z "$size" "$size" "$TMP/master.png" --out "$ICONSET/$name" >/dev/null
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
