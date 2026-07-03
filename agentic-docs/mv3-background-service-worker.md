# MV3 Background Service Worker — Pitfalls

Gotchas for `background.js` (MV3 service worker). Each section is self-contained.

| § | Symptom |
|---|---------|
| 1 | `navigate` returns immediately with the pre-navigation URL |
| 2 | `executeScript` result is `undefined` but no exception is thrown |
| 3 | Plugin never connects to relay after browser launch |
| 4 | Wrong tab is targeted in multi-tab Playwright tests |
| 5 | `worker.evaluate()` cannot see top-level variables or arrow functions |
| 6 | `chrome.tabs.query({ active: true })` returns the popup tab in tests |
| 7 | Post-pin handlers target the wrong tab or capture the wrong screenshot |
| 8 | Relay acts on stale `drivingEnabled=true` after plugin disconnect |
| 9 | How to show a badge on the extension icon and clear it |
| 10 | Collecting a page's subresources hits CORS from the content script |


## 1. `waitForTabComplete` — register listener before navigation; no early-complete check

**Trap:** `tab.status === 'complete'` is always true before navigation starts. Checking it as a shortcut resolves the promise before `tabs.update` fires, returning the pre-navigation URL.

**Fix:** Register the listener before `tabs.update`. No early-complete check needed.

```javascript
function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Navigation timed out after 30s'));
    }, 30_000);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated); // register BEFORE tabs.update
  });
}

async function handleNavigate(id, message) {
  const loadComplete = waitForTabComplete(tab.id);
  await chrome.tabs.update(tab.id, { url: message.url });
  await loadComplete;
}
```


## 2. `executeScript` errors are in the result, not thrown

**Trap:** When the injected function throws, `await executeScript(...)` does NOT throw. `results[0].result` is `undefined` and `chrome.runtime.lastError` is set. Treating `undefined` as `ELEMENT_NOT_FOUND` masks the real error.

**Fix:** Try/catch for call-level errors (bad URL, permissions); check result separately for script-level failures.

```javascript
let results;
try {
  results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
} catch (error) {
  return errorResponse(id, 'UNKNOWN', error.message);
}

const value = results[0]?.result;
if (value === null || value === undefined) {
  return errorResponse(id, 'ELEMENT_NOT_FOUND', `No element matches '${selector}'`);
}
```


## 3. Relay must be listening before the browser launches

**Trap:** `new WebSocketServer({ port })` is async. The extension may try to connect before the server is ready, fail silently, and never link.

See `playwright-chrome-extensions.md` § 3 for the fix pattern.


## 4. `currentWindow: true` targets the focused window in Playwright

**Trap:** After `context.newPage()`, the new tab has focus. `chrome.tabs.query({ active: true, currentWindow: true })` returns that new tab. Close pages between tests to avoid stale tab references.


## 5. Top-level `var` / `function` required for `worker.evaluate()` access

**Trap:** `let`/`const` and arrow functions at the top level of a service worker are NOT properties of `self`. `worker.evaluate()` only sees `self` properties.

```javascript
// INACCESSIBLE via worker.evaluate()
let pinnedTabId = null;
const enableDriving = async () => { ... };

// ACCESSIBLE via worker.evaluate()
var pinnedTabId = null;
async function enableDriving() { ... }
```

**Fix:** Use `var` for any state and named `function` declarations for any function that tests must reach via `worker.evaluate()`.

See `playwright-chrome-extensions.md` § 6 for the Playwright call pattern.


## 6. Popup-as-tab in tests: `active` query returns the popup, not the content page

**Trap:** In real Chrome, the popup is an overlay and does not change the active tab. In Playwright, navigating to `popup.html` makes it a real tab. `chrome.tabs.query({ active: true })` from background returns the popup's tab ID, not the content page.

**Fix (background.js):** Keep the `tabs.query` inside background. The popup sends only `{ type: 'enable_driving' }`; background resolves the correct tab itself.

```javascript
async function enableDriving() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    pinnedTabId = tab.id;
    drivingEnabled = true;
    sendControlMessage({ type: 'driving_enabled', tabId: tab.id });
  }
}
```

