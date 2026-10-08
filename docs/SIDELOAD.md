# Sideload build

TermForge builds two ways, chosen with the Xcode scheme:

| | `TermForge` (App Store) | `TermForge-Sideload` |
|---|---|---|
| Configurations | Debug / Release | Debug-Sideload / Release-Sideload |
| Swift condition | none | `SIDELOAD` |
| Claude Code versions | only the pins compiled into the app (`nodejs-project/pins.json`) | also any version + tarball + SHA-512 you enter in Settings, persisted in `pin-overrides.json` |
| fork/exec, JIT, private APIs | none | none |

What is gated: only features that App Review is likely to reject. These are compiled out
of the App Store build (`#if SIDELOAD` in Swift, plus `--allow-pin-override` passed to
Node), not hidden behind a remote switch. Neither build uses JIT entitlements or
`posix_spawn`, because iOS blocks both for sideloaded apps too.

## Installing a sideload build

You need a Mac, or a CI-built IPA, plus one of these:

- **Xcode with your Apple ID**: open the project (`scripts/bootstrap.sh`), select
  `TermForge-Sideload`, choose your device and run. A paid developer account gives
  one-year profiles; a free one gives seven-day profiles.
- **Ad hoc IPA from CI**: register the device UDID in the developer account, then archive
  `TermForge-Sideload` with an ad hoc export. The workflow for this does not exist yet;
  the TestFlight workflow pattern from the ZU iOS repo can be reused for it.
- **AltStore / SideStore**: re-sign an IPA with your Apple ID on the device.
- **EU alternative marketplaces**: these need notarization, so App Store review rules
  largely still apply.
