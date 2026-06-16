# Implementation Plan

## Decisions Made

| Topic | Decision |
|---|---|
| Browser target | Brave / Chromium, Manifest V3 |
| Action execution | Agent sends discrete actions over WebSocket; plugin executes via JS in page context |
| WebSocket server | Build in this repo |
| Agent framework binding | Claude CLI via MCP adapter (primary / only supported method) |
| Human handoff trigger | Agent sends handoff message; plugin fires badge + browser notification |
| Human handoff resume | Human clicks 'Done' in the plugin popup |
| WebSocket server language | Node.js |
| WebSocket server port | 9999 (`ws://localhost:9999`) |
| Auth / security | Local-only; WS on localhost; no auth token |

| Action set (v1) | `view_current_site`, `navigate`, `click`, `read_html`, `screenshot` |
| Error handling | Plugin returns error to agent; agent decides next step |
| Tab management | Active tab only (v1) |

| All commands request/response | Every agent action blocks until plugin responds; no fire-and-forget |
| navigate timing | Responds only after tab finishes loading (`status === "complete"`) |
| Heartbeat | None — rely on WS close events |
| `read_html` selector | Optional `selector` param; full page if omitted |

## Decisions Pending

_(none — all questions resolved)_

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Process                        │
│  (Claude CLI via MCP adapter)                            │
│                                                          │
│  Sends actions:  { type, ...params }                     │
│  Receives:       { type: "result", data / error }        │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket
                       ▼
┌─────────────────────────────────────────────────────────┐
│               WebSocket Server (local)                   │
│  Node.js       |  listens on localhost:9999              │
│                                                          │
│  - Relays messages between agent and plugin              │
│  - Manages session state (who has control)               │
│  - Tracks handoff state (agent_driving / human_driving)  │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket
                       ▼
┌──────────────────────────────────────────────────────────────┐
│            Browser Plugin (Chromium MV3)                      │
│                                                               │
│  background.js  — WS connection, message dispatch             │
│  content.js     — injected into page, executes actions        │
│  popup.html/js  — (TBD) handoff UI for human                  │
│                                                               │
│  Actions executed via JS:                                     │
│    view_current_site → chrome.tabs.query (active url+title)   │
│    screenshot        → chrome.tabs.captureVisibleTab          │
│    navigate          → chrome.tabs.update                     │
│    click             → document.querySelector(...).click()    │
│    read_html         → document.documentElement.outerHTML     │
└──────────────────────────────────────────────────────────────┘
```

---

## Proposed Components

### 1. Browser Plugin (`/plugin`)

- `manifest.json` — MV3 manifest
- `background.js` (Service Worker) — owns the WebSocket connection, routes messages to content scripts or chrome APIs
- `content.js` — injected into tabs, executes DOM-level actions (click, read, fill, etc.)
- `popup.html` / `popup.js` — human-facing UI for handoff notification and resume (design TBD)

### 2. WebSocket Server (`/server`)

- Single relay process running locally
- Maintains two connections: one to the agent, one to the plugin
- Tracks control state: `agent_driving` | `human_driving`
- Forwards messages between sides; enforces state transitions

### 3. MCP Adapter (`/mcp`)

- Node.js process that bridges Claude CLI to the WS relay
- Connects to `ws://localhost:9999/agent` and wraps each action as an MCP tool
- Primary connection method: `claude mcp add agentic-driver /path/to/mcp/index.js`

### 4. Protocol (`/docs/protocol.md`)

- Message schema for every action type
- Result / error envelope format
- Handoff / resume message types
- Connection / heartbeat / reconnect behavior

---

## Implementation Phases

### Phase 0 — Tab Pinning & Driving Gate

Before any agent action can execute, two preconditions must be satisfied:

1. **Tab pinning** — a specific tab must be designated as the agent's target. The user opens the plugin popup on the tab they want driven and clicks "Enable Driving." That tab's ID is stored in `background.js` as the pinned tab. All subsequent actions operate on this tab ID, never on `chrome.tabs.query({ active: true })`.

2. **Driving gate** — the relay server must reject agent messages with a `DRIVING_DISABLED` error until the plugin has signalled that driving is enabled. When the user clicks "Enable Driving," `background.js` sends a `driving_enabled` message to the relay; when they click "Disable Driving" (or the tab closes), it sends `driving_disabled`. The relay tracks this state and enforces it.

**Deliverables:**
- [x] Popup UI: "Enable Driving" / "Disable Driving" toggle button showing current state
- [x] `background.js`: stores pinned `tabId`; sends `driving_enabled` / `driving_disabled` to relay on toggle; clears pinned tab on tab close
- [x] Relay: tracks `drivingEnabled` boolean; returns `DRIVING_DISABLED` error to agent when gate is closed; resets on plugin disconnect
- [x] Protocol additions: `driving_enabled`, `driving_disabled` plugin→relay control messages; `DRIVING_DISABLED` error code
- [x] All existing action handlers updated to use pinned `tabId` instead of querying active tab
- [x] End-to-end test: agent action is rejected before enable, succeeds after enable, rejected again after disable

### Phase 1 — Protocol & Scaffolding
- [x] Define full message protocol (all action types, result shapes, error format)
- [x] Scaffold plugin directory structure and `manifest.json`
- [x] Scaffold server skeleton

### Phase 2 — Core Action Loop
- [x] Implement WS server relay
- [x] Implement `background.js` WS connection + dispatch
- [x] `navigate`, `click`, `read_html`, `screenshot` actions (implemented in `background.js`)
- [x] `view_current_site` action
- [ ] `content.js` (DOM-level actions currently handled directly in `background.js` via `executeScript`)
- [x] End-to-end tests: `navigate`, `click`, `read_html`, `screenshot`, unknown action type

### Phase 3 — MCP Adapter (primary Claude CLI connection method)
- [x] Build MCP server that connects to relay as the agent (`ws://localhost:9999/agent`)
- [x] Expose each action type as an MCP tool with typed input/output schemas
- [x] Translate MCP tool calls → WS requests; WS responses → MCP tool results
- [ ] Register with Claude CLI via `claude mcp add`
- [x] End-to-end test: MCP client → relay → mock plugin → result verified (7 tests pass)

### Phase 4 — Human Handoff
- [ ] Implement `handoff` / `handoff_complete` message types in server + plugin
- [ ] Build plugin UI for handoff notification and resume signal (popup.html exists as placeholder only)
- [ ] Test full handoff round-trip

### Phase 5 — Hardening
- [ ] Error handling for failed actions
- [ ] Reconnection logic (agent or plugin disconnects)
- [ ] Auth model (if required)
- [ ] Tab lifecycle management (if in scope)
