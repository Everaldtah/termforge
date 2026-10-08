#!/usr/bin/env bash
# One-time setup on a Mac: vendor nodejs-mobile, generate TermForge.xcodeproj.
#   brew install xcodegen   (once)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v xcodegen >/dev/null || { echo "xcodegen not found: brew install xcodegen" >&2; exit 1; }
scripts/fetch-nodejs-mobile.sh
scripts/fetch-ish.sh
xcodegen generate
echo "open TermForge.xcodeproj  (scheme TermForge = App Store build, TermForge-Sideload = sideload build)"
