#!/usr/bin/env bash
# Static checks on a built TermForge.app (macOS host). Fails only on violations in
# TermForge's own code; facts about the embedded NodeMobile framework are reported.
#   scripts/check-appstore-compliance.sh path/to/TermForge.app
set -euo pipefail
APP="${1:?usage: $0 path/to/TermForge.app}"
EXE="$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
NODE="$APP/Frameworks/NodeMobile.framework/NodeMobile"
FAIL=0
SPAWN='_(posix_spawnp?|fork|vfork|execv|execve|execvp|execl|execlp|system|popen)$'

echo "== TermForge executable: process creation"
HITS="$(nm -u "$EXE" | grep -E "$SPAWN" || true)"
if [ -n "$HITS" ]; then echo "VIOLATION: app code imports:"; echo "$HITS"; FAIL=1; else echo "ok: no fork/exec/posix_spawn imports"; fi

echo "== TermForge executable: JIT"
HITS="$(nm -u "$EXE" | grep -E '_(pthread_jit_write_protect_np|pthread_jit_write_with_callback_np|sys_icache_invalidate)$' || true)"
if [ -n "$HITS" ]; then echo "VIOLATION: JIT-related imports:"; echo "$HITS"; FAIL=1; else echo "ok: no JIT write-protect / icache imports"; fi

echo "== Entitlements"
ENT="$(codesign -d --entitlements :- "$APP" 2>/dev/null || true)"
if echo "$ENT" | grep -qE 'dynamic-codesigning|allow-jit|allow-unsigned-executable-memory'; then
  echo "VIOLATION: JIT entitlement present"; FAIL=1
else
  if [ -n "$ENT" ]; then echo "ok: no JIT entitlements (signed build)"; else echo "ok: unsigned build, no entitlements"; fi
fi

echo "== Private frameworks"
if otool -L "$EXE" | grep -q '/PrivateFrameworks/'; then echo "VIOLATION: links a private framework"; otool -L "$EXE"; FAIL=1; else echo "ok: public frameworks only"; fi

echo "== iSHCore (statically linked into the app: its imports are the app's)"
HITS="$(nm -u "$EXE" | grep -E '_(ptrace|mach_vm_protect|vm_protect|mprotect|task_for_pid)$' || true)"
if [ -n "$HITS" ]; then echo "note: memory/ptrace imports (iSH uses mprotect for the emulated address space; no JIT):"; echo "$HITS"; else echo "ok: none"; fi

if [ -f "$NODE" ]; then
  echo "== NodeMobile.framework (report only)"
  echo "process-creation symbols imported by libuv (never called: every session's child_process is the shim):"
  nm -u "$NODE" | grep -E "$SPAWN" | sed 's/^/  /' || echo "  none"
  echo "JIT-related imports:"
  nm -u "$NODE" | grep -E '_(pthread_jit_write_protect_np|pthread_jit_write_with_callback_np)$' | sed 's/^/  /' || echo "  none"
  if otool -L "$NODE" | grep -q '/PrivateFrameworks/'; then echo "  links a private framework"; else echo "  public frameworks only"; fi
fi
exit $FAIL
