#!/usr/bin/env bash
# Fetches the pinned NodeMobile.xcframework (nodejs-mobile v18.20.4 for iOS, rebuilt with
# ICU by .github/workflows/build-nodejs-mobile.yml) into Packages/NodeCore/Vendor/,
# verifying its SHA-256. Upstream's own release is built --with-intl=none and cannot run
# Claude Code (docs/LIMITATIONS.md); pass UPSTREAM=1 to fetch it anyway.
set -euo pipefail

VERSION="v18.20.4"
if [ "${UPSTREAM:-0}" = "1" ]; then
  NAME="nodejs-mobile-${VERSION}-ios.zip"
  URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/${NAME}"
  SHA256="8c5ca3a0d1e38de7f182a5642593e82593b820efd375a14b3ecafc4bcfee620e"
  TAG="${VERSION}-upstream"
else
  NAME="nodejs-mobile-${VERSION}-small-icu-ios.zip"
  URL="https://github.com/Everaldtah/termforge/releases/download/nodejs-mobile-${VERSION}-small-icu/${NAME}"
  SHA256="f9013aa50f1779492429cb385ac90e0d5a913b131e6b305b545b117f6f83c57f"
  TAG="${VERSION}-small-icu"
fi
APP_MIN_IOS="17.0"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/Packages/NodeCore/Vendor"
STAMP="$DEST/.nodejs-mobile-$TAG"

if [ -f "$STAMP" ] && [ -d "$DEST/NodeMobile.xcframework" ]; then
  echo "nodejs-mobile $TAG already present"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "downloading $URL"
curl -fsSL --retry 3 -o "$WORK/nm.zip" "$URL"
if command -v shasum >/dev/null; then GOT="$(shasum -a 256 "$WORK/nm.zip" | cut -d' ' -f1)"; else GOT="$(sha256sum "$WORK/nm.zip" | cut -d' ' -f1)"; fi
if [ "$GOT" != "$SHA256" ]; then
  echo "SHA-256 mismatch: expected $SHA256, got $GOT" >&2
  exit 1
fi
mkdir -p "$WORK/x"
unzip -q "$WORK/nm.zip" -d "$WORK/x"
FW="$(find "$WORK/x" -maxdepth 2 -name NodeMobile.xcframework -type d | head -1)"
[ -n "$FW" ] || { echo "no NodeMobile.xcframework in $NAME" >&2; exit 1; }
rm -rf "$DEST/NodeMobile.xcframework"
mkdir -p "$DEST"
mv "$FW" "$DEST/"

# The framework says MinimumOSVersion 13.0; App Store processing wants embedded
# frameworks to match the app's own minimum (macOS hosts only: needs plutil).
if command -v plutil >/dev/null; then
  find "$DEST/NodeMobile.xcframework" -path '*NodeMobile.framework/Info.plist' -print0 |
    while IFS= read -r -d '' plist; do plutil -replace MinimumOSVersion -string "$APP_MIN_IOS" "$plist"; done
fi
rm -f "$DEST"/.nodejs-mobile-*
touch "$STAMP"
echo "nodejs-mobile $TAG -> $DEST/NodeMobile.xcframework"
