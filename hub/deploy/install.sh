#!/usr/bin/env bash
# Installs or upgrades Lantern Hub on a Linux server with systemd.
#   sudo bash install.sh /path/to/lantern-hub [release-publisher-user]
# With Tailscale installed and logged in, the hub is published to your tailnet
# over HTTPS (tailscale serve) and devices signed in to your Tailscale account
# can pair without a code. bubblewrap is installed for bot sandboxes.
set -euo pipefail

BIN=${1:?usage: sudo bash install.sh /path/to/lantern-hub [publisher-user]}
PUBLISHER=${2:-${SUDO_USER:-root}}
HERE=$(cd "$(dirname "$0")" && pwd)
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

install -m 0755 "$BIN" /usr/local/bin/lantern-hub
cat > /usr/local/bin/lantern-hubctl <<'EOF'
#!/bin/sh
# Admin commands (pair-code, devices, remove-device), run as the hub's user with its settings.
exec sudo -u lantern-hub sh -c 'set -a; . /etc/lantern-hub.env; set +a; exec /usr/local/bin/lantern-hub "$@"' lantern-hubctl "$@"
EOF
chmod 0755 /usr/local/bin/lantern-hubctl
install -m 0755 "$HERE/lantern-hub-fetch-release" /usr/local/bin/lantern-hub-fetch-release

# Sandboxes for bots and subagents. Ubuntu 23.10+ restricts the user namespaces
# bubblewrap needs, so it gets an AppArmor profile that allows them.
if ! command -v bwrap >/dev/null; then
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap >/dev/null
  elif command -v dnf >/dev/null; then
    dnf install -y -q bubblewrap
  fi
fi
if command -v bwrap >/dev/null && command -v apparmor_parser >/dev/null && [[ $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null) == 1 ]]; then
  install -m 0644 "$HERE/lantern-bwrap.apparmor" /etc/apparmor.d/lantern-bwrap
  apparmor_parser -r /etc/apparmor.d/lantern-bwrap
fi
command -v bwrap >/dev/null || echo "Note: bubblewrap isn't installed, so bots can't be sandboxed (install it and rerun)."

id -u lantern-agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash lantern-agent
id -u lantern-hub >/dev/null 2>&1 || useradd --system --home-dir /var/lib/lantern-hub --shell /usr/sbin/nologin lantern-hub
# The hub may open the tool runner's socket (group lantern-agent), not the other way round.
usermod -aG lantern-agent lantern-hub

install -d -o lantern-hub -g lantern-hub -m 0700 /var/lib/lantern-hub
install -d -o lantern-agent -g lantern-agent -m 0755 /home/lantern-agent/workspace
install -d -o "$PUBLISHER" -m 0755 /srv/lantern /srv/lantern/releases

if [[ ! -f /etc/lantern-hub.env ]]; then
  install -m 0640 -g lantern-hub "$HERE/lantern-hub.env.example" /etc/lantern-hub.env
  if command -v tailscale >/dev/null && tailscale status --json >/dev/null 2>&1; then
    json=$(tailscale status --json)
    dns=$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
    owner=$(printf '%s' "$json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["User"][str(d["Self"]["UserID"])]["LoginName"])')
    sed -i "s|^LANTERN_HUB_PUBLIC_URL=.*|LANTERN_HUB_PUBLIC_URL=https://$dns|; s|^LANTERN_HUB_TAILSCALE_OWNER=.*|LANTERN_HUB_TAILSCALE_OWNER=$owner|" /etc/lantern-hub.env
  fi
fi
# Requests from this machine's own Tailscale addresses (bot commands) never count as a paired device.
if command -v tailscale >/dev/null && tailscale ip >/dev/null 2>&1; then
  addrs=$(tailscale ip | paste -sd, -)
  if grep -q '^LANTERN_HUB_SELF_ADDRS=' /etc/lantern-hub.env; then
    sed -i "s|^LANTERN_HUB_SELF_ADDRS=.*|LANTERN_HUB_SELF_ADDRS=$addrs|" /etc/lantern-hub.env
  else
    echo "LANTERN_HUB_SELF_ADDRS=$addrs" >> /etc/lantern-hub.env
  fi
fi

install -m 0644 "$HERE/lantern-hub.service" "$HERE/lantern-agent.service" /etc/systemd/system/
# Optional: add official releases from GitHub daily (systemctl enable --now lantern-fetch-release.timer).
cat > /etc/systemd/system/lantern-fetch-release.service <<UNIT
[Unit]
Description=Add the latest Lantern release from GitHub to Lantern Hub
After=network-online.target

[Service]
Type=oneshot
User=$PUBLISHER
Environment=LANTERN_HUB_RELEASES=/srv/lantern/releases
ExecStart=/usr/local/bin/lantern-hub-fetch-release
UNIT
cat > /etc/systemd/system/lantern-fetch-release.timer <<'UNIT'
[Unit]
Description=Check GitHub for new Lantern releases daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable lantern-agent lantern-hub >/dev/null
systemctl restart lantern-agent lantern-hub

if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  tailscale serve --bg --https=443 unix:/run/lantern-hub/hub.sock >/dev/null
  echo "Lantern Hub: $(grep ^LANTERN_HUB_PUBLIC_URL= /etc/lantern-hub.env | cut -d= -f2-)"
else
  echo "Lantern Hub is running. Install Tailscale and rerun this script to reach it from your devices."
fi
