# Agentic Driver

Your agent hits a Cloudflare wall. Agentic Driver lets you step in, solve it, and hand control back — no workflow restart, no hacks.

It's a Chrome/Brave extension paired with a WebSocket relay and an MCP adapter. Claude gets real browser tools (`navigate`, `click`, `read_html`, `screenshot`, `bundle`). When the agent needs a human — bot detection, 2FA, anything requiring judgment — it calls `handoff`, you take the wheel, and it resumes exactly where it left off.

## Quickstart

### 1. Install and build

From the repo root:

```sh
npm install
npm run build
```

### 2. Load the extension in Brave

The plugin (`plugin/`) is plain JavaScript — no build step required.

1. Open Brave and navigate to `brave://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `plugin/` directory from this repository
5. The Agentic Driver extension will appear in your extensions list — pin it to the toolbar for easy access

> The extension uses Manifest V3, which is supported in Brave 1.19+ and Chrome.

### 3. Register the MCP adapter with Claude CLI

```sh
npm run install:mcp
```

This registers the compiled adapter with `claude mcp add` at user scope, so the browser control tools (`navigate`, `click`, `read_html`, `screenshot`, `view_current_site`, `bundle`, `handoff`) are available in Claude CLI sessions from any directory, not just this repo.

### 4. Install the drive skill

From the repo root:

```sh
npx skills add . --skill drive --global --yes
```

This installs the `drive` skill globally, giving Claude the operating procedure for the browser tools — connection checks, the driving loop, error recovery, and the human-handoff flow.

### 5. Start the relay server

Run it once per session:

```sh
npm run start -w server
```

Leave it running — the extension and the MCP adapter both connect to it.

**Or install it as a background daemon** so it starts automatically and you never have to run it manually:

```sh
npm run build -w server   # if you haven't already
npm run install:daemon
```

This registers the relay as a per-user service — a systemd user unit on Linux (`~/.config/systemd/user/agentic-driver-relay.service`, enabled with `loginctl enable-linger` so it also starts at boot) or a launchd LaunchAgent on macOS (`~/Library/LaunchAgents/com.agenticdriver.relay.plist`, `RunAtLoad` + `KeepAlive`). It restarts automatically on crash and starts on every login from then on.

| | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Status | `systemctl --user status agentic-driver-relay` | `launchctl print gui/$(id -u)/com.agenticdriver.relay` |
| Logs | `journalctl --user -u agentic-driver-relay -f` | `tail -f ~/.local/state/agentic-driver/relay-daemon.std{out,err}.log` |
| Restart | `systemctl --user restart agentic-driver-relay` | `launchctl kickstart -k gui/$(id -u)/com.agenticdriver.relay` |

To remove it: `npm run uninstall:daemon`.

### 6. Drive

Open a Claude CLI session and ask Claude to browse. For example:

```
Navigate to example.com and read the page
```

Claude will control the tab through the extension. When it hits something that needs a human (a CAPTCHA, a login), it calls `handoff` — solve it in the browser, then hand control back and the agent resumes where it left off.

## Development

### Server

```sh
npm run dev               # development mode (watch + reload)
npm run build -w server   # compile TypeScript
npm run test -w server    # unit tests
```

### MCP Adapter

```sh
npm run build -w mcp  # compile TypeScript
npm run test -w mcp   # unit tests
npm run start -w mcp  # run the compiled MCP server
```

### End-to-end tests

```sh
npm run install:e2e  # install Playwright's Chromium browser (first time only)
npm run test:e2e     # run the e2e suite
```

## Logs

Both the relay server and MCP adapter write structured JSON logs to `~/.local/state/agentic-driver/` by default (respects `$XDG_STATE_HOME` if set):

| Component | File |
|---|---|
| Relay server | `~/.local/state/agentic-driver/relay.log` |
| MCP adapter | `~/.local/state/agentic-driver/mcp.log` |

To follow them live:

```sh
tail -f ~/.local/state/agentic-driver/relay.log
tail -f ~/.local/state/agentic-driver/mcp.log
```
