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
| claude.openToFirstScreen | – | – | **not reached** | Claude Code failed to load: no ICU in upstream nodejs-mobile (LIMITATIONS.md) |

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

## Not measured yet

- Anything on a real iPhone or iPad.
- SwiftTerm render latency, scrollback cost, 120 Hz behaviour.
- Claude Code startup in the simulator with the ICU build of nodejs-mobile.
- A prompt round trip through the API (needs credentials on the test device).
