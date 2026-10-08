# TermForge architecture

TermForge is a native iOS terminal that runs Claude Code inside the app process. No SSH,
no remote host. This document describes what exists now (phase 1). Later phases add
sections when they land.

```
┌────────────────────────── TermForge.app (one iOS process) ───────────────────────────┐
│ SwiftUI: tabs, settings, install card, quick actions            App/                 │
│   │                                                                                  │
│ TerminalUI: SwiftTerm view per tab + extra-keys bar             Packages/TerminalUI  │
│   │  keystrokes ▲ screen bytes                                                       │
│ NodeCore: NodeRuntime / NodeSession, frame codec                Packages/NodeCore    │
│   │  socketpair(AF_UNIX) - one fd each side, framed protocol                         │
│ ──┼────────────────────────────────────────────────────────────────────────────────  │
│ "nodejs" thread: nodejs-mobile (Node 18.20.4, V8 --jitless)     NodeMobile.xcframework│
│   main.js supervisor  ── one worker thread per tab ──┐          nodejs-project/      │
│                                                      ▼                               │
│        session-worker.js: virtual TTY + child_process shim + per-tab cwd             │
│                           └─ Claude Code cli.js │ Node REPL │ script                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
   $HOME = Documents/ (Files app)          Application Support/TermForge = packages
```

## Why this shape

- **nodejs-mobile can start Node once per process.** `node_start()` runs on a dedicated
  4 MB-stack thread for the life of the app. Programs that call `process.exit()` must not
  take it down, so every tab runs in its own `worker_thread`. `process.exit()` in a
  worker ends that worker only. The supervisor reports it as an EXIT frame and the tab
  offers Restart.
