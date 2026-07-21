---
name: drive
description: >
  This skill should be used when the user asks the agent to control a browser, automate
  a web task, navigate to a URL, click on elements, fill out a form, take a screenshot
  of a tab, or handle situations like CAPTCHAs during automation. Trigger phrases include:
  "browse to", "navigate to", "click on", "automate this in the browser", "fill out the
  form", "use the browser to", "take a screenshot of the page", "drive the browser",
  "handle the CAPTCHA". Provides the full operating procedure for the agentic-driver MCP
  server: connection verification, all tool signatures, driving loop strategy, error
  recovery, and human handoff.
---

# Agentic Driver — Agent Runbook

## 1. Verify the MCP Server Is Connected

Before driving, call `check_status` with no arguments. It returns all three connection states in one call without touching the browser.

```
check_status()
→ { relayConnected: bool, pluginConnected: bool, drivingEnabled: bool }
```

Decision tree:

- **`relayConnected: false`** — the relay server is not running. **Stop and tell the user** to start it (`npm run dev` from the `server/` workspace) and verify the MCP adapter is connected (`claude mcp list`). Do not retry automatically.
- **`pluginConnected: false`** — the relay is up but the browser extension has not connected to it. **Stop and ask the user** to open Chrome, ensure the Agentic Driver extension is installed and active, and confirm it shows "Connected" in the popup.
- **`drivingEnabled: false`** — both are connected but the user has not clicked "Enable Driving" in the extension popup. **Stop and ask the user to enable driving.**
- **All three `true`** — proceed to driving.

**Step 2 — Confirm tab context.**
Call `view_current_site` to get the current URL and title, then confirm the active tab is the correct page before taking any destructive action (form submission, navigation away from unsaved work, etc.).

## 2. Available Tools

All tools communicate via the relay WebSocket. Every call blocks until the action completes.

Every tool except `handoff` accepts an optional `timeoutMs` parameter overriding the default 10-second response timeout for that single call. If the relay does not respond within the window, the call returns a `RELAY_TIMEOUT` error. Pass a larger `timeoutMs` when an operation is expected to be slow — e.g. `navigate` to a heavy page, or `bundle` on a resource-rich site. `handoff` has no timeout: it blocks until the human finishes.

### `check_status()`
Returns the current connection state of the entire driver stack. Always call this first.

```
Response: { relayConnected: bool, pluginConnected: bool, drivingEnabled: bool }
```

- Does not touch the browser or require driving to be enabled — safe to call at any time.
- Use it at the start of every session (see Section 1) and any time a subsequent tool returns an unexpected error.

### `view_current_site`
Returns metadata about the currently pinned tab.

```
Response: { id, url, title, status, active, faviconUrl }
```

Use this to orient to the current page (URL, page title) before deciding what to do next. Also the cheapest way to verify the connection is alive mid-session.

### `navigate(url: string)`
Navigates the pinned tab to `url` and waits for the page to finish loading and paint its first frame.

```
Response: { url, status: "complete", firstPaint: true }
```

- Use full URLs including scheme (`https://`).
- The tool blocks until the tab finishes loading — no polling or waiting is needed after the call returns.
- `firstPaint: true` means the page has rendered at least one frame, so a screenshot will mechanically succeed — it does NOT mean dynamic content (SPA hydration, spinners) has finished. `firstPaint: false` means no frame was painted within 5 seconds — usually the browser window is occluded or minimized; a screenshot may fail with `CAPTURE_FAILED` until the window is visible again.
- On failure: `NAVIGATION_FAILED` error — the page could not load. Check the URL, then try once more; if still failing, consider a handoff.

### `click(selector: string)`
Clicks the element matching the CSS `selector` in the pinned tab.

```
Response: { status: "ok" }
```

- Call `read_html` or `screenshot` first when the target selector is uncertain.
- Prefer stable selectors (`[data-testid="…"]`, `#id`, `[name="…"]`) over positional ones (`:nth-child`).
- On failure: `ELEMENT_NOT_FOUND` — the selector matched nothing. Re-read the HTML to verify the current DOM, update the selector, and retry. After two failed attempts consider a handoff.

### `read_html(selector?: string)`
Returns the outer HTML of the page, or a subtree if `selector` is provided.

```
Response: "<html>…</html>"  (or subtree HTML when selector is given)
```

- Scope with `selector` whenever possible to reduce token usage (e.g. `read_html({ selector: "#main-content" })`).
- Use this to find selectors, read form state, or verify that an action took effect.
- Full-page HTML can be large; prefer scoped reads when the relevant DOM region is known.

### `screenshot()`
Returns a base64-encoded PNG of the visible area of the pinned tab.

```
Response: image/png content block
```

- Use to visually verify page state when HTML is ambiguous or the page is canvas/image-heavy.
- On failure: `CAPTURE_FAILED` — the plugin already retried 3 times internally, so the failure is persistent: the browser window is likely occluded, minimized, or the pinned tab is not the frontmost tab. Ask the user to bring the window into view, or use `read_html` as a fallback. Do not retry in a tight loop.

