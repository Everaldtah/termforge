# Limitations

These are the facts as of 2026-10-08. Each section says whether it was measured or
looked up, or whether it is still unverified.

## Claude Code is pinned to 2.1.112 (looked up)

- `@anthropic-ai/claude-code` 2.1.112 (published 2026-04-16) is the last release whose
  npm package contains `cli.js`, a JavaScript bundle with `engines.node >= 18`.
- 2.1.113 and later ship a prebuilt native executable per desktop OS (`bin/claude.exe`
  plus `@anthropic-ai/claude-code-<os>-<arch>` packages) and require Node ≥ 22. iOS
  cannot execute those binaries, and nodejs-mobile's newest release is Node 18.20.4
  (2024-10-07). Its `update22-9-0` branch has not moved since 2024-10-17.
- TermForge does not extract, patch or repackage the native builds. The package is
  "© Anthropic PBC. All rights reserved", so it is downloaded by each device from the npm
  registry and run unmodified.
- What this costs: features and fixes released after April 2026 are missing. Anthropic
  could also, at any time, require a newer client than 2.1.112 for its API or for
  Claude-account sign-in. If that happens, these tabs stop working until a JavaScript
  build or a Node ≥ 22 iOS runtime exists. **This is the main risk to the whole app.**

## Anthropic's terms for hosting Claude Code (looked up)

From code.claude.com/docs/en/legal-and-compliance, 2026-10-08:

- "The Claude Code binary must not be modified. Claude Code must be installed and run as
  published by Anthropic, and customers may not remove, disable, or restrict any
  authentication method built into it." TermForge unpacks the npm package complete and
  byte-for-byte, keeps both API-key and Claude-account sign-in, and changes only the
  environment (Node runtime, TTY, child_process, documented env vars).
- "Each end user must authenticate with their own Anthropic API key, Claude subscription
  plan credentials, or 3P inference provider credential." TermForge never supplies,
  pools or proxies credentials.
- Hosting is allowed: the terms don't "prevent an end user from signing in to the
  unmodified Claude Code binary with their own Claude subscription, including where a
  platform hosts Claude Code". Sign-in completes in Claude Code's own OAuth flow, and
  TermForge code never reads the tokens.
- Distributing TermForge to other people with Claude Code preinstalled or run in it
  "requires agreeing to our Commercial Terms of Service". Running it on your own device is
  your own use of Claude Code.
- Naming: the product may say it "runs Claude Code" in plain text, but it may not use
  "Claude Code" or "Anthropic" in its own name or logo.

## nodejs-mobile has no ICU (measured)

- Upstream nodejs-mobile builds with `--with-intl=none`, so V8 has no `Intl` object and
  cannot parse `\p{...}` regular expressions. In the iOS simulator, Claude Code 2.1.112
  fails to load: `SyntaxError: Invalid regular expression:
  /^\p{Default_Ignorable_Code_Point}$/: Invalid property name`. The same error
  reproduces on a Linux Node 18.20.4 built `--with-intl=none`.
- Node's `small-icu` is not enough either: its trim drops ICU's break-iterator data, and
  V8 then aborts the process inside `Intl.Segmenter` (exit 1, no message), which Claude
  Code's renderer uses for text width. Measured on Linux: `small-icu` runs `cli.js`
  silently; `small-icu` plus `brkitr`/`brkfiles`/`brkdict` renders the first screen.
- Fix: `.github/workflows/build-nodejs-mobile.yml` with `tools/nodejs-mobile/patch-icu.sh`
  (small-icu, break-iterator data kept, ICU host tools built against the macOS SDK; the
  stock iOS gyp config links them for iPhoneOS, so `icutrim.py` cannot run them).
  Rewriting Claude Code's regular expressions would modify Claude Code, which the terms
  above forbid, and without ICU there is no `Intl` either.
- English-only locale data: `toLocaleString`, dates and currencies format in English on
  every device locale.

## No JIT (by design)

