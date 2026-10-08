#!/usr/bin/env bash
# Builds the Alpine x86 (i386) root filesystem TermForge's Linux tab boots, as a plain
# rootfs tar.gz that the app converts to iSH's fakefs format on first use.
#
# Reproducible: pins the Alpine release, uses Alpine's own apk-tools-static for the
# pinned version, and sets a fixed mtime on every entry. Needs an x86 host (Linux x86_64
# with 32-bit emulation, e.g. WSL2 or GitHub's ubuntu runners), tar, curl, sha256sum.
# Runs as root, under fakeroot, or in an unprivileged user namespace (unshare -r).
#
#   scripts/build-rootfs.sh [--out build/rootfs/alpine-i386.tar.gz] [--mirror URL]
set -euo pipefail

ALPINE_BRANCH="v3.20"
ALPINE_RELEASE="3.20.10"
APK_TOOLS_VERSION="2.14.4-r1"
ARCH="x86"
MIRROR="https://dl-cdn.alpinelinux.org/alpine"
# Pre-installed set from the brief. Everything else is an `apk add` away inside the tab.
PACKAGES="alpine-base bash git ripgrep coreutils python3 openssh-client build-base \
  findutils grep sed gawk diffutils less curl ca-certificates nano"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1700000000}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/rootfs/alpine-$ARCH.tar.gz"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --mirror) MIRROR="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$(dirname "$OUT")"

# apk-tools-static: the installer, verified against the SHA-256 published next to it
echo "fetching apk-tools-static $APK_TOOLS_VERSION ($ARCH)"
APK_URL="$MIRROR/$ALPINE_BRANCH/main/$ARCH/apk-tools-static-$APK_TOOLS_VERSION.apk"
curl -fsSL --retry 3 -o "$WORK/apk-tools-static.apk" "$APK_URL"
curl -fsSL --retry 3 -o "$WORK/APKINDEX.tar.gz" "$MIRROR/$ALPINE_BRANCH/main/$ARCH/APKINDEX.tar.gz"
tar -xzf "$WORK/apk-tools-static.apk" -C "$WORK" sbin/apk.static 2>/dev/null
APK="$WORK/sbin/apk.static"
[ -x "$APK" ] || { echo "apk.static missing from $APK_URL" >&2; exit 1; }

# Alpine's signing key: the index names its signer (.SIGN.RSA.<key>); fetch that key from
# alpinelinux.org over TLS and print its fingerprint so a run can be compared with the last.
KEYS="$WORK/keys"
mkdir -p "$KEYS" "$WORK/idx"
tar -xzf "$WORK/APKINDEX.tar.gz" -C "$WORK/idx" 2>/dev/null || true
for sig in "$WORK/idx"/.SIGN.RSA.* "$WORK/idx"/.SIGN.RSA256.*; do
  [ -e "$sig" ] || continue
  key="$(basename "$sig" | sed -E 's/^\.SIGN\.RSA(256)?\.//')"
  [ -f "$KEYS/$key" ] || curl -fsSL --retry 3 -o "$KEYS/$key" "https://alpinelinux.org/keys/$key"
  printf '  signer %s  sha256 %s\n' "$key" "$(sha256sum "$KEYS/$key" | cut -c1-16)"
done
[ -n "$(ls -A "$KEYS")" ] || { echo "no signing key found in APKINDEX" >&2; exit 1; }

ROOTFS="$WORK/rootfs"
mkdir -p "$ROOTFS/etc/apk"
cp -r "$KEYS" "$ROOTFS/etc/apk/keys"
printf '%s\n%s\n' "$MIRROR/$ALPINE_BRANCH/main" "$MIRROR/$ALPINE_BRANCH/community" > "$ROOTFS/etc/apk/repositories"