**Fix (tests):** Bypass the popup. Navigate the content page first, then call `enableDriving()` via `worker.evaluate()`. See `playwright-chrome-extensions.md` § 6.


## 7. Pinned-tab handlers: `get(pinnedTabId)` not re-query; `tab.windowId` for screenshots

**Trap A — Stale URL after navigate:** Re-querying the active tab returns whatever tab is active now.

```javascript
// WRONG
const [updatedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
// CORRECT
const updatedTab = await chrome.tabs.get(pinnedTabId);
```

**Trap B — Wrong screenshot:** `captureVisibleTab(null, ...)` captures the last-focused window, not the pinned tab's window.

```javascript
// WRONG
await chrome.tabs.captureVisibleTab(null, { format: 'png' });
// CORRECT
const tab = await chrome.tabs.get(pinnedTabId);
await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
```

**Pattern:** `getPinnedTab()` returns `null` when nothing is pinned; every handler bails early on `null`.

```javascript
async function getPinnedTab() {
  if (!pinnedTabId) return null;
  try { return await chrome.tabs.get(pinnedTabId); }
  catch { return null; }
}

async function handleSomeAction(id) {
  const tab = await getPinnedTab();
  if (!tab) return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  // use tab.id, tab.windowId, etc.
}
```


## 8. Reset relay state on plugin disconnect

**Trap:** Plugin disconnects (crash/reload/drop) with `drivingEnabled = true` on the relay. Subsequent agent actions route to a non-existent socket.

**Fix:** Reset in the plugin socket's `close` handler.

```typescript
socket.on('close', () => {
  pluginSocket = null;
  drivingEnabled = false;
  console.log('[relay] Plugin disconnected');
});
```

See `relay-server.md` § 5–6 for the extended pattern when there are pending in-flight requests (e.g., handoff) that also need to be unblocked on disconnect.


## 9. How to show a badge on the extension icon and clear it

Use `chrome.action.setBadgeText` / `setBadgeBackgroundColor` to show a visible indicator on the toolbar icon. This is the correct way to signal to the user that attention is needed without requiring the popup to be open.

```javascript
// Show a badge — call from background.js (e.g., on handoff)
chrome.action.setBadgeText({ text: '!' });
chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // amber

// Clear the badge — call when the condition resolves
chrome.action.setBadgeText({ text: '' }); // empty string removes the badge
```

**Notes:**
- `text` must be a string; `null` does not clear the badge in MV3 — use `''`.
- `color` can be a hex string or an `[R, G, B, A]` array.
- Neither call requires `await` — they are fire-and-forget.
- Both calls are on `chrome.action`, not `chrome.browserAction` (MV2 — do not use).


## 10. Fetch subresources from the background worker, not the content script

**Trap:** To archive a page's loaded files, the obvious move is to `fetch()` each resource from the content script (it already knows the page's origin). But the content script runs in the page's origin context — cross-origin subresources (a CDN stylesheet, a third-party image) fail CORS, and `mode: 'no-cors'` yields an opaque response whose body you can't read.

**Fix:** Split the work. The content script only *enumerates* — `performance.getEntriesByType('resource')` lists every subresource the browser loaded for the current document (it resets per navigation, so it reflects only the current page). The background service worker *fetches* — it holds `<all_urls>` host permission (`manifest.json`), so its `fetch()` bypasses page CORS entirely and can read any response body.

```javascript
// content.js — enumerate only
const resources = [...new Set(performance.getEntriesByType('resource').map((e) => e.name))];

// background.js — fetch with host permissions (no CORS)
async function fetchResourceBytes(url) {
  if (!/^https?:/i.test(url)) return null;      // skip data:, blob:, extension URLs
  const response = await fetch(url);
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}
```

Tolerate per-resource failures (skip and continue) — a single 404 or opaque response should not fail the whole operation.

**Bonus — zipping in the worker:** the service worker has `CompressionStream('deflate-raw')` built in, so you can produce real DEFLATE-compressed zips (method 8) with no library. See `buildZipArchive`/`deflateRaw` in `background.js`.
