# TermForge

A native iOS terminal that runs **Claude Code inside the app**. No SSH and no remote
machine. Node.js (nodejs-mobile, V8 without JIT) runs in-process, and every tab is a
worker thread behind a virtual TTY rendered by SwiftTerm.

> Status: **phases 1–3 pass in the iOS simulator** (CI run 37737720431): Claude Code
> 2.1.112 renders in a tab in 1.6 s on the ICU build of nodejs-mobile; the Alpine x86 root
> boots in iSH in ~140 ms with Documents at `/mnt/termforge`; bash, python3, git and
> ripgrep run there; a Node session's `child_process` calls run `git init && git commit`
> and `rg` inside the Linux layer, in the shared folder (the acceptance path, run 37742367010).
> On a real iPhone via TestFlight: Claude Code signs in and answers prompts (build 5).
> Because the API refuses the newest models to Claude Code 2.1.112, an **Agent tab** —
> TermForge's own Messages API chat with file tools and `bash` in the Linux layer, on the
> user's API key — gives access to Claude Opus 5.5, Fable 5.1 and the rest. Not yet done:
> phase 4 (distro manager, Files provider), the FastPath engine. Read
> [docs/LIMITATIONS.md](docs/LIMITATIONS.md): Claude Code is pinned to 2.1.112 (the last
> JavaScript release), Anthropic's hosting terms apply, and TermForge is GPL-3.0 because it
> embeds iSH.

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
| `Packages/LinuxCore` | iSH wrapper: boot, pty sessions, piped exec (`iSHCore.xcframework` from `build-ish.yml`) |
| `tools/ish/` | the C shim over iSH's kernel, its Linux test harness, the iOS cross-build script |
| `nodejs-project/` | runs inside Node: supervisor, virtual TTY, child_process shim, installer, pins |
| `nodejs-project/agent/` | the Agent tab: TermForge's own Messages API chat with file tools and `bash` in the Linux layer (API key; Opus 5.5, Fable 5.1, …) |
| `nodejs-tests/`, `Tests/` | Node tests, iOS unit + UI tests |
| `tools/desktop-harness` | desktop stand-in for the app: boots the supervisor, renders a tab in a headless xterm |
| `scripts/` | bootstrap, framework fetches, Alpine rootfs builder, Claude Code vendoring report, App Store checks |
| `docs/` | ARCHITECTURE, LIMITATIONS, PERFORMANCE, SIDELOAD |

## Licence

TermForge is licensed under the **GNU GPL-3.0** (see `LICENSE`) because it embeds
[iSH](https://github.com/ish-app/ish) (GPL-3.0; its LICENSE.IOS covers App Store
distribution). SwiftTerm is MIT, nodejs-mobile carries Node.js's licence, libarchive is
BSD-2-Clause.

Claude Code is © Anthropic PBC. It is not part of this repository or the app binary:
each device downloads the pinned package from the npm registry and verifies its
SHA-512 before unpacking it, complete and unmodified, as Anthropic's terms require.