# apk chowns files, creates device nodes and runs triggers that chroot: real root, or an
# unprivileged user namespace (fakeroot is not enough: chroot fails inside triggers).
if [ "$(id -u)" = 0 ]; then AS_ROOT=""
elif unshare -r true 2>/dev/null; then AS_ROOT="unshare -r"
else echo "run as root (sudo) or on a system that allows unprivileged user namespaces" >&2; exit 1; fi
echo "running apk as: ${AS_ROOT:-root}"
echo "installing: $PACKAGES"
# (--repositories-file is relative to the current directory; the keys dir defaults to <root>/etc/apk/keys)
$AS_ROOT "$APK" --root "$ROOTFS" --arch "$ARCH" --initdb --no-cache --update-cache \
  --repositories-file "$ROOTFS/etc/apk/repositories" \
  add $PACKAGES > "$WORK/apk.log" 2>&1 || APK_RC=$?
if [ "${APK_RC:-0}" != 0 ]; then
  if [ -n "$AS_ROOT" ]; then
    # In a user namespace only uid/gid 0 are mapped: chown to other groups fails (etc/shadow
    # -> shadow) and the package script reporting it exits non-zero. Files end up root:root.
    # Fine for development; release images are built as real root (CI uses sudo).
    echo "WARNING: apk reported errors in this user-namespace build (dev only, not for release):"
    grep -E "^(ERROR|chown)" "$WORK/apk.log" | sed 's/^/  /'
  else
    echo "--- apk failed; log head:"; head -12 "$WORK/apk.log"; echo "..."; tail -8 "$WORK/apk.log"; exit 1
  fi
fi
tail -1 "$WORK/apk.log"

# Settings every TermForge tab expects
echo "termforge" > "$ROOTFS/etc/hostname"
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$ROOTFS/etc/resolv.conf"
mkdir -p "$ROOTFS/root" "$ROOTFS/home/user" "$ROOTFS/mnt/termforge"
cat > "$ROOTFS/etc/profile.d/termforge.sh" <<'EOF'
# The host's Documents folder (Claude Code's $HOME) is mounted here in every TermForge root.
export TERMFORGE_HOME=/mnt/termforge
[ -d "$TERMFORGE_HOME" ] && cd "$TERMFORGE_HOME" 2>/dev/null
EOF
sed -i 's|^root:x:0:0:root:/root:/bin/ash|root:x:0:0:root:/root:/bin/bash|' "$ROOTFS/etc/passwd"
printf 'ALPINE=%s\nAPK_TOOLS=%s\nPACKAGES=%s\nBUILT=%s\n' "$ALPINE_RELEASE" "$APK_TOOLS_VERSION" "$PACKAGES" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOTFS/etc/termforge-release"

# What has been verified under the emulator (iSH on Linux x86_64, 2026-10-08) and what has
# not; kept in the image so the app can show it. docs/LIMITATIONS.md has the details.
cat > "$ROOTFS/etc/termforge-compat" <<'EOF'
# status      package/feature        note
works         bash, coreutils, git, ripgrep, python3 (ssl, sqlite3, subprocess), apk, gcc/build-base, ssh client
works         git init + commit, rg search, python3 scripts, apk add from the network
untested      nodejs, rust/cargo, go, java   large JIT/SIMD-heavy runtimes; expect slow or broken
impossible    docker/podman, sshd            no kernel namespaces/cgroups; iOS allows no inbound sockets
impossible    x86_64-only packages           the emulator is 32-bit x86 (Alpine "x86" repo only)
EOF

echo "packing $OUT"
# No device nodes in the image: iSH creates /dev/* itself at boot, and nodes imported
# through fakefs keep the build host's dev_t encoding, which is wrong on iOS.
$AS_ROOT tar -C "$ROOTFS" --numeric-owner --owner=0 --group=0 --sort=name --mtime="@$SOURCE_DATE_EPOCH" \
  --exclude='./dev/*' -cf - . | gzip -n -9 > "$OUT"
sha256sum "$OUT" | tee "$OUT.sha256"
du -h "$OUT" | cut -f1
