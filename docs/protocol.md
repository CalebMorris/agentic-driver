# Wire Protocol

All messages are JSON objects sent over WebSocket. Every message has a `type` field.

**Core principle: every agent action gets exactly one response from the plugin after execution completes.** There are no fire-and-forget messages and no unsolicited mid-action events. The WS is strictly request → execute → respond.

Requests from the agent include an `id` (string, caller-generated) for correlation.  
Responses from the plugin always echo back the `id`.

Disconnect detection uses standard WebSocket close events only (no ping-pong heartbeat).

---

## Agent → Plugin (via WS Server)

### navigate
```json
{ "id": "1", "type": "navigate", "url": "https://example.com" }
```

### click
```json
{ "id": "2", "type": "click", "selector": "#submit-button" }
```

### read_html
```json
{ "id": "3", "type": "read_html" }
```
Or with an optional selector to return only a DOM subtree:
```json
{ "id": "3", "type": "read_html", "selector": "#main-content" }
```

### screenshot
```json
{ "id": "4", "type": "screenshot" }
```

### handoff
```json
{ "id": "5", "type": "handoff", "reason": "Cloudflare challenge detected" }
```

---

## Plugin → Agent (via WS Server)

### result (success)
```json
{ "id": "1", "type": "result", "data": <action-specific payload> }
```

Action-specific `data` payloads (all sent after execution completes):
- `navigate` → `{ "url": "https://example.com", "status": "complete" }` (sent after tab finishes loading)
- `click` → `{ "status": "ok" }`
- `read_html` → `{ "html": "<html>...</html>" }`
- `screenshot` → `{ "image": "<base64-png>" }`
- `handoff` → `{ "status": "waiting_for_human" }`

### error
```json
{
  "id": "2",
  "type": "error",
  "code": "ELEMENT_NOT_FOUND",
  "message": "No element matches selector '#submit-button'"
}
```

**Error codes (v1):**
| Code | Meaning |
|---|---|
| `ELEMENT_NOT_FOUND` | CSS selector matched nothing |
| `NAVIGATION_FAILED` | Tab could not load the URL |
| `CAPTURE_FAILED` | Screenshot could not be taken |
| `UNKNOWN` | Unexpected error |

---

## Plugin → Agent (unsolicited events)

### handoff_complete
Sent when the human clicks 'Done' in the popup.
```json
{ "type": "handoff_complete" }
```

