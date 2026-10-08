#!/usr/bin/env bash
# Fetches the pinned nodejs-mobile iOS build (Node 18.20.4, V8 jitless) into
# Packages/NodeCore/Vendor/NodeMobile.xcframework, verifying its SHA-256.
set -euo pipefail

VERSION="v18.20.4"
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/nodejs-mobile-${VERSION}-ios.zip"
SHA256="8c5ca3a0d1e38de7f182a5642593e82593b820efd375a14b3ecafc4bcfee620e"
APP_MIN_IOS="17.0"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/Packages/NodeCore/Vendor"
STAMP="$DEST/.nodejs-mobile-$VERSION"

if [ -f "$STAMP" ] && [ -d "$DEST/NodeMobile.xcframework" ]; then
  echo "nodejs-mobile $VERSION already present"
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
rm -rf "$DEST/NodeMobile.xcframework"
mkdir -p "$DEST"
mv "$WORK/x/NodeMobile.xcframework" "$DEST/"

# The framework says MinimumOSVersion 13.0; App Store processing wants embedded
# frameworks to match the app's own minimum (macOS hosts only: needs plutil).
if command -v plutil >/dev/null; then
  find "$DEST/NodeMobile.xcframework" -path '*NodeMobile.framework/Info.plist' -print0 |
    while IFS= read -r -d '' plist; do plutil -replace MinimumOSVersion -string "$APP_MIN_IOS" "$plist"; done
fi
rm -f "$DEST"/.nodejs-mobile-*
touch "$STAMP"
echo "nodejs-mobile $VERSION -> $DEST/NodeMobile.xcframework"
