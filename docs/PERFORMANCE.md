# Performance

Measured numbers only. Each table says where it was measured. There are **no device
numbers yet**: everything below is a GitHub-hosted macOS runner's iOS simulator (x86_64 or
arm64 host, shared and noisy) or Linux x64 under WSL. The phase-1 target in the brief,
Claude Code startup under 4 s on an A15, is unverified.

## iOS simulator (CI, `xcodebuild test`, `METRIC` lines)

Three runs on 2026-10-08, same code, different runners. Spread shows runner noise, not
code changes.

| metric | run 1 | run 2 | run 3 | what it is |
|---|---|---|---|---|
| runtime.startToHello | 2714 ms | 171 ms | 165 ms | `NodeRuntime.start` to Node's HELLO frame (first run includes cold page-in of the 55 MB framework) |
| control.roundTrip.median | 0.49 ms | 0.20 ms | 0.17 ms | Swift request → Node → Swift, median of 30 |
| control.roundTrip.p95 | 4.21 ms | 0.35 ms | 0.40 ms | |
| keystroke.programEcho.median | 10.5 ms | 0.34 ms | 0.25 ms | key byte → raw-mode JS program → echo back to Swift, median of 20 |
| keystroke.programEcho.p95 | 12.5 ms | 0.44 ms | 0.34 ms | |
| script.openToFirstOutput | 424 ms | 34 ms | 38 ms | OPEN frame → first byte from a new worker |
| repl.openToPrompt | – | 40 ms | 275 ms | OPEN → Node REPL prompt visible |
| claude.install | – | – | 538–647 ms | download 13.4 MB tarball from registry.npmjs.org + SHA-512 + unpack (runner network) |
| claude.openToFirstScreen | – | – | **not reached** | upstream nodejs-mobile has no ICU (LIMITATIONS.md) |

With the ICU build of nodejs-mobile (run 37728463558, 2026-10-08, arm64 simulator on a
macos-15 runner): Claude Code **reaches its first screen** ("Choose the text style").

| metric | value | what it is |
|---|---|---|
| claude.install | 1201 ms | 48 MB package from registry.npmjs.org, SHA-512, unpack |
| claude.session.entryLoaded | 2140 ms | `import` of the 13.4 MB cli.js under jitless V8 |
| claude.openToFirstOutput | 3170 ms | OPEN frame → first byte on the Swift side |
| linux.rootfs.download | 2319 ms | 107 MB from GitHub releases (runner network) |
| linux.rootfs.import | 5834 ms | tar.gz → fakefs (iSH's `fakefs_import`, simulator disk) |
| linux.boot | 201 ms | `tf_ish_boot`: mount root, /proc, /dev/pts, host mount, init |
| linux.session | see below | (an earlier run crashed in `do_uname` on the simulator's long hostname; fixed in the shim) |

First fully green run (37737720431, 2026-10-08): Claude Code `claude.openToFirstScreen`
**1554 ms** (install 777 ms, entryLoaded 694 ms); UI test install-tap → Claude screen
2283 ms; Linux boot 137 ms, bash+python3+git+rg session 975 ms, piped `git init`+commit
106 ms, Linux tab → prompt 4025 ms; REPL open → prompt 84 ms; keystroke echo median
0.43 ms. Simulator on an arm64 macOS runner; no device numbers yet.

Linux layer in the simulator after the hostname and device-node fixes (runs 37733216089
and 37736288054):

| metric | value | what it is |
|---|---|---|
| linux.boot | 91–117 ms | `tf_ish_boot` |
| linux.session.bashPythonGitRg | 670–2497 ms | one pty session running bash + python3 + git + rg + cat, open to exit |
| python3 `-c print` session | exit 0, output correct | per-tool sessions all return their output |
| linux.exec.gitInitCommit | 57 ms | piped exec (`git` then refused the host-owned repo until `/etc/gitconfig` trusted it) |
| bridge.nodeGitInitCommitViaLinux | 363–1781 ms | a Node script's child_process calls (uname, git init/add/commit/log, rg) through the tier, the supervisor, ExecBackend and iSH, writing into Documents (run 37742367010) |
| uitest.linuxTabToPrompt | 3009 ms | new Linux tab → bash prompt (root already imported); `python3 -c 'print(6*7)'` → 42 |
| linux.rootfs.download / import | 2.0–7.5 s / 2.9–5.8 s | 107 MB from GitHub releases; tar.gz → fakefs |

The keystroke path above stops at the Swift side; it does not include SwiftTerm's
render. No screen-latency measurement exists yet.

## Linux x64, Node 18.20.4 `--jitless` (WSL, desktop harness)

Stand-in for the device runtime: same Node version and V8 mode, but x64 with a real
JIT-less interpreter on a desktop CPU. Not comparable to an A15 in absolute terms.

| metric | full-icu (nodejs.org build) | small-icu + brkitr (our build) |
|---|---|---|
| supervisor up (HELLO) | 83–117 ms | 113 ms |
| session.entryLoaded (import of cli.js, 13.4 MB) | 737–781 ms | 833 ms |
| first output byte | 1181–1293 ms | 1348 ms |
| "Choose the text style" screen visible | ~2.5 s (incl. 100-col render) | 1913 ms |
| control round trip median / p95 | 0.29 / 0.52 ms | – |
| keystroke → program → echo | 0.87 ms | – |

Unit-test numbers come from `node --test nodejs-tests/` diagnostics; session numbers from
`tools/desktop-harness/run-session.mjs --report`.

## Linux layer on Linux x86_64 (iSH built natively, WSL; same code as iOS, different CPU)

Measured with `tools/ish/test-linux.sh` and direct `ish` runs on the Alpine x86 root
(2026-10-08). An A15 interprets x86 slower than a desktop x86_64 host runs it, so these
are lower bounds for the device.

| metric | value |
|---|---|
| kernel boot (mount root, /proc, /dev/pts, host mount, init) | 42–100 ms |
| `bash -c echo` on a pty, open to exit | 70–135 ms |
| `git --version` | 33 ms |
| `rg --version` | 40 ms |
| `python3 -c print(1)` | 480 ms |
| `git init && git commit` | 736 ms |
| piped exec `sh -c` with stdin/stdout/stderr | 22–26 ms |
| `apk add jq` (network + install) | 12.3 s |
| rootfs tar.gz → fakefs import (300 MB) | 1.5 s (fakefsify, desktop NVMe) |

## Not measured yet

- Anything on a real iPhone or iPad.
- SwiftTerm render latency, scrollback cost, 120 Hz behaviour.
- Claude Code startup in the simulator with the ICU build of nodejs-mobile.
- A prompt round trip through the API (needs credentials on the test device).
