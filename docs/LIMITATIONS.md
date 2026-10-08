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

## No JIT (by design)

- V8 runs with `--jitless`, which App Store rules require. Everything is interpreted.
- jitless V8 has **no WebAssembly** (`--expose_wasm` is disabled). Claude Code 2.1.112
  reaches its first screen without it (measured). Any npm tool that needs wasm will not
  run in a Node tab.
- Startup cost: see PERFORMANCE.md. No device number exists yet.

## Phase 1 scope (measured)

- Claude Code starts, renders, takes keystrokes and can sign in or use an API key.
  Every command it spawns fails with ENOENT because no execution tier exists yet. A
  probe run spawned `which npm/bun/yarn/deno/pnpm/node` and `rg --files` (see the
  vendoring report). The Bash, Grep, Glob and git-dependent features therefore do not
  work until phase 3. Reading, writing and editing files work, because they go through
  Node's `fs` in the shared home.
- `child_process.fork()` fails with ENOSYS.
- Native addons (`.node`) cannot load: iOS refuses unsigned dylibs.

## Sign-in (unverified on a device)

- Claude-account sign-in relies on Claude Code's `localhost` callback being reachable
  from `ASWebAuthenticationSession` while TermForge stays in the foreground. This has
  only been checked on a desktop, where the authorize URL is captured and handed off.
  The paste-the-code flow that Claude Code prints is the fallback, and it needs no
  redirect.

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

## Linux layer (phase 2): licensing decision pending

- The brief describes the emulator as "iSH-style … MIT". iSH is **GPL-3.0** with extra
  iOS terms (LICENSE.md, LICENSE.IOS), and newer contributions are also GPL-2.0.
  Embedding iSH makes TermForge a GPL-3.0 app.
- Blink (jart/blink, ISC) is permissive and emulates x86-64, but it maps guest
  `fork()` onto host `fork()`, which iOS forbids. Using it means reworking its process
  model so that guests run as threads.
- Neither emulator can run Docker. iSH emulates 32-bit x86, so x86_64-only packages
  will not run on it.

## FastPath (WKWebView JIT host): constraints found while planning

- WKWebView JavaScript runs in a separate WebContent process. Swift cannot share
  memory with it, so the native side cannot use a SharedArrayBuffer + Atomics channel.
  Synchronous Node APIs (`fs.readFileSync` and the like) would each need a synchronous
  cross-process call.
- WKWebView exposes no API to persist JSC bytecode or take heap snapshots.
- These shape the FastPath design. They are not reasons to drop it.