- **iOS gives sandboxed apps no pty devices.** `lib/vtty.js` stands in for one. It
  provides `process.stdin/stdout/stderr` objects with `isTTY`, `setRawMode`, `columns/rows`,
  `'resize'` and `getColorDepth()`, plus the line discipline that programs expect from the
  kernel: ICANON line editing, ECHO and ECHOCTL, ISIG (^C becomes SIGINT, ^\ becomes
  SIGQUIT), ^D EOF, and ONLCR output (`\n` becomes `\r\n`, as with a real tty even in raw
  mode). Ink (Claude Code's renderer) gets raw mode and resize events exactly as on a
  desktop terminal.
- **iOS forbids fork/exec.** `lib/child-process-shim.js` replaces `spawn`, `exec`,
  `execFile`, their `Sync` forms and `fork`, in both the CommonJS exports and the ESM
  named exports (`syncBuiltinESMExports`). Each call goes to an ordered list of
  **tiers**. The first tier that claims the command runs it. If no tier claims it, the
  call fails exactly like spawning a missing binary: an `ENOENT` 'error' event, then
  'close' with -2, matching Node 18's ordering. Every call is reported with the tier that
  handled it.
  - Phase 1 tiers: `host-url` handles `xdg-open`/`open <url>` by asking the app to open
    the URL. Everything else falls through to `none`.
  - Phase 3 adds the Linux tier (git, bash, rg, ...). FastPath adds Swift-native and wasm
    tiers in front of it.
- **Worker threads share one OS working directory.** `lib/virtual-cwd.js` gives each
  tab its own `process.cwd()`/`chdir()`. It also resolves relative path arguments of
  `fs`, `fs/promises` and their Sync forms against that cwd before they reach libuv.

## Control protocol

One `AF_UNIX` socketpair is created by Swift before `node_start`. Node gets its end as
`--control-fd=N` and wraps it in a `net.Socket`, so there is no filesystem path and no
port. The same code speaks TCP in desktop tests (`--control-tcp`).

Frame: `u32 BE length | u8 type | u32 BE channel | payload`. Channel 0 is control, and
channels ≥ 1 are tabs.

| type | dir | payload |
|---|---|---|
| HELLO 0x01 | N→S | `{node, v8, platform, arch, jitless, pid, supervisorMs, processUptimeMs}` |
| OPEN 0x02 | S→N | `SessionSpec` JSON: kind, cols, rows, cwd, env, argv, entry, platform |
| DATA 0x03 | both | raw bytes (keystrokes / screen output) |
| RESIZE 0x04 | S→N | u16 cols, u16 rows |
| SIGNAL 0x05 | S→N | u8 signal number |
| CLOSE 0x06 | S→N | terminate the tab's worker |
| EXIT 0x07 | N→S | `{code, error, reason, ms}`; reason `NOT_INSTALLED` drives the install card |
| REQUEST/RESPONSE 0x08/0x09 | control | `ping`, `status`, `install`, `uninstall` |
| EVENT 0x0a | N→S | `metric`, `exec` (tier log), `open-url`, `install-progress` |
| LOG 0x0b | N→S | text |

Output batching: a worker coalesces everything written in one event-loop turn into one
message. The supervisor corks the socket for one tick, and SwiftTerm batches redraws on
its side.

## Claude Code delivery

Claude Code is © Anthropic PBC and is not redistributed: it is not in this repository
and not in the app binary. On first use, the device downloads the pinned tarball from
`registry.npmjs.org` and checks the SHA-512 from `nodejs-project/pins.json`. It then
unpacks only `cli.js`, `package.json`, `README.md`, `LICENSE.md` and `sdk-tools.d.ts`
into `Application Support/TermForge/packages/claude-code/<version>`. The
`.staging-* → rename` step makes the install atomic. Desktop-only native files
(`vendor/ripgrep`, `vendor/seccomp`, `vendor/audio-capture`) are skipped and listed in the
install manifest.

**Version ceiling:** 2.1.112 (2026-04-16) is the last release published as a JavaScript
bundle. From 2.1.113 on, the npm package installs a prebuilt native executable per
desktop OS and declares Node ≥ 22, so there is nothing for nodejs-mobile (Node 18) to
run. See LIMITATIONS.md.

Claude Code tabs set `process.platform = "linux"` because their tools will run in the
Linux layer. On Linux, Claude Code also keeps OAuth credentials in `~/.claude`, not in a
macOS keychain it cannot reach. Each tab also gets `DISABLE_AUTOUPDATER=1` and
`USE_BUILTIN_RIPGREP=0`.

## Authentication

- **API key**: stored in the Keychain (`AfterFirstUnlockThisDeviceOnly`) and passed to
  new Claude tabs as `ANTHROPIC_API_KEY`.
- **Claude account (`/login`)**: Claude Code spawns `xdg-open <authorize-url>`. The
  host-url tier turns that into an `open-url` event, and the app opens it in an
  `ASWebAuthenticationSession`, which keeps TermForge in the foreground. The authorize
  URL redirects to `http://localhost:<port>/callback`, served by Claude Code inside this
  app. Claude Code also prints a paste-the-code URL that works without the redirect.
  Anthropic's OAuth client does not accept a custom-scheme redirect, so none is used.

## Filesystem

| path | what |
|---|---|
| `Documents/` | `$HOME` for Node and every tab, and the Files app's view of TermForge (`UIFileSharingEnabled`, open-in-place) |
| `Documents/Projects/<name>` | project folders; a Claude tab's cwd |
| `Documents/.claude*` | Claude Code's settings, transcripts and credentials |
| `Application Support/TermForge/packages` | installed packages, `pin-overrides.json` (sideload) |

Phase 2 mounts this same `Documents/` directory into every rootfs, so the shell and
Claude Code edit the same files.

## Lifecycle

- Launch: `NodeRuntime.start` sets `HOME`/`TMPDIR`, creates the socketpair, starts the
  Node thread and waits for HELLO. Saved tabs are then reopened. Claude tabs get
  `--continue` (resume the most recent conversation in that folder) only when a
  transcript exists there, so a folder with no history starts a fresh conversation.
  The brief said `--resume`, but without a session id that opens a picker; `--continue`
  is the flag that resumes the last session.
- Suspend: iOS freezes the whole process. Nothing runs in the background and TermForge
  does not claim otherwise. Each tab's `TerminalView` and the Node heap survive a
  suspend/resume in memory. If iOS terminates the app, the tab list is restored on the
  next launch and Claude tabs resume their last conversation.

## Tests

| suite | runs on | what |
|---|---|---|
| `nodejs-tests/` (node:test) | Node 18.20.4 `--jitless`, CI ubuntu + local | frame codec, vtty line discipline, shim semantics vs real Node, installer (integrity, pax/GNU names, traversal), supervisor over TCP incl. two tabs with separate cwds |
| `tools/desktop-harness` | same | boots the real supervisor, installs Claude Code from npm, renders it in a headless xterm, drives keys, reports timings |
| `Tests/TermForgeTests` | iOS simulator (CI) | Swift frame codec parity with JS; the real nodejs-mobile runtime: pings, raw-mode TTY program, REPL, NOT_INSTALLED |
| `Tests/TermForgeUITests` | iOS simulator (CI) | REPL round trip, rotation, home/resume, on-device install + Claude Code first screen |