### `bundle()`
Captures the entire current page — its live DOM plus every subresource the browser has loaded (CSS, JS, images, fonts) — into a single zip archive and returns it.

```
Response: text summary { url, fileCount, byteSize } + an application/zip resource block (base64 zip)
```

The archive stores the DOM as `index.html` and each subresource under a URL-derived path (`<hostname>/<path>`), DEFLATE-compressed.

- Use to snapshot or archive a site for offline analysis, or to hand a complete captured page to a downstream step.
- Only subresources the browser actually loaded for the current page are included; a resource that cannot be fetched (opaque cross-origin response, 404) is silently omitted rather than failing the bundle.
- The archive can be large — prefer `read_html` (optionally scoped) or `screenshot` when you only need part of the page.
- On failure: `UNKNOWN` — retry once; if the page has no pinned tab, re-check `check_status`.

### `handoff(reason: string)`
Pauses agent control and notifies the user that human intervention is needed. **Blocks until the human clicks "Done" in the extension popup.**

```
Response: { status: "complete" }  (arrives only after human signals done)
```

See Section 4 for full handoff guidance.

## 3. Driving Strategy

### General loop

```
view_current_site          → confirm context
read_html / screenshot     → understand page state
navigate / click           → act
read_html / screenshot     → verify the action took effect
repeat
```

### Minimising token usage

- Always scope `read_html` to the relevant DOM subtree (`selector` param).
- Use `view_current_site` instead of `read_html` when only the URL or title is needed.
- Use `screenshot` only when HTML is not enough (visual layout, CAPTCHAs, canvas, image galleries).

### After navigation

After `navigate` returns, the page is loaded but dynamic content (SPAs, lazy loaders) may still be rendering. If a subsequent `click` returns `ELEMENT_NOT_FOUND` for a selector expected to exist, re-read the HTML once to let the page settle, then retry.

### Form submission

Prefer clicking the submit button (`click({ selector: "button[type='submit']" })`) over simulating keyboard enter, unless the form explicitly requires it. After submission, call `view_current_site` or `read_html` to confirm navigation landed on the expected result page.

## 4. Human Handoff

### When to hand off

Use `handoff` upon encountering a situation that cannot be resolved autonomously:

| Situation | Example |
|---|---|
| Bot-detection / CAPTCHA | Cloudflare challenge, hCaptcha |
| Login wall with unavailable credentials | OAuth flow, SSO, 2FA prompt |
| Ambiguous page state requiring human judgement | Confirmation on a destructive action |
| Repeated `ELEMENT_NOT_FOUND` with no clear recovery | Element never appears after multiple retries |

### How to call handoff

```
handoff({ reason: "Cloudflare challenge detected — please solve it and click Done." })
```

- The `reason` string is displayed verbatim in the extension popup. Be specific and actionable: the reason should describe exactly what action the user needs to take.
- The tool call **blocks** until the user clicks "Done" in the popup. This may take seconds or minutes — that is expected.

### After handoff returns

When `handoff` returns `{ status: "complete" }`, the human has signalled they are done. Before resuming:

1. Call `view_current_site` to get the current URL and title — the page may have changed significantly.
2. Call `read_html` or `screenshot` to re-orient to the new page state.
3. Resume from where the task paused, adjusting for the new context.

### If handoff fails (plugin disconnects mid-handoff)

If `handoff` returns an error with `UNKNOWN` and the message contains "Plugin disconnected", the extension was closed while waiting. Do not retry `handoff` — the relay has already cleaned up the pending request. Inform the user and ask them to reopen the extension and re-enable driving before resuming.

## 5. Error Handling Reference

| Error code | Meaning | Recommended recovery |
|---|---|---|
| `DRIVING_DISABLED` | Extension has not enabled driving | Stop. Ask user to click "Enable Driving" in the popup. |
| `ELEMENT_NOT_FOUND` | CSS selector matched nothing | Re-read HTML, fix selector, retry. After 2 failures → handoff. |
| `NAVIGATION_FAILED` | Tab could not load the URL | Check URL validity, retry once. If bot-detected → handoff. |
| `CAPTURE_FAILED` | Screenshot could not be taken (plugin already retried 3×) | Window is likely occluded/minimized — ask the user to make it visible, or fall back to `read_html`. |
| `RELAY_TIMEOUT` | Relay did not respond within the timeout window (default 10 s; relay or extension hung) | Call `check_status` to verify connectivity, then retry once — pass a larger `timeoutMs` if the operation is legitimately slow. If repeated → handoff. `handoff` itself has no timeout and blocks indefinitely. |
| `UNKNOWN` | Unexpected plugin-side error | Retry once; if repeated → handoff with a descriptive reason. |

**Never loop indefinitely on errors.** If the same error recurs after one retry, either change approach or request a handoff.

## 6. Session End / Cleanup

- No explicit session close or relay disconnect is needed — the user controls driving via the extension popup.
- On task completion, summarise the completed actions and the final state (URL, page title) for the user's record.
- If interrupted, report the last known URL and page state so the user can resume manually.
