#!/usr/bin/env bash
# Fetches the pinned iSHCore.xcframework (iSH kernel + x86 emulator + fakefs + libarchive +
# TermForge shim, built by .github/workflows/build-ish.yml) into Packages/LinuxCore/Vendor/,
# verifying its SHA-256.
set -euo pipefail

TAG="ish-8334836"
NAME="iSHCore.xcframework.zip"
URL="https://github.com/Everaldtah/termforge/releases/download/${TAG}/${NAME}"
SHA256="b5cf10d7637cf8e9caf3974e9a4f036e5ca3b6958d6c54b718374e2be2b3cda6"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/Packages/LinuxCore/Vendor"
STAMP="$DEST/.ish-$TAG"

if [ -f "$STAMP" ] && [ -d "$DEST/iSHCore.xcframework" ]; then
  echo "iSHCore $TAG already present"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "downloading $URL"
curl -fsSL --retry 3 -o "$WORK/ish.zip" "$URL"
if command -v shasum >/dev/null; then GOT="$(shasum -a 256 "$WORK/ish.zip" | cut -d' ' -f1)"; else GOT="$(sha256sum "$WORK/ish.zip" | cut -d' ' -f1)"; fi
if [ "$GOT" != "$SHA256" ]; then
  echo "SHA-256 mismatch: expected $SHA256, got $GOT" >&2
  exit 1
fi
mkdir -p "$WORK/x"
unzip -q "$WORK/ish.zip" -d "$WORK/x"
FW="$(find "$WORK/x" -maxdepth 2 -name iSHCore.xcframework -type d | head -1)"
[ -n "$FW" ] || { echo "no iSHCore.xcframework in $NAME" >&2; exit 1; }
rm -rf "$DEST/iSHCore.xcframework"
mkdir -p "$DEST"
mv "$FW" "$DEST/"
rm -f "$DEST"/.ish-*
touch "$STAMP"
echo "iSHCore $TAG -> $DEST/iSHCore.xcframework"
