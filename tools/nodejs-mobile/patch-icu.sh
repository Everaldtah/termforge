#!/usr/bin/env bash
# Patches a nodejs-mobile v18.20.4 checkout so its iOS build includes ICU. Upstream builds
# with --with-intl=none, which leaves V8 without `Intl` and without regex Unicode property
# escapes (\p{...}); Claude Code's bundle fails to load. Three changes:
#   1. --with-intl=small-icu (English locale data) and link the ICU libraries.
#   2. Keep ICU's break-iterator data: Node's small-icu trim drops it, and V8 then aborts in
#      Intl.Segmenter, which Claude Code's renderer uses for text width.
#   3. Build the ICU host tools (icupkg, genccode, ...) for macOS: the iOS gyp config applies
#      the iPhoneOS SDK to the host toolset too, so icutrim.py could not run them.
#   tools/nodejs-mobile/patch-icu.sh path/to/nodejs-mobile
set -euo pipefail
SRC="${1:?usage: $0 path/to/nodejs-mobile}"
PREP="$SRC/tools/ios_framework_prepare.sh"
PBX="$SRC/tools/ios-framework/NodeMobile.xcodeproj/project.pbxproj"
GYPI="$SRC/common.gypi"
TRIM="$SRC/tools/icu/icu_small.json"
PY=$(command -v python3 || command -v python)

# perl, not sed: the same edits must work with BSD sed on macOS and GNU sed elsewhere.

# 1. small-icu, and link its libraries into NodeMobile.framework (bin/ is already a search path)
grep -q -- '--with-intl=none' "$PREP" || { echo "unexpected $PREP (no --with-intl=none)" >&2; exit 1; }
perl -pi -e 's/--with-intl=none/--with-intl=small-icu/g' "$PREP"
perl -pi -e 's/^(\s*)"libzlib\.a"\n/$1"libzlib.a"\n$1"libicudata.a"\n$1"libicui18n.a"\n$1"libicuucx.a"\n/' "$PREP"
grep -q '"libicuucx.a"' "$PREP" || { echo "could not add ICU libs to outputs list" >&2; exit 1; }
perl -pi -e 's/^(\t*)"-lstdc\+\+",\n/$1"-lstdc++",\n$1"-licudata",\n$1"-licui18n",\n$1"-licuucx",\n/' "$PBX"
[ "$(grep -c '"-licuucx",' "$PBX")" = "2" ] || { echo "could not add ICU libs to OTHER_LDFLAGS (Debug + Release)" >&2; exit 1; }

# 2. keep brkitr (rules + root/en resources) and the dictionaries in the trimmed data
"$PY" - "$TRIM" <<'PY'
import json, sys
p = sys.argv[1]
j = json.load(open(p))
j["trees"]["brkitr"] = "locales"
j["trees"]["brkfiles"] = "leavealone"
j["trees"]["brkdict"] = "leavealone"
j["remove"] = [r for r in j["remove"] if r != "brkitr/root.res"]
json.dump(j, open(p, "w"), indent=2)
PY
grep -q '"brkfiles": "leavealone"' "$TRIM" || { echo "could not patch $TRIM" >&2; exit 1; }

# 3. host toolset builds against the macOS SDK (gyp evaluates target_conditions per toolset;
#    an empty IPHONEOS_DEPLOYMENT_TARGET makes gyp emit -mmacosx-version-min instead)
perl -0pi - "$GYPI" <<'PERL'
s/(\['OS=="ios"', \{\n\s*'defines': \['_DARWIN_USE_64_BIT_INODE=1'\],\n)/$1        'target_conditions': [
          ['_toolset=="host"', {
            'xcode_settings': {
              'SDKROOT': 'macosx',
              'MACOSX_DEPLOYMENT_TARGET': '11.0',
              'IPHONEOS_DEPLOYMENT_TARGET': '',
              'ENABLE_BITCODE': 'NO',
            },
          }],
        ],
/;
PERL
grep -q "'SDKROOT': 'macosx'" "$GYPI" || { echo "could not patch $GYPI (iOS block not found)" >&2; exit 1; }

echo "patched: small-icu + brkitr data + macOS host tools"
echo "  $PREP"; echo "  $PBX"; echo "  $TRIM"; echo "  $GYPI"
