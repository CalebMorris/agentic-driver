# User Stories

## Entities

1. **Browser** — Brave (Chromium MV3 plugin) executing in the user's browser session
2. **WebSocket Server** — Relay/coordination server running locally; bridges the agent and the plugin
3. **Agent** — Claude CLI via MCP adapter, which drives the browser via discrete actions

---

## Core Flows

### US-01: Agent drives the browser normally

> As an agent, I want to send browser actions over WebSocket so the plugin executes them in the active tab, allowing me to automate browsing without the user's involvement.

**Interaction sequence:**
1. Agent → WS Server: sends an action message (e.g. `{ type: "click", selector: "#submit" }`)
2. WS Server → Plugin: relays the action
3. Plugin: executes the action via JavaScript in the page context
4. Plugin → WS Server: sends back a result (e.g. success / error / return value)
5. WS Server → Agent: relays the result

---

### US-02: Agent requests a human handoff

> As an agent, I want to pause my control and notify the human when I'm blocked (e.g. Cloudflare challenge), so the human can complete the step and return control to me.

**Interaction sequence:**
1. Agent → WS Server: sends `{ type: "handoff", reason: "Cloudflare challenge detected" }`
2. WS Server → Plugin: relays handoff request
3. Plugin: sets badge on extension icon + fires a browser notification alerting the human
4. Human: completes the blocking step manually in the browser
5. Human → Plugin: clicks 'Done' in the plugin popup
6. Plugin → WS Server: sends `{ type: "handoff_complete" }`
7. WS Server → Agent: relays resume signal
8. Agent: resumes autonomous driving

---

### US-03: Plugin relays page content to agent

> As an agent, I want to read the current page's HTML or text so I can make decisions about what action to take next.

**Interaction sequence:**
1. Agent → WS Server: `{ type: "read_html" }`
2. WS Server → Plugin: relays request
3. Plugin: reads `document.documentElement.outerHTML` (or similar)
4. Plugin → WS Server: `{ type: "result", data: "<html>..." }`
5. WS Server → Agent: relays content

---

### US-04: Plugin captures and sends a screenshot

> As an agent, I want a screenshot of the current tab so I can visually assess the page state.

**Interaction sequence:**
1. Agent → WS Server: `{ type: "screenshot" }`
2. WS Server → Plugin: relays request
3. Plugin: uses `chrome.tabs.captureVisibleTab` to capture the current tab
4. Plugin → WS Server: `{ type: "result", data: { "image": "<base64-png>" } }`
5. WS Server → Agent: relays image

---

### US-05: Agent navigates to a URL

> As an agent, I want to direct the browser to load a specific URL.

**Interaction sequence:**
1. Agent → WS Server: `{ type: "navigate", url: "https://example.com" }`
2. WS Server → Plugin: relays request
3. Plugin: calls `chrome.tabs.update` and waits for the tab to finish loading
4. Plugin → WS Server: `{ type: "result", data: { "url": "https://example.com", "status": "complete" } }`
5. WS Server → Agent: relays result

---

### US-06: Action fails — agent receives error

> As an agent, I want to receive a structured error when a browser action fails so I can decide how to recover (retry, try a different action, or request a human handoff).

**Interaction sequence:**
1. Agent → WS Server: sends an action (e.g. `{ type: "click", selector: "#missing-button" }`)
2. WS Server → Plugin: relays the action
3. Plugin: fails to execute (element not found, page not ready, etc.)
4. Plugin → WS Server: `{ type: "error", code: "ELEMENT_NOT_FOUND", message: "..." }`
5. WS Server → Agent: relays the error
6. Agent: decides next step autonomously (retry, different action, or request handoff via US-02)

## Out of Scope (v1)

- Auto-detection of blocking pages by the plugin (Cloudflare, login walls) — agent is responsible for detecting and requesting handoff
- Tab lifecycle management (open, close, switch tabs)
- Agent authentication / connection handshake (localhost-only, no auth)
