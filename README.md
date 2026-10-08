# TermForge

A native iOS terminal that runs **Claude Code inside the app**. No SSH and no remote
machine. Node.js (nodejs-mobile, V8 without JIT) runs in-process, and every tab is a
worker thread behind a virtual TTY rendered by SwiftTerm.

> Status: **phase 1, in progress.** The runtime, tabs, TTY, REPL, rotation and
> suspend/resume pass in the iOS simulator. Claude Code installs there but cannot load
> until nodejs-mobile is rebuilt with ICU (`build-nodejs-mobile.yml`); it already runs on
> desktop Node 18 `--jitless`. Phases 2–4 and the FastPath engine are not started. Read
> [docs/LIMITATIONS.md](docs/LIMITATIONS.md) first: Claude Code is pinned to 2.1.112, the
> last release published as JavaScript, and Anthropic's hosting terms apply.

## Build (needs a Mac with Xcode 26)

```sh
brew install xcodegen
scripts/bootstrap.sh          # fetches NodeMobile.xcframework (SHA-256 pinned), generates TermForge.xcodeproj
open TermForge.xcodeproj      # scheme TermForge (App Store) or TermForge-Sideload
```

Every push is built and tested on a GitHub macOS runner. The workflow runs the iOS
simulator unit and UI tests, an unsigned Release device build, and the App Store static
checks.

The Node side can be tested without a Mac:

```sh
node --test nodejs-tests/                          # Node 18.20.4 recommended (same as the device)
cd tools/desktop-harness && npm ci
node run-session.mjs --home /tmp/tf-home --install claude-code --kind claude --until "Choose the text style"
```

## Layout

| path | what |
|---|---|
| `App/` | SwiftUI app: tabs, settings, install card, quick actions, Keychain, web sign-in |
| `Packages/NodeCore` | nodejs-mobile wrapper: runtime thread, socketpair control channel, sessions |
| `Packages/TerminalUI` | SwiftTerm host view, extra-keys bar |
| `nodejs-project/` | runs inside Node: supervisor, virtual TTY, child_process shim, installer, pins |
| `nodejs-tests/`, `Tests/` | Node tests, iOS unit + UI tests |
| `tools/desktop-harness` | desktop stand-in for the app: boots the supervisor, renders a tab in a headless xterm |
| `scripts/` | bootstrap, nodejs-mobile fetch, Claude Code vendoring report, App Store checks |
| `docs/` | ARCHITECTURE, LIMITATIONS, PERFORMANCE, SIDELOAD |

Claude Code is © Anthropic PBC. It is not part of this repository or the app binary:
each device downloads the pinned package from the npm registry and verifies its
SHA-512 before unpacking it.
