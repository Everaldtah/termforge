# TermForge PC bridge

Runs **Claude Code on your computer** and shows it in a TermForge tab on the phone. This is
how you use the current Claude Code (and every model your Claude subscription has) from
TermForge: the phone is the terminal, the PC does the work with its own login.

Why: nodejs-mobile can only run Claude Code 2.1.112, and the API serves the newest models
only to newer clients. Those are native binaries for a 64-bit PC — see
`docs/LIMITATIONS.md`.

## On the PC (Windows, macOS, Linux; Node 20+)

```sh
cd tools/pc-bridge
npm install          # node-pty (a real PTY — ConPTY on Windows) and ws
node bridge.mjs      # or: npm start, or start-bridge.cmd on Windows
```

It prints the address it listens on and a pairing link. With Tailscale installed it uses
your machine's Tailscale name, so the phone reaches it from anywhere; without it, the LAN
hostname (pass `--url ws://192.168.1.20:7788` if that name does not resolve from the phone).

Pair the phone either way:

- open the `termforge://pair?...` link on the phone (AirDrop or message it to yourself) —
  TermForge saves the address and token; or
- TermForge → Settings → **PC bridge** → paste the address and the token
  (`--show-token` prints it; it lives in `~/.termforge-bridge/config.json`).

Then `+` → **Claude Code on PC**. `--new-token` unpairs every phone.

## Options

| flag | meaning |
|---|---|
| `--port 7788`, `--host 0.0.0.0` | where to listen |
| `--url ws://…` | the address printed in the pairing link |
| `--claude <path>` | Claude Code binary (auto-detected: `~/.local/bin/claude[.exe]`, then PATH) |
| `--shell <path>` | program for "PC shell" tabs (PowerShell on Windows, `$SHELL` elsewhere) |
| `--projects <dir>` | folder whose subfolders the phone can pick as the working directory (`~/Projects`) |
| `--new-token`, `--show-token` | rotate / print the pairing token |

## Security

- Every request needs the pairing token (`Authorization: Bearer`, or `?token=`).
- The WebSocket is plain `ws://`: over Tailscale that is already encrypted end to end; on
  an untrusted LAN put it behind `tailscale serve` or any TLS reverse proxy and pass the
  `wss://` address with `--url`.
- A paired phone can run anything your user can. Keep the token private; rotate it with
  `--new-token`.

## Protocol

`GET /info` → `{ name, platform, claude, home, projects[] }`.
`WS /pty?cmd=claude|shell&cwd=<dir>&cols=&rows=&continue=1`: binary frames carry terminal
bytes both ways; text frames are JSON — client `{"t":"resize","cols":80,"rows":24}`,
server `{"t":"hello",...}` first and `{"t":"exit","code":0}` last. `npm test` runs it
end to end against a shell.
