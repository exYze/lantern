# Lantern Hub

Lantern Hub is a small server you run yourself. Every Lantern app connected to it shares **one
environment**:

- **Synced data**: bots, chats, memories, skills, routines, plugins (MCP servers), model servers, settings
  and secrets. Each app keeps working offline from its own copy and catches up when it reconnects.
- **Shared workspace**: bots' file and terminal tools run on the hub, so a file created from your laptop
  is there when you ask from your phone, and phones get a terminal too.
- **Bots that keep working**: the hub's runner does the work of every chat, so you can start something on
  your phone, lock it, and find the answer later. Routines run on time with every app closed
  (see [The runner](#the-runner)).
- **A browser for each bot**, for sites that need clicking or signing in; you can watch it and take over
  (see [Browser](#browser)).
- **Webhooks and email start routines**: GitHub, Home Assistant, a script, or new mail in a bot's own
  inbox (see [Webhooks](#webhooks) and [Email](#email)).
- **Telegram and phone notifications**: talk to your bots from Telegram, and get pushes through ntfy when
  one needs you (see [Telegram and phone notifications](#telegram-and-phone-notifications)).
- **Sandboxes**: a bot can keep its files and commands in its own sandbox on the hub, and subagents can
  work in sandboxes of their own (see [Sandboxes and subagents](#sandboxes-and-subagents)).
- **Downloads and updates**: the hub serves a downloads page with every installer, and the apps update
  themselves from it.

It is a static binary (`lantern-hub`) with a SQLite database, plus the runner, which needs Node.js (the
installer gets it). A 2 vCPU, 2 GB Linux VM is enough; give it 4 GB, or swap, if bots use the browser.

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
   sudo LANTERN_BROWSER=1 bash install.sh ./lantern-hub
   ```

   `LANTERN_BROWSER=1` also installs a headless browser for bots (about 200 MB); leave it out if you
   don't want one.

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
| `/usr/local/bin/lantern-hubctl` | admin commands: `pair-code`, `devices`, `remove-device`, `runner-token` |
| `/usr/local/bin/lantern-hub-fetch-release` | adds an official release from GitHub to the hub |
| `lantern-hub.service` | the API, sync and downloads, as the `lantern-hub` user |
| `lantern-agent.service` | bots' files, commands, browser and mail, as the unprivileged `lantern-agent` user |
| `lantern-runner.service` | the runner, which runs bots (`/usr/local/lib/lantern/lantern-runner.mjs`) |
| `/opt/lantern/node/` | Node.js for the runner, from nodejs.org, checked against its published SHA-256 |
| `/opt/lantern/browsers/` | the bots' headless browser (`LANTERN_BROWSER=1`), from Playwright |
| `lantern-fetch-release.timer` | optional daily `lantern-hub-fetch-release` (off until you enable it) |
| `/etc/lantern-hub.env` | settings (see `hub/deploy/lantern-hub.env.example`) |
| `/var/lib/lantern-hub/` | the database, and the runner's copy of your data in `runner/` (mode 0700) |
| `/home/lantern-agent/workspace/` | the shared workspace |
| `/srv/lantern/releases/` | app versions the hub serves, one folder each |
| bubblewrap, `/etc/apparmor.d/lantern-bwrap` | sandboxes (see below) |
| `/etc/apparmor.d/lantern-browser` | lets the browser keep Chrome's own sandbox on Ubuntu |

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

## The runner

The runner is the hub's own Lantern device. It syncs the shared environment like any app, and while it's
online, **the apps hand it their chats**: you send a message, the runner does the work with the bot's tools
and model, and every device watching that chat sees the reply as it's written. You can close Lantern or
lock your phone in the middle; the answer is there when you come back.

- **Approvals** show on every device; answer on whichever is in front of you. With
  [Telegram](#telegram-and-phone-notifications), you can answer there too.
- **Stop** works from any device.
- **Routines** run on the runner, on time, with every app closed. Without it, they run while Lantern is
  open on one of your devices (whichever claims the run first).
- **Where bots work** (**Settings → Hub**) can keep bots on the device you chat from instead. A bot whose
  files and terminal are on your device, or that uses a local (stdio) plugin, always runs there.
- The runner needs the bots' model servers to be reachable from the hub (for example over Tailscale or your
  LAN). A model on `localhost` of your laptop isn't.
- **Time zone.** Routine times are in your time zone (**Settings → General**); apps fill it in the first
  time they see the runner.

It runs as the `lantern-hub` user (it needs your API keys and secrets, as the hub does) and reaches the hub
over its Unix socket. Its device token is in `/var/lib/lantern-hub/runner/token`; `lantern-hubctl
runner-token` makes a new one (copy it there and restart `lantern-runner`). Logs:
`journalctl -u lantern-runner`.

## Bots working together

With **Other bots** on in a bot's **Tools** tab (on by default), a bot sees your other bots and can:

- **ask one** with `ask_bot` and wait for the answer, which comes back into its chat, or
- **hand one a whole task** (`wait: false`) and get the result posted in its chat when it's done.

The bot that's asked works in a chat of its own (it shows in the sidebar, marked as started by the other
bot), with its own tools, memories and approvals. Requests can't go in circles or more than three bots deep.

Make one bot your **primary bot** (its **Profile** tab). It coordinates the others, can look over every
bot's recent chats, and with **Daily check-in** it looks over recent work each morning and offers to take
things off your plate. When there's nothing worth raising it answers "Nothing new" and doesn't notify you.

## Browser

With `LANTERN_BROWSER=1`, each bot gets its own headless browser on the hub (the **Browser** tool, on by
default). It opens pages, clicks, types and fills forms, for sites that need signing in or JavaScript.

- **Watch and take over** in the bot's **Browser** tab: it shows the page live; click the picture to click,
  type into the box to type, or go to an address. Sign in to a site there once and the bot stays signed in
  (each bot has its own profile; a sandboxed bot keeps it in its own folder).
- **Secrets without the model seeing them:** a bot types `{{SECRET_NAME}}` and the browser fills in the
  value of that secret.
- Clicks and typing count as changes, so they go through your approval settings; opening and reading pages
  don't.
- The browser keeps Chrome's own sandbox and runs as `lantern-agent`. It's driven over a pipe, never a
  debugging port, so nothing else on the server can control it. Downloads go to `downloads/` in the
  workspace (or the bot's sandbox folder). A browser nobody has used for 15 minutes is closed; at most
  three are open at once.

To add the browser later, rerun `sudo LANTERN_BROWSER=1 bash install.sh ./lantern-hub`. To use a Chrome or
Chromium you installed yourself, set `LANTERN_HUB_BROWSER=/path/to/chrome` in `/etc/lantern-agent.env`.

## Webhooks

A routine can start **when a webhook is called** instead of on a schedule. Its editor shows the address,
`<hub>/hooks/<routine id>/<key>`; each POST starts a run, and the bot gets the request's body (and a
one-line summary for GitHub, GitLab, Linear, Sentry and PagerDuty events).

- The address is the secret: anyone who has it can start the routine. Add a **signing secret** to require
  signed calls (GitHub, Gitea, Linear and Sentry signatures, or GitLab's token). A webhook takes at most 30
  calls a minute.
- The hub takes webhooks on its tailnet address and on the plain-HTTP downloads listener
  (`LANTERN_HUB_PUBLIC_LISTEN`), so services on your LAN, like Home Assistant, can call it. List the
  addresses the app should show in `LANTERN_HUB_HOOK_URLS`.
- **From the internet** (GitHub, Sentry), publish only the webhook path with
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). Allow Funnel for the hub in your tailnet
  policy, then on the hub:

  ```bash
  sudo tailscale funnel --bg --https=8443 --set-path=/hooks http://127.0.0.1:80/hooks
  ```

  and add `https://<hub name>.<tailnet>.ts.net:8443` to `LANTERN_HUB_HOOK_URLS`. Only `/hooks` is public
  on that port; the API stays on your tailnet. Use a signing secret for anything reachable from the
  internet.

## Email

Give a bot an inbox of its own in its **Email** tab: an address, its IMAP and SMTP servers (presets for
Gmail, Fastmail, Outlook.com and iCloud) and a password (an app password, for providers that have them).
The hub reads and sends mail for it; the password is stored like your other secrets.

- Tools: `email_list`, `email_read` and `email_send`. Sending goes through your approval settings, and the
  approval tag shows the draft.
- A routine can start **when an email arrives**: the runner checks every two minutes, and each new message
  starts a run with the message in it. Mail that was there before doesn't count.
- Connections always use TLS with verified certificates. Only a mail server on the hub itself (a local
  bridge) may be reached without it.

## Telegram and phone notifications

Both run on the runner, so they work with every app closed. Set them up in **Settings → Phone & Telegram**.

**Telegram.** Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), paste its token, switch
Telegram on, and send the one-time link command the app shows to your new bot. Only linked chats can talk
to your bots. In Telegram, send text, photos or voice notes (transcribed with your speech-to-text server);
`/bots`, `/use <name>`, `/new` and `/stop` switch bots and chats. Approvals arrive with **Allow once**,
**Always allow** and **Deny** buttons. The runner polls Telegram, so the hub needs no public address.

**Phone notifications.** Lantern can't wake a closed app on your phone, so the runner sends pushes through
[ntfy](https://ntfy.sh) (open source; use ntfy.sh or your own server). Install the ntfy app and subscribe to
the topic the app gives you. You get a push when a bot needs approval, when a routine finishes, and when a
reply takes more than a minute. Treat the topic like a password, or use your own server with an access
token, and turn on **Hide what bots say** to keep replies off the notification service.

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
web fetch run wherever the bot runs (the runner or your device), not in the sandbox.

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
- **The runner** runs as the `lantern-hub` user, like the hub: it holds the same data and secrets, and
  bots' tools never run inside it (they go to `lantern-agent`).
- **Webhooks** are the only thing besides downloads that the plain-HTTP listener serves. They need the
  routine's key (and its signature, when a signing secret is set) and can only start that routine.

## Releases and auto-updates

Desktop apps check `<hub>/updates/latest.json` at startup and every six hours (apps built with a hub
address check it even before they're paired). Updates are signed: the app only installs an installer whose
signature matches the public key built into it (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`),
and whose signed version matches the manifest, so nobody can pass off an older release as a new one. By
default they install at startup or while the app is in the background, never in the middle of a bot's work
(**Settings → About**). iOS apps can't be updated outside the App Store.

**Android** checks at startup and every six hours too. Lantern downloads the new APK itself, checks it
against the SHA-256 in the hub's manifest, and hands it to Android's installer; Android only accepts it if
it's signed with the same key as the installed app.

- The first time, tap **Install** on the banner. Android asks you to let Lantern install apps, then to
  confirm the update.
- After that, Lantern is the app's installer of record, and on Android 12 and later updates install
  without a prompt: Lantern downloads the update in the background and installs it the next time you
  switch away from it (unless a bot is working). Turn this off in **Settings → About**.
- Android closes Lantern to update it; open it again to use the new version.

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
| "Runner offline" in Settings → Hub | `systemctl status lantern-runner`. It needs `/var/lib/lantern-hub/runner/token` (rerun `install.sh`). |
| A bot on the hub can't reach its model | The model server must be reachable from the hub, not just your laptop: use its Tailscale or LAN address. |
| No Browser tool | Rerun `install.sh` with `LANTERN_BROWSER=1`. Check `/etc/lantern-agent.env` points at the browser. |
| Telegram doesn't answer | The chat must be linked (Settings → Phone & Telegram). `journalctl -u lantern-runner` shows Telegram errors. |
| Logs | `journalctl -u lantern-hub -u lantern-agent -u lantern-runner` |
