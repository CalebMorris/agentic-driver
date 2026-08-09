#!/usr/bin/env bash
# Removes the Agentic Driver relay daemon installed by install-daemon.sh.
set -euo pipefail

os="$(uname -s)"

uninstall_linux() {
  local unit_file="$HOME/.config/systemd/user/agentic-driver-relay.service"
  systemctl --user disable --now agentic-driver-relay.service 2>/dev/null || true
  rm -f "$unit_file"
  systemctl --user daemon-reload
  echo "Removed systemd user service: agentic-driver-relay.service"
  echo "Note: 'loginctl enable-linger $USER' was left in place (other services may depend on it)."
}

uninstall_macos() {
  local label="com.agenticdriver.relay"
  local plist_file="$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist_file"
  echo "Removed launchd agent: $label"
}

case "$os" in
  Linux) uninstall_linux ;;
  Darwin) uninstall_macos ;;
  *)
    echo "error: unsupported OS '$os'" >&2
    exit 1
    ;;
esac
