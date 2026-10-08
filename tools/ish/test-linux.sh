#!/usr/bin/env bash
# Builds the shim and its test harness against a native (Linux/macOS) iSH build and runs
# them on a fakefs root. Proves the kernel glue before it goes to iOS.
#   tools/ish/test-linux.sh <ish-src-with-build-dir> <fakefs-dir> <host-dir> [cmd...]
set -euo pipefail
SRC="${1:?ish source dir (with build/)}"; FS="${2:?fakefs dir}"; HOST="${3:?host dir}"; shift 3
SHIM="$(cd "$(dirname "$0")/shim" && pwd)"
BUILD="$SRC/build"
OUT="${TF_TEST_OUT:-$BUILD/tf}"
mkdir -p "$OUT"
CC="${CC:-clang}"
CFLAGS=(-O1 -g -std=gnu11 -I"$SRC" -I"$BUILD" -I"$SHIM" -DTF_ISH_VERSION="\"ish $(git -C "$SRC" rev-parse --short HEAD)\"")
"$CC" "${CFLAGS[@]}" -c "$SHIM/tf_ish.c" -o "$OUT/tf_ish.o"
"$CC" "${CFLAGS[@]}" -c "$SHIM/tf_test.c" -o "$OUT/tf_test.o"
"$CC" "${CFLAGS[@]}" -c "$SRC/tools/fakefs.c" -o "$OUT/fakefs.o"
"$CC" -o "$OUT/tf_test" "$OUT/tf_test.o" "$OUT/tf_ish.o" "$OUT/fakefs.o" \
  "$BUILD/libish.a" "$BUILD/libish_emu.a" "$BUILD/libfakefs.a" \
  -lsqlite3 -larchive -lpthread -lm -ldl $( [ "$(uname)" = Linux ] && echo -lrt )
exec "$OUT/tf_test" "$FS" "$HOST" "${@:-/bin/bash -c "echo hello from $0; uname -a; id"}"
