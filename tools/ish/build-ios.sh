#!/usr/bin/env bash
# Cross-compiles iSH's kernel + x86 emulator + fakefs, its vendored libarchive, and
# TermForge's C shim (tools/ish/shim) for iOS device and simulator, then packs everything
# into iSHCore.xcframework. Runs on macOS with Xcode, meson and ninja (brew install meson).
#
#   tools/ish/build-ios.sh [--src path/to/ish] [--out build/ish]
#
# iSH is GPL-3.0 (plus LICENSE.IOS); TermForge ships under the same terms.
set -euo pipefail

ISH_COMMIT="8334836"   # ish-app/ish main, 2026-09-20
MIN_IOS="17.0"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/build/ish/src"
OUT="$ROOT/build/ish"
while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
SHIM="$ROOT/tools/ish/shim"
mkdir -p "$OUT"

if [ ! -d "$SRC/.git" ]; then
  git clone -q https://github.com/ish-app/ish "$SRC"
fi
git -C "$SRC" checkout -q "$ISH_COMMIT"
git -C "$SRC" submodule update --init --depth 1 deps/libarchive

build_platform() {   # <name> <sdk> <min-flag>
  local name="$1" sdk="$2" minflag="$3"
  local sdkpath; sdkpath="$(xcrun --sdk "$sdk" --show-sdk-path)"
  local bdir="$OUT/$name" cross="$OUT/$name-cross.txt"
  mkdir -p "$bdir"
  cat > "$cross" <<EOF
[binaries]
c = 'clang'
ar = 'ar'
strip = 'strip'

[host_machine]
system = 'darwin'
cpu_family = 'aarch64'
cpu = 'aarch64'
endian = 'little'

[built-in options]
c_args = ['-arch', 'arm64', '-isysroot', '$sdkpath', '$minflag', '-fembed-bitcode=off']
c_link_args = ['-arch', 'arm64', '-isysroot', '$sdkpath', '$minflag']

[properties]
needs_exe_wrapper = true
EOF
  # the vdso and offsets steps run on the build machine with a plain clang
  export CC_FOR_BUILD="env -u SDKROOT -u IPHONEOS_DEPLOYMENT_TARGET xcrun clang"
  if [ ! -f "$bdir/meson/build.ninja" ]; then
    meson setup "$bdir/meson" "$SRC" --cross-file "$cross" --buildtype=debugoptimized -Db_ndebug=true \
      -Dlog_handler=nslog -Dkernel=ish > "$bdir/meson-setup.log" 2>&1 || { tail -30 "$bdir/meson-setup.log"; exit 1; }
  fi
  ninja -C "$bdir/meson" libish.a libish_emu.a libfakefs.a > "$bdir/ninja.log" 2>&1 || { tail -40 "$bdir/ninja.log"; exit 1; }

  # libarchive: iSH's own Xcode project for it (HAVE_CONFIG_H + deps/config.h)
  xcodebuild -project "$SRC/deps/libarchive.xcodeproj" -target archive -configuration Release \
    -sdk "$sdk" -arch arm64 ONLY_ACTIVE_ARCH=NO IPHONEOS_DEPLOYMENT_TARGET="$MIN_IOS" \
    SYMROOT="$bdir/libarchive" OBJROOT="$bdir/libarchive/obj" > "$bdir/libarchive.log" 2>&1 \
    || { grep -E "error:" "$bdir/libarchive.log" | head; exit 1; }
  local archive_a; archive_a="$(find "$bdir/libarchive" -name 'libarchive.a' | head -1)"
  [ -n "$archive_a" ] || { echo "libarchive.a not produced" >&2; exit 1; }

  # fakefs import/export (needs libarchive headers) and TermForge's shim
  local cflags=(-arch arm64 -isysroot "$sdkpath" "$minflag" -O2 -std=gnu11 -DHAVE_CONFIG_H
    -I"$SRC" -I"$bdir/meson" -I"$SRC/deps/libarchive/libarchive" -I"$SRC/deps" -Wall)
  clang "${cflags[@]}" -c "$SRC/tools/fakefs.c" -o "$bdir/fakefs.o"
  clang "${cflags[@]}" -I"$SHIM" -c "$SHIM/tf_ish.c" -o "$bdir/tf_ish.o"
  ar rcs "$bdir/libtfshim.a" "$bdir/fakefs.o" "$bdir/tf_ish.o"

  libtool -static -o "$bdir/libiSHCore.a" \
    "$bdir/meson/libish.a" "$bdir/meson/libish_emu.a" "$bdir/meson/libfakefs.a" "$archive_a" "$bdir/libtfshim.a"
  lipo -info "$bdir/libiSHCore.a"
}

build_platform device iphoneos "-miphoneos-version-min=$MIN_IOS"
build_platform simulator iphonesimulator "-mios-simulator-version-min=$MIN_IOS"

HDRS="$OUT/headers"
rm -rf "$HDRS" && mkdir -p "$HDRS"
cp "$SHIM/tf_ish.h" "$HDRS/"
cat > "$HDRS/module.modulemap" <<'EOF'
module iSHCore {
    header "tf_ish.h"
    link "sqlite3"
    export *
}
EOF
rm -rf "$OUT/iSHCore.xcframework"
xcodebuild -create-xcframework \
  -library "$OUT/device/libiSHCore.a" -headers "$HDRS" \
  -library "$OUT/simulator/libiSHCore.a" -headers "$HDRS" \
  -output "$OUT/iSHCore.xcframework"
( cd "$OUT" && rm -f iSHCore.xcframework.zip && ditto -c -k --keepParent iSHCore.xcframework iSHCore.xcframework.zip && shasum -a 256 iSHCore.xcframework.zip | tee iSHCore.xcframework.zip.sha256 )
echo "iSH $ISH_COMMIT -> $OUT/iSHCore.xcframework"
