#!/usr/bin/env bash
# Installs the Agentic Driver relay server as a per-user background service.
#
# Linux: systemd user unit (~/.config/systemd/user/agentic-driver-relay.service)
#   - Enabled with `--now` so it starts immediately and on every login.
#   - `loginctl enable-linger` is used so it also starts at boot, before login.
# macOS: launchd LaunchAgent (~/Library/LaunchAgents/com.agenticdriver.relay.plist)
#   - RunAtLoad + KeepAlive so it starts at login and restarts if it dies.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
SERVER_ENTRY="$REPO_ROOT/server/dist/server.js"

if [[ ! -f "$SERVER_ENTRY" ]]; then
  echo "error: $SERVER_ENTRY not found — run 'npm run build' first" >&2
  exit 1
fi

os="$(uname -s)"

install_linux() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit_file="$unit_dir/agentic-driver-relay.service"
  mkdir -p "$unit_dir"

  cat > "$unit_file" <<EOF
[Unit]
Description=Agentic Driver WebSocket relay
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $SERVER_ENTRY
WorkingDirectory=$REPO_ROOT/server
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now agentic-driver-relay.service

  # Let the service start at boot even if the user hasn't logged in yet.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null || true
  fi

  echo "Installed and started systemd user service: agentic-driver-relay.service"
  echo "  status:  systemctl --user status agentic-driver-relay"
  echo "  logs:    journalctl --user -u agentic-driver-relay -f"
  echo "  restart: systemctl --user restart agentic-driver-relay"
}

install_macos() {
  local label="com.agenticdriver.relay"
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_file="$plist_dir/$label.plist"
  local log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agentic-driver"
  mkdir -p "$plist_dir" "$log_dir"

  cat > "$plist_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER_ENTRY</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT/server</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_dir/relay-daemon.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/relay-daemon.stderr.log</string>
</dict>
</plist>
EOF

  # bootout is a no-op (and errors) if it wasn't loaded before — ignore failure.
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist_file"
  launchctl enable "gui/$(id -u)/$label"

  echo "Installed and started launchd agent: $label"
  echo "  status:  launchctl print gui/$(id -u)/$label"
  echo "  logs:    tail -f $log_dir/relay-daemon.stdout.log"
  echo "  restart: launchctl kickstart -k gui/$(id -u)/$label"
}

case "$os" in
  Linux) install_linux ;;
  Darwin) install_macos ;;
  *)
    echo "error: unsupported OS '$os' — only Linux (systemd) and macOS (launchd) are supported" >&2
    exit 1
    ;;
esac
