#!/usr/bin/env bash
# See vendor-claude-code.mjs. Usage: scripts/vendor-claude-code.sh [--out DIR] [--probe-report run.json]
set -euo pipefail
exec node "$(dirname "$0")/vendor-claude-code.mjs" "$@"
