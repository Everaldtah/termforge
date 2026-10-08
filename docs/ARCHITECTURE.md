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
- **jitless V8 has no WebAssembly, and Node 18's `fetch` needs it.** `lib/fetch-https.js`
  installs a `fetch` built on Node's http/https client in every worker (same `Response`,
  `Headers`, `Request` classes; streaming bodies via `Readable.toWeb`). Claude Code's API
  client is a `fetch` user, so without this no prompt can be sent.
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
`registry.npmjs.org`, checks the SHA-512 from `nodejs-project/pins.json`, and unpacks the
**complete package, unmodified**, into
`Application Support/TermForge/packages/claude-code/<version>`. The
`.staging-* → rename` step makes the install atomic. Anthropic's terms for hosting
Claude Code require it to be "installed and run as published", with none of its sign-in
methods removed. So TermForge changes the environment Claude Code runs in (the Node
runtime, the TTY, `child_process`, documented environment variables) and never touches
its files. The desktop binaries under `vendor/` stay on disk and are never executed.

**Version ceiling:** 2.1.112 (2026-04-16) is the last release published as a JavaScript
bundle. From 2.1.113 on, the npm package installs a prebuilt native executable per
desktop OS and declares Node ≥ 22, so there is nothing for nodejs-mobile (Node 18) to
run. See LIMITATIONS.md.

**ICU:** upstream nodejs-mobile is built `--with-intl=none`: no `Intl` object, and no
Unicode property escapes in regular expressions. Claude Code 2.1.112 fails to load on it
with `SyntaxError: Invalid regular expression: /^\p{Default_Ignorable_Code_Point}$/`
(seen in the iOS simulator, and reproduced on a Linux Node 18.20.4 built
`--with-intl=none`). `.github/workflows/build-nodejs-mobile.yml` rebuilds nodejs-mobile
v18.20.4 with `small-icu` using `tools/nodejs-mobile/patch-icu.sh`.

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

## Linux layer (phase 2)

`Packages/LinuxCore` wraps **iSH** (ish-app/ish @ 8334836, GPL-3.0 with LICENSE.IOS):
an interpreted 32-bit x86 emulator plus a Linux syscall layer, all in C, no JIT, no
fork. `tools/ish/shim/tf_ish.c` is the only code that touches iSH's internals; it does
what iSH's own app does in `AppDelegate.m` / `TerminalViewController.m`:

- `tf_ish_boot`: mount the fakefs root, `/proc`, `/dev/pts`, and the app's Documents
  folder (realfs) at `/mnt/termforge`; drop any device nodes that came with the root
  (their `rdev` is host-encoded; see LIMITATIONS.md) and let iSH create `/dev/*`; set a
  fixed guest hostname; start a tiny init that reaps orphans.
- `tf_ish_session_start`: a process on a new pseudo-terminal (`pty_open_fake` with a
  driver whose `write` is the host callback), `create_stdio`, `do_execve`, `task_start`.
- `tf_ish_exec`: a process whose stdin/stdout/stderr are host pipes (`adhoc_fd_create`
  over `realfs_fdops`), for child_process. Exit statuses are decoded from wait status.

`tools/ish/build-ios.sh` cross-compiles iSH with meson (device + simulator; the vdso
needs Homebrew LLVM + lld), iSH's vendored libarchive with its Xcode project, and the
shim, then merges everything into `iSHCore.xcframework`
(`.github/workflows/build-ish.yml`, release `ish-8334836`). The same shim is tested on
Linux first (`tools/ish/test-linux.sh`), where iSH builds natively.

The root filesystem is Alpine 3.20 x86 with the brief's package set, built by
`scripts/build-rootfs.sh` (apk-tools-static, pinned versions, fixed mtimes) in
`.github/workflows/build-rootfs.yml` and published as release `rootfs-alpine-x86`. The
app downloads it on first use, checks the SHA-256, and converts it with iSH's own
`fakefs_import` (`Application Support/TermForge/roots/alpine-x86`). Alpine's `root`
shell is bash; `/etc/profile.d/termforge.sh` starts shells in `/mnt/termforge`; the image
ships no `/dev` entries and `/etc/gitconfig` trusts every repository (`safe.directory = *`),
because files on the host mount belong to the app's uid while the guest runs as root.

## child_process → Linux (phase 3)

Once the Linux layer has booted, the app sets `NodeRuntime.execBackend` and Node is
told `{event:"linux", available:true}`. Each session worker has a `LinuxTier`
(`nodejs-project/lib/linux-tier.js`) after the host-url tier:

1. The tier rewrites the request for the guest: absolute host paths under `$HOME`
   become `/mnt/termforge/...`, `PATH`/`HOME`/`TMPDIR` are replaced by guest values.
