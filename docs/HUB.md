# Lantern Hub

Lantern Hub is a small server you run yourself. Every Lantern app connected to it shares **one
environment**:

- **Synced data**: bots, chats, memories, skills, routines, plugins (MCP servers), model servers, settings
  and secrets. Each app keeps working offline from its own copy and catches up when it reconnects.
- **Shared workspace**: bots' file and terminal tools run on the hub, so a file created from your laptop
  is there when you ask from your phone, and phones get a terminal too.
- **Sandboxes**: a bot can keep its files and commands in its own sandbox on the hub, and subagents can
  work in sandboxes of their own (see [Sandboxes and subagents](#sandboxes-and-subagents)).
- **Routines run once**: devices agree through the hub, so a routine fires on one device, not all of them.
- **Downloads and updates**: the hub serves a downloads page with every installer, and the desktop apps
  update themselves from it.

It is a single static binary (`lantern-hub`) with a SQLite database. A 1-2 vCPU, 1-2 GB Linux VM is plenty.

## Quick start

You need a Linux machine or VM (Ubuntu 24.04 or Debian 12/13) and a free
[Tailscale](https://tailscale.com) account. Tailscale gives every device an encrypted connection to the hub
and the hub a real HTTPS certificate, and it tells the hub which devices are yours.

1. **Tailscale.** In the [admin console](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and
   **HTTPS certificates**. On the server, install Tailscale and log in:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --hostname=lantern
   ```

2. **The hub.** Download `lantern-hub_<version>_linux-x86_64.tar.gz` (or `-aarch64` for ARM) from the
   [latest release](https://github.com/exYze/lantern/releases/latest) and install it:

   ```bash
   tar -xzf lantern-hub_*_linux-x86_64.tar.gz
   cd lantern-hub-*/
   sudo bash install.sh ./lantern-hub
   ```

   It prints the hub's address, e.g. `https://lantern.your-tailnet.ts.net`. Open it in a browser on any of
   your Tailscale devices to see the downloads page.

3. **Releases for your devices.** Add the official installers to your hub, and let it fetch new ones daily:

   ```bash
   lantern-hub-fetch-release
   sudo systemctl enable --now lantern-fetch-release.timer
   ```

4. **Apps.** On each device, install Tailscale and sign in, then install Lantern from the hub's downloads
   page (or the GitHub release), choose **Connect to a Lantern Hub** and enter the hub's address. Your own
   devices connect with one tap.

The desktop apps then update themselves whenever a new release reaches your hub.

### Example: a VM on Proxmox

On the Proxmox host (adjust the VM id `9001`, the storage `local-lvm` and the bridge `vmbr0`):

```bash
wget -P /var/lib/vz/template/iso https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
qm create 9001 --name lantern --memory 2048 --cores 2 --cpu host --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-pci --ostype l26 --agent enabled=1 --serial0 socket --vga serial0 --onboot 1
qm set 9001 --scsi0 local-lvm:0,import-from=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img
qm resize 9001 scsi0 32G
qm set 9001 --ide2 local-lvm:cloudinit --boot order=scsi0 --ipconfig0 ip=dhcp \
  --ciuser lantern --sshkeys ~/.ssh/id_ed25519.pub
qm start 9001
```

Then SSH in as `lantern` (the VM's address is in the Proxmox UI once the guest agent is running, or in
your router's DHCP list), run `sudo apt-get install -y qemu-guest-agent`, and continue with step 1 above.

## What the installer sets up

`install.sh` installs or upgrades the hub; run it again with a new `lantern-hub` binary to upgrade.

| | |
|---|---|
| `/usr/local/bin/lantern-hub` | the hub (`serve`) and its tool runner (`agent`) |
| `/usr/local/bin/lantern-hubctl` | admin commands: `pair-code`, `devices`, `remove-device` |
| `/usr/local/bin/lantern-hub-fetch-release` | adds an official release from GitHub to the hub |
| `lantern-hub.service` | the API, sync and downloads, as the `lantern-hub` user |
| `lantern-agent.service` | bots' files and commands, as the unprivileged `lantern-agent` user |
| `lantern-fetch-release.timer` | optional daily `lantern-hub-fetch-release` (off until you enable it) |
| `/etc/lantern-hub.env` | settings (see `hub/deploy/lantern-hub.env.example`) |
| `/var/lib/lantern-hub/` | the database (mode 0700) |
| `/home/lantern-agent/workspace/` | the shared workspace |
| `/srv/lantern/releases/` | app versions the hub serves, one folder each |
| bubblewrap, `/etc/apparmor.d/lantern-bwrap` | sandboxes (see below) |

and publishes the API to your tailnet with `tailscale serve --https=443 unix:/run/lantern-hub/hub.sock`.

To build the hub yourself instead: `cd hub && cargo build --release` on Linux, or
`cargo zigbuild --release --target x86_64-unknown-linux-musl` from any OS (with `cargo-zigbuild`).

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

## Without Tailscale

You can put the hub behind any HTTPS reverse proxy instead. Then nothing vouches for who a request is
from, so **every device pairs with a code** and one-tap pairing must stay off. In `/etc/lantern-hub.env`:

```bash
LANTERN_HUB_LISTEN=127.0.0.1:8780
LANTERN_HUB_PUBLIC_URL=https://lantern.example.com
# Must stay empty without Tailscale: anyone could send the header it trusts.
LANTERN_HUB_TAILSCALE_OWNER=
```

With [Caddy](https://caddyserver.com), which gets the certificate for you, the whole `Caddyfile` is:

```
lantern.example.com {
	reverse_proxy 127.0.0.1:8780
}
```

Restart the hub (`sudo systemctl restart lantern-hub`), run `lantern-hubctl pair-code` and connect your
first device with that code; after that, **Settings → Hub → Add a device** makes codes for the others.
Prefer a private network (your LAN or a VPN) over the open internet: device keys and pairing codes protect
the API, but there's no reason to expose it.

## How sync works

- Every app writes to its own local database and queues the change in a persistent outbox; the outbox is
  pushed to the hub within a second, or when the hub is reachable again.
- The hub gives each change a revision number and tells connected apps over a live event stream; they pull
  what's new. If two devices edit the same item, the last write wins.
- The first time a device connects, its data and the hub's are merged: it downloads everything, then
  uploads whatever the hub doesn't have yet.
- Device-specific settings (workspace folder, auto-update) and the hub key itself never sync.
- Secrets sync so every device can use your API keys; on the hub they are only reachable by paired devices.

## Sandboxes and subagents

**Sandboxed bots.** Turn on **Sandbox** in a bot's **Model** tab (it appears when the bot's files and
terminal are on the hub). The bot then works in its own folder, `bots/<bot id>` in the hub's workspace:

- Its file tools can't reach anything outside that folder (symlinks included).
- Its commands run in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox: the system is
  read-only, other bots' files, home folders and the hub's sockets are hidden, `/tmp` is private, and only
  its folder can be written. Processes can't see the rest of the server.
- **Internet access in the sandbox** can be turned off, which gives its commands no network at all.
- If the hub can't create sandboxes, the bot gets no terminal (its file tools still work in its folder);
  if this device isn't connected to the hub, it gets neither. Nothing falls back to running unsandboxed.

**Subagents.** With the **Subagents** tool on (it is by default), a bot can hand a self-contained task to a
subagent with `delegate_task`. A subagent works on its own with the bot's tools and model and reports back;
several asked for at once run in parallel (up to three). The chat shows each subagent's steps, and its
actions need your approval like the bot's own. Subagents can't save memories, create skills or routines, or
start more subagents.

An **isolated** subagent (the bot decides, e.g. for untrusted code or downloads) gets a new empty folder,
`subagents/<task>` inside the bot's workspace, and no secrets or plugins. On the hub its commands run in a
sandbox of its own; on a device, where there's no sandbox, it gets file tools in its folder but no terminal.
The bot can read what it left behind.

**Setup.** `install.sh` installs bubblewrap. Ubuntu 23.10 and later block the user namespaces it needs, so
the installer also adds an AppArmor profile (`/etc/apparmor.d/lantern-bwrap`) that allows them for
`/usr/bin/bwrap`. **Settings → Hub** shows whether sandboxes are available.

**Limits.** All bot commands share the limits of `lantern-agent.service` (75% of memory, 512 processes,
a low CPU weight), so a runaway command can't starve the hub. Sandboxes keep a bot away from other files on
the hub; they don't stop bots that aren't sandboxed from looking into a sandbox's folder. Web search and
web fetch run on the device, not in the sandbox.

## Security model

- **Only `tailscale serve` can reach the API.** It listens on a Unix socket that only the `lantern-hub`
  user (and root, i.e. `tailscaled`) can open. On the network, the hub serves only the downloads page and
  installer files (`LANTERN_HUB_PUBLIC_LISTEN`), never data.
- **Bots can't reach the hub's data.** Their tools run in a separate `lantern-agent` process and Unix
  user, which can't read the database or open the API socket. Requests that come from the hub's own
  Tailscale address (a bot's command calling back in) are never treated as your device.
- **Sandboxed commands** also can't see the tool runner's socket, so they can't ask it to run anything
  outside their sandbox.
- Device keys are stored as SHA-256 hashes. Pairing codes are single-use and rate-limited.
- Approvals still apply: a bot's terminal command on the hub needs the same approval as on your computer.

## Releases and auto-updates

Desktop apps check `<hub>/updates/latest.json` at startup and every six hours (apps built with a hub
address check it even before they're paired). Updates are signed: the app only installs an installer whose
signature matches the public key built into it (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`),
and whose signed version matches the manifest, so nobody can pass off an older release as a new one. By
default they install at startup or while the app is in the background, never in the middle of a bot's work
(**Settings → About**). Android shows a **Download** banner for a new APK. iOS apps can't be updated
outside the App Store.

### Official releases

[GitHub releases](https://github.com/exYze/lantern/releases) are signed with the project's key and include
a `release.json`, the manifest a hub serves. `lantern-hub-fetch-release [tag]` downloads one into
`/srv/lantern/releases/<version>/` (checking every file against it), and the apps connected to your hub
update to it. The daily timer does this for each new release.

### Your own builds

Apps you build yourself only accept updates signed with the key built into them, so set up your own keys
first and keep them out of the repository:

1. **Update key:** `npx tauri signer generate -w ~/.lantern/updater.key`, then put the contents of
   `~/.lantern/updater.key.pub` in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
2. **Android key:** create a keystore (`keytool -genkeypair -v -keystore ~/.lantern/android-release.jks
   -alias lantern -keyalg RSA -keysize 4096 -validity 10000`) and write
   `~/.lantern/android-signing.properties` with `storeFile`, `password` and `keyAlias`. Android only
   installs updates signed with the same key.
3. **Back both up.** Without them, installed apps can't be updated.

`scripts/release.mjs` builds, signs and publishes. It reads `.env.local` (never committed):

```bash
VITE_LANTERN_HUB_URL=https://lantern.your-tailnet.ts.net   # baked into the apps built here
LANTERN_PUBLISH_SSH=you@your-hub
LANTERN_PUBLISH_DIR=/srv/lantern/releases
```

To publish a new version:

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Push to `main` and let CI build everything.
3. On your build machine:

   ```bash
   node scripts/release.mjs build windows,android   # or linux,android on Linux; linux needs Docker
   node scripts/release.mjs fetch-ci                # macOS and iOS from the latest green CI run (gh)
   node scripts/release.mjs publish --notes "What's new"
   node scripts/release.mjs github --notes "What's new"   # optional: a public GitHub release
   ```

`publish` signs every desktop installer with its version bound into the signature and uploads the release
to your hub. `github` publishes CI's builds (which have no hub address in them) as a GitHub release: it
signs them and the Android APK on your machine (with the Android SDK build-tools and a JDK in `JAVA_HOME`),
adds `release.json`, the hub archives and `SHA256SUMS`, and
uploads them with `gh`. The signing keys never go to CI.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Can't reach the hub" | Tailscale must be on and signed in on the device. Check `https://<hub>/healthz`. |
| "Enter a pairing code" on your own device | The device is signed in to a different Tailscale account, or `LANTERN_HUB_TAILSCALE_OWNER` is empty. |
| Bots' files missing on a device | The bot runs tools "on each device": Settings → Hub, or the bot's Model tab. |
| "Sandboxes: not set up" | Rerun `install.sh`, or `sudo apt-get install bubblewrap` and add the AppArmor profile from `hub/deploy/`. Test with `sudo -u lantern-agent bwrap --ro-bind / / --unshare-all true`. |
| A sandboxed bot has no terminal | The hub can't create sandboxes yet (see above), or this device isn't connected to the hub. |
| Logs | `journalctl -u lantern-hub -u lantern-agent` |
