# Agentic Driver

A simple browser plugin that connects to a websocket server to allow 2-way communication with an agent that needs to
drive a browser with human handoffs.

## Running

Install all dependencies from the repo root:

```sh
npm install
```

### Server

```sh
npm run dev          # development mode (watch + reload)
npm run build -w server   # compile TypeScript
npm run test -w server    # unit tests
npm run install:e2e  # install Playwright's Chromium browser (first time only)
npm run test:e2e     # end-to-end tests
```

### MCP Adapter

```sh
npm run build -w mcp  # compile TypeScript
npm run test -w mcp   # unit tests
npm run start -w mcp  # run the compiled MCP server
```

### Browser Plugin

The plugin (`plugin/`) is plain JavaScript — no build step required. Load it directly into the browser (see Installing in Brave below).


## Registering the MCP Adapter with Claude CLI

Build the MCP adapter and register it as a local MCP server so Claude CLI can use it:

```sh
npm run build -w mcp
npm run install:mcp
```

The `install:mcp` script registers the compiled adapter with `claude mcp add`. After registering, Claude CLI will have access to the browser control tools (`navigate`, `click`, `read_html`, `screenshot`, `view_current_site`, `handoff`) whenever the relay server is running.


## Installing in Brave

1. Open Brave and navigate to `brave://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `plugin/` directory from this repository
5. The Agentic Driver extension will appear in your extensions list — pin it to the toolbar for easy access

> The extension uses Manifest V3, which is supported in Brave 1.19+.

## Example Use Case

I want my agent to investigate and research a topic, but some of the websites present have hard Cloudflare blocks on them. I want the agent to hand off the driving to me with a ping, have me complete the Cloudflare solution, and pass back driver control to the agent.
