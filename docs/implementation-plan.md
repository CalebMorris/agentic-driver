# Implementation Plan

## Decisions Made

| Topic | Decision |
|---|---|
| Browser target | Brave / Chromium, Manifest V3 |
| Action execution | Agent sends discrete actions over WebSocket; plugin executes via JS in page context |
| WebSocket server | Build in this repo |
| Agent framework binding | Framework-agnostic protocol; specific adapter TBD |
| Human handoff trigger | Agent sends handoff message; plugin fires badge + browser notification |
| Human handoff resume | Human clicks 'Done' in the plugin popup |
| WebSocket server language | Spec-first — define protocol before picking implementation language |
| Auth / security | Local-only; WS on localhost; no auth token |

| Action set (v1) | `navigate`, `click`, `read_html`, `screenshot` |
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
│  (AI agent, framework TBD)                               │
│                                                          │
│  Sends actions:  { type, ...params }                     │
│  Receives:       { type: "result", data / error }        │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket
                       ▼
┌─────────────────────────────────────────────────────────┐
│               WebSocket Server (local)                   │
│  Language TBD  |  listens on localhost:PORT              │
│                                                          │
│  - Relays messages between agent and plugin              │
│  - Manages session state (who has control)               │
│  - Tracks handoff state (agent_driving / human_driving)  │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket
                       ▼
┌─────────────────────────────────────────────────────────┐
│            Browser Plugin (Chromium MV3)                 │
│                                                          │
│  background.js  — WS connection, message dispatch        │
│  content.js     — injected into page, executes actions   │
│  popup.html/js  — (TBD) handoff UI for human             │
│                                                          │
│  Actions executed via JS:                                │
│    screenshot    → chrome.tabs.captureVisibleTab         │
│    navigate      → chrome.tabs.update                    │
│    click         → document.querySelector(...).click()   │
│    read_html     → document.documentElement.outerHTML    │
│    (more TBD)                                            │
└─────────────────────────────────────────────────────────┘
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

### 3. Protocol (`/docs/protocol.md`)

- Message schema for every action type
- Result / error envelope format
- Handoff / resume message types
- Connection / heartbeat / reconnect behavior

---

## Implementation Phases (draft, pending open questions)

### Phase 1 — Protocol & Scaffolding
- Define full message protocol (all action types, result shapes, error format)
- Scaffold plugin directory structure and `manifest.json`
- Scaffold server skeleton

### Phase 2 — Core Action Loop
- Implement WS server relay
- Implement `background.js` WS connection + dispatch
- Implement `content.js` with: `navigate`, `click`, `read_html`, `screenshot`
- End-to-end test: agent sends action → plugin executes → result returned

### Phase 3 — Human Handoff
- Implement `handoff` / `handoff_complete` message types in server + plugin
- Build plugin UI for handoff notification and resume signal
- Test full handoff round-trip

### Phase 4 — Hardening
- Error handling for failed actions
- Reconnection logic (agent or plugin disconnects)
- Auth model (if required)
- Tab lifecycle management (if in scope)