- V8 runs with `--jitless`, which App Store rules require. Everything is interpreted.
- jitless V8 has **no WebAssembly** (`--expose_wasm` is disabled). Node 18's built-in
  `fetch` (undici) parses HTTP with a wasm module, so every `fetch()` failed with
  "fetch failed" and Claude Code's API client retried forever ("retrying in 1m13") —
  seen on the first device build, reproduced on Linux. `nodejs-project/lib/fetch-https.js`
  replaces the global `fetch` in every session with one built on Node's http/https client
  (streaming bodies, redirects, AbortSignal, gzip), and Claude Code 2.1.112 then answers
  prompts under jitless (verified on Linux with a real login). Anything else that needs
  wasm still does not run in a Node tab.
- Startup cost: see PERFORMANCE.md. No device number exists yet.

## Phase 1 status (measured)

- **iOS simulator:** the Node runtime, tabs, raw-mode TTY, REPL, rotation and
  suspend/resume work (CI). Claude Code installs (complete package, about 0.6 s on CI's
  network) but fails to load until the ICU build of nodejs-mobile is in place.
- **Desktop stand-in** (Node 18.20.4 `--jitless` with full ICU, Linux): Claude Code
  starts, renders, takes keystrokes and hands its sign-in URL to the host. Every command
  it spawns fails with ENOENT because no execution tier exists yet. A probe run spawned
  `which npm/bun/yarn/deno/pnpm/node` and `rg --files` (see the vendoring report). The
  Bash, Grep, Glob and git-dependent features therefore do not work until phase 3.
  Reading, writing and editing files work, because they go through Node's `fs` in the
  shared home.
- `child_process.fork()` fails with ENOSYS.
- Native addons (`.node`) cannot load: iOS refuses unsigned dylibs.

## Sign-in (unverified on a device)

- Claude-account sign-in relies on Claude Code's `localhost` callback being reachable
  from `ASWebAuthenticationSession` while TermForge stays in the foreground. This has
  only been checked on a desktop, where the authorize URL is captured and handed off.
  The paste-the-code flow that Claude Code prints is the fallback, and it needs no
  redirect.

## Latest models: not in Claude Code tabs, yes in the Agent tab (measured)

- Claude Code 2.1.112 lists the models it shipped with (Opus 4.7 era). The API checks the
  client version per model: `claude-opus-5-5` needs Claude Code ≥ 2.1.280 and
  `claude-fable-5-1` ≥ 2.1.251 (`claude_code_version_too_old`), so a Claude Code tab can
  use Sonnet 5.5 / Haiku 5.5 but not those two. Newer Claude Code releases are native
  binaries for Node ≥ 22, which nodejs-mobile cannot run.
- TermForge does not spoof the client version or patch Claude Code (Anthropic's hosting
  terms). The Agent tab uses the Messages API directly instead, with the user's own API
  key, so it is billed to API credits rather than a Claude subscription, and it is not
  Claude Code: a smaller tool set (files + bash in the Linux layer), no MCP, no hooks, no
  slash-command ecosystem, no session resume yet.
- Prices shown by `/cost` are estimates from the usage block and a fixed price table;
  the API's invoice is the truth.
- **The newest Claude Code in an emulated Linux VM (measured 2026-10-09, parked):** the
  one way to run the published 2.1.295 binary unmodified on the subscription is a full
  system emulator, and the iOS-legal one is QEMU's TCI interpreter (what UTM SE ships).
  Measured on the PC with an Alpine aarch64 netboot VM, 2 vCPUs, 2 GB, the official
  `linux-arm64-musl` binary and the user's own login — JIT QEMU → TCI: boot 42 → 195 s,
  `claude -p` on Opus 5.5 13 → 130–141 s, on Fable 5.1 10.6 → 121 s. Turning JSC's
  optimising tiers off inside the guest (`BUN_JSC_useDFGJIT=false BUN_JSC_useFTLJIT=false`)
  gains ~10 %; `BUN_JSC_useJIT=false` is worse (202 s). Opus 5.5 and Fable 5.1 do answer
  through it, so the route is real, but ~2 minutes per prompt is not a terminal anyone
  would use; seeds termforge-81ba keeps the notes. User-mode emulators (Blink, QEMU-user)
  are out because they need the host's `fork`, which iOS does not have.
