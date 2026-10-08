#!/usr/bin/env bash
# Patches a nodejs-mobile v18.20.4 checkout so its iOS build includes ICU (small-icu:
# full Unicode property data, English locale). Upstream builds with --with-intl=none, which
# leaves V8 without `Intl` and without regex Unicode property escapes (\p{...}); Claude
# Code's bundle uses both and fails to load.
#   tools/nodejs-mobile/patch-icu.sh path/to/nodejs-mobile
set -euo pipefail
SRC="${1:?usage: $0 path/to/nodejs-mobile}"
PREP="$SRC/tools/ios_framework_prepare.sh"
PBX="$SRC/tools/ios-framework/NodeMobile.xcodeproj/project.pbxproj"

grep -q -- '--with-intl=none' "$PREP" || { echo "unexpected $PREP (no --with-intl=none)" >&2; exit 1; }
# perl, not sed: the same edits must work with BSD sed on macOS and GNU sed elsewhere
perl -pi -e 's/--with-intl=none/--with-intl=small-icu/g' "$PREP"
# copy the ICU static libraries next to the others
perl -pi -e 's/^(\s*)"libzlib\.a"\n/$1"libzlib.a"\n$1"libicudata.a"\n$1"libicui18n.a"\n$1"libicuucx.a"\n/' "$PREP"
grep -q '"libicuucx.a"' "$PREP" || { echo "could not add ICU libs to outputs list" >&2; exit 1; }
# ...and link them into NodeMobile.framework (bin/ is already a library search path)
perl -pi -e 's/^(\t*)"-lstdc\+\+",\n/$1"-lstdc++",\n$1"-licudata",\n$1"-licui18n",\n$1"-licuucx",\n/' "$PBX"
[ "$(grep -c '"-licuucx",' "$PBX")" = "2" ] || { echo "could not add ICU libs to OTHER_LDFLAGS (Debug + Release)" >&2; exit 1; }
echo "patched for small-icu: $PREP, $PBX"