2. It posts `exec-start` to the supervisor over a dedicated `MessagePort`; the
   supervisor allocates an exec channel (≥ `0x40000000`) and sends `REQUEST {op:"exec"}`
   to Swift, which starts the program through `ExecBackend` (the app's
   `LinuxExecBackend` → `LinuxRuntime.exec`).
3. stdin flows as `EXEC_IN` frames (empty = EOF); stdout/stderr come back as `EXEC_OUT`
   (first byte is the fd) and the exit as `EXEC_EXIT`. Kills go as `REQUEST {op:"exec-kill"}`,
   applied after the start response if they arrive early.
4. `spawnSync`/`execSync` block the worker on a `SharedArrayBuffer` until the supervisor
   posts the collected result on the exec port (`receiveMessageOnPort`).

The desktop test double (`nodejs-tests/host-client.js`) answers exec requests with real
host processes, so `nodejs-tests/exec.test.js` covers the whole protocol without iOS.

## Agent tab (Messages API)

Claude Code 2.1.112 is the newest client that runs on Node 18, and the API refuses the
newest models to it (`claude_code_version_too_old`: Opus 5.5 wants ≥ 2.1.280, Fable 5.1
≥ 2.1.251). TermForge does not spoof a client version — Anthropic's terms forbid modifying
the installed Claude Code — so the latest models come through a second kind of tab that is
TermForge's own code: `nodejs-project/agent/`, a chat on the Messages API with the user's
API key (Keychain → `ANTHROPIC_API_KEY`; billed to the API account, never a subscription).

- `agent/api.js` — raw HTTP over the session's `fetch` (the jitless shim) with an SSE
  parser and a message assembler; retries 408/409/429/5xx/529 and connection failures with
  `retry-after`/backoff until the first content block has arrived. No SDK: nothing can be
  npm-installed at runtime on the device and the official SDK has dependencies of its own.
- `agent/tools.js` — `read_file`, `write_file`, `edit_file`, `list_dir` (confined to the
  Documents folder, `/mnt/termforge/...` paths accepted) and `bash` (`bash -c` through the
  session's `child_process` shim, so it runs inside the Alpine root like Claude Code's
  tools; 64 KB output cap, 120 s default timeout). All tools set `eager_input_streaming`,
  so the client validates: strict `JSON.parse` of the fragments, then a schema check, and
  a broken call goes back as an `INVALID_JSON` error result instead of running.
- `agent/loop.js` — append-only history (assistant content replayed unchanged, thinking
  signatures included), every tool result of a turn in one user message, `max_tokens` and
  `refusal` stops handled before any tool runs, `thinking: adaptive` +
  `output_config.effort`, `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`)
  on the models that take it, and a cached prefix: tools → system prompt (breakpoint) →
  messages (top-level `cache_control`). Cost is estimated from the usage block with the
  table in `MODELS`.
- `agent/main.mjs` — the terminal UI on `readline` over the virtual TTY: streamed text,
  `⚙ tool` lines with result previews, a per-turn usage/cost line, `/model`, `/models`,
  `/effort`, `/clear`, `/cost`, `/exit`; Ctrl-C aborts the in-flight request through the
  fetch shim's `AbortSignal`.

Swift: `SessionKind.agent`, `TabKind.node(.agent)`, the "Agent (API key)…" item in the
tab menu, `APIKeyCard` in a tab that has no key yet (saving the key restarts those tabs),
and a Settings section for the default model and effort (`AgentSettings`, passed as
`TERMFORGE_AGENT_MODEL` / `TERMFORGE_AGENT_EFFORT`).

## Tests

| suite | runs on | what |
|---|---|---|
| `nodejs-tests/` (node:test) | Node 18.20.4 `--jitless`, CI ubuntu + local | frame codec, vtty line discipline, shim semantics vs real Node, installer (integrity, pax/GNU names, traversal), supervisor over TCP incl. two tabs with separate cwds; the agent against a scripted Messages API (SSE split across writes, two tool calls in one turn incl. `bash` through the Linux tier, history replay, 529 retry, `INVALID_JSON`, refusal, slash commands, no-key exit) |
| `tools/desktop-harness` | same | boots the real supervisor, installs Claude Code from npm, renders it in a headless xterm, drives keys, reports timings |
| `tools/ish/test-linux.sh` | Linux (iSH built natively) | the C shim: boot, pty session, piped exec against the Alpine root |
| `Tests/TermForgeTests` | iOS simulator (CI) | Swift frame codec parity with JS; the real nodejs-mobile runtime: pings, raw-mode TTY program, REPL, NOT_INSTALLED; Claude Code install + first screen; Linux root install, boot, bash/python3/git/rg, piped git init+commit |
| `Tests/TermForgeUITests` | iOS simulator (CI) | REPL round trip, rotation, home/resume, on-device install + Claude Code first screen |