- What ships instead for "subscription + newest models": the **PC tab** — Claude Code runs
  on the user's own computer through `tools/pc-bridge` and the phone is its terminal. It
  needs that computer on and reachable (Tailscale or the same LAN).

## iOS process model

- iOS suspends TermForge in the background. Running prompts pause, and an HTTP stream
  that was mid-response usually fails; Claude Code reports it and you retry. TermForge
  does not request or claim background execution.
- nodejs-mobile starts Node once per process. If the Node runtime itself stops (not a
  tab), TermForge must be relaunched.
- The data-container path can change when the app is updated. Saved tabs keep their
  project folder by name, but Claude Code's per-folder history is keyed by absolute path,
  so `--continue` will not find a conversation recorded under the old path.
- Relative paths are resolved per tab for `fs` / `fs/promises` only. A library that
  hands relative paths straight to some other libuv call would still resolve them
  against the process-wide cwd.

## App Store review (judgement, not tested with Apple)

- The App Store build contains no fork/exec/posix_spawn calls of its own and no JIT
  entitlement. `scripts/check-appstore-compliance.sh` checks this on every CI build.
  NodeMobile's libuv still imports `posix_spawn`/`fork`. Those imports are never
  reached because every tab's `child_process` is the shim, but they are visible to a
  static scan.
- Guideline 2.5.2 bars downloading code that changes app features. Downloading and
  running Claude Code is the app's core function. The App Store build runs only the
  exact versions and hashes compiled into the app (`pins.json`), and the install is
  user-initiated and explained. Rejection is still a real possibility. The SIDELOAD build
  (SIDELOAD.md) exists for that case.

## Linux layer: iSH (GPL-3.0), measured on Linux only so far

- The emulator is iSH (ish-app/ish @ 8334836): GPL-3.0 with LICENSE.IOS, which waives
  the GPL-vs-App-Store conflict as long as the GPL is otherwise honoured. **TermForge is
  therefore distributed under GPL-3.0**, with its source public (this repository). The
  brief said "MIT"; Blink (ISC) was the alternative, but it maps guest `fork()` onto host
  `fork()`, which iOS forbids. The decision was taken on 2026-10-08.
- 32-bit x86 only: Alpine's `x86` repository. x86_64-only packages cannot run. No Docker,
  no kernel namespaces, no inbound sockets (iOS), so no sshd.
- Everything is interpreted. On a desktop x86_64 host: `git --version` 33 ms, `python3`
  start 480 ms, `git init && commit` 0.7 s, `apk add jq` 12 s. An A15 will be slower;
  no device numbers yet.
- Verified under iSH on Linux with the shipped root: bash, coreutils, git, ripgrep,
  python3 (ssl, sqlite3, subprocess), apk, gcc/build-base, ssh client. gcc needs `PATH`
  set (the app always sets one). Untested: nodejs, rust, go, java.
- Device nodes: fakefs stores a tar entry's `rdev` as the host `dev_t` and iSH uses it
  unchanged as the guest's. On Linux `makedev(1,3)` happens to equal the guest encoding;
  on Darwin it is `0x01000003`, so nodes imported on iOS point at missing majors
  (`/dev/null` → ENXIO, seen as `git` exit 128 in the simulator). The rootfs therefore
  ships no `/dev` entries and the shim unlinks any before iSH recreates them at boot.
- Unprivileged-user-namespace builds of the rootfs (dev only) leave `etc/shadow` owned
  by root:root; release images are built as real root in CI.
- The in-app shell runs as root inside the emulator, like iSH. The host mount at
  `/mnt/termforge` is the app's own Documents folder; nothing outside the sandbox is
  reachable.

## FastPath (WKWebView JIT host): constraints found while planning

- WKWebView JavaScript runs in a separate WebContent process. Swift cannot share
  memory with it, so the native side cannot use a SharedArrayBuffer + Atomics channel.
  Synchronous Node APIs (`fs.readFileSync` and the like) would each need a synchronous
  cross-process call.
- WKWebView exposes no API to persist JSC bytecode or take heap snapshots.
- These shape the FastPath design. They are not reasons to drop it.
