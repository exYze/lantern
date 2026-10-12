# Lantern Hub

Lantern Hub is a small server you run yourself. Every Lantern app connected to it shares **one
environment**:

- **Synced data**: bots, chats, memories, skills, routines, plugins (MCP servers), model servers, settings
  and secrets. Each app keeps working offline from its own copy and catches up when it reconnects.
- **Shared workspace**: bots' file and terminal tools run on the hub, so a file created from your laptop
  is there when you ask from your phone, and phones get a terminal too.
- **Routines run once**: devices agree through the hub, so a routine fires on one device, not all of them.
- **Downloads and updates**: the hub serves a downloads page with every installer, and the desktop apps
  update themselves from it.

It is a single static binary (`lantern-hub`) with a SQLite database. A 1-2 vCPU, 1-2 GB Linux VM is plenty.

## Setup

The recommended setup puts the hub on a Linux VM and reaches it over [Tailscale](https://tailscale.com),
which gives every device an encrypted connection and the hub a real HTTPS certificate.

1. Create a Linux VM (Ubuntu 24.04 or Debian 12/13), install Tailscale and log in:
   `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --hostname=lantern`.
   In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** (DNS page).
2. Get `lantern-hub` for your CPU from the CI artifacts (`lantern-hub-linux`), or build it:
   `cd hub && cargo build --release` (on Linux) or `cargo zigbuild --release --target x86_64-unknown-linux-musl`
   (from any OS, with `cargo-zigbuild`).
3. Copy the binary and `hub/deploy/*` to the VM and run the installer:

   ```bash
   sudo ./install.sh ./lantern-hub
   ```

   It prints the hub's address, e.g. `https://lantern.your-tailnet.ts.net`.

The installer:

| | |
|---|---|
| `/usr/local/bin/lantern-hub` | the hub (`serve`) and its tool runner (`agent`) |
| `/usr/local/bin/lantern-hubctl` | admin commands: `pair-code`, `devices`, `remove-device` |
| `lantern-hub.service` | the API, sync and downloads, as the `lantern-hub` user |
| `lantern-agent.service` | bots' files and commands, as the unprivileged `lantern-agent` user |
| `/etc/lantern-hub.env` | settings (see `hub/deploy/lantern-hub.env.example`) |
| `/var/lib/lantern-hub/` | the database (mode 0700) |
| `/home/lantern-agent/workspace/` | the shared workspace |
| `/srv/lantern/releases/` | published app versions |

and publishes the API to your tailnet with `tailscale serve --https=443 unix:/run/lantern-hub/hub.sock`.

## Connecting devices

Install Lantern on the device and choose **Connect to a Lantern Hub** (or **Settings → Hub**), then enter
the hub's address.

- **Your own Tailscale devices connect with one tap.** The hub trusts the identity `tailscale serve`
  attaches to each request and accepts devices signed in to the same Tailscale account as the hub
  (`LANTERN_HUB_TAILSCALE_OWNER`).
- **Anything else needs a one-time pairing code** (valid 15 minutes from the app, 60 from the CLI): use
  **Settings → Hub → Add a device** on a connected device, or run `lantern-hubctl pair-code` on the hub.

Each device gets its own key, stored in the device's secret store. Remove a device from **Settings → Hub**
(or `lantern-hubctl remove-device`) and it stops syncing immediately; its local copy stays on it.

Builds made with a `.env.local` that sets `VITE_LANTERN_HUB_URL` have your hub's address filled in.

## How sync works

- Every app writes to its own local database and queues the change in a persistent outbox; the outbox is
  pushed to the hub within a second, or when the hub is reachable again.
- The hub gives each change a revision number and tells connected apps over a live event stream; they pull
  what's new. If two devices edit the same item, the last write wins.
- The first time a device connects, its data and the hub's are merged: it downloads everything, then
  uploads whatever the hub doesn't have yet.
- Device-specific settings (workspace folder, auto-update) and the hub key itself never sync.
- Secrets sync so every device can use your API keys; on the hub they are only reachable by paired devices.

## Security model

- **Only `tailscale serve` can reach the API.** It listens on a Unix socket that only the `lantern-hub`
  user (and root, i.e. `tailscaled`) can open. On the network, the hub serves only the downloads page and
  installer files (`LANTERN_HUB_PUBLIC_LISTEN`), never data.
- **Bots can't reach the hub's data.** Their tools run in a separate `lantern-agent` process and Unix
  user, which can't read the database or open the API socket. Requests that come from the hub's own
  Tailscale address (a bot's command calling back in) are never treated as your device.
- Device keys are stored as SHA-256 hashes. Pairing codes are single-use and rate-limited.
- Approvals still apply: a bot's terminal command on the hub needs the same approval as on your computer.

## Releases and auto-updates

Desktop apps check `<hub>/updates/latest.json` at startup and every six hours (apps built with a hub
address check it even before they're paired). Updates are signed: the
app only installs an installer whose signature matches the public key built into it
(`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`). By default they install at startup or while the
app is in the background, never in the middle of a bot's work (**Settings → About**). Android shows a
**Download** banner for a new APK. iOS apps can't be updated outside the App Store.

To publish a new version:

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Push to `main` and let CI build macOS and iOS.
3. On your build machine:

   ```bash
   node scripts/release.mjs build windows,android   # or linux,android on Linux; linux needs Docker
   node scripts/release.mjs fetch-ci                # macOS and iOS from the latest green CI run (gh)
   node scripts/release.mjs publish --notes "What's new"
   ```

`release.mjs` reads `.env.local` (never committed):

```bash
VITE_LANTERN_HUB_URL=https://lantern.your-tailnet.ts.net
LANTERN_PUBLISH_SSH=you@your-hub
LANTERN_PUBLISH_DIR=/srv/lantern/releases
```

and keeps its keys outside the repository:

- `~/.lantern/updater.key`, the update signing key (`npx tauri signer generate -w ~/.lantern/updater.key`;
  put the `.pub` contents in `tauri.conf.json`). **Back it up**: without it, installed apps can't be updated.
- `~/.lantern/android-signing.properties`, which points at your Android release keystore (`storeFile`,
  `password`, `keyAlias`). Android only installs updates signed with the same key.

`publish` signs every desktop installer with its version bound into the signature, and the apps
(`requireSignedVersion`) reject an update whose signed version doesn't match the manifest, so nobody can
pass off an older release as a new one. The signing key never goes to CI: the macOS archive built there is
signed by `publish` too.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Can't reach the hub" | Tailscale must be on and signed in on the device. Check `https://<hub>/healthz`. |
| "Enter a pairing code" on your own device | The device is signed in to a different Tailscale account, or `LANTERN_HUB_TAILSCALE_OWNER` is empty. |
| Bots' files missing on a device | The bot runs tools "on each device": Settings → Hub, or the bot's Model tab. |
| Logs | `journalctl -u lantern-hub -u lantern-agent` |
