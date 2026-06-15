# MV3 Background Service Worker — Pitfalls

Patterns and gotchas specific to the Agentic Driver's `background.js` (MV3 service worker).

---

## 1. `waitForTabComplete` — never check "already complete" before navigation

**The trap:** A common pattern is to register `chrome.tabs.onUpdated` and then immediately check if the tab is already `'complete'` as a shortcut for fast/cached loads:

```javascript
// BROKEN — do not do this
chrome.tabs.onUpdated.addListener(onUpdated);
chrome.tabs.get(tabId).then((tab) => {
  if (tab.status === 'complete') resolve(); // fires immediately — BEFORE navigation starts
});
```

Every tab is in `status: 'complete'` before navigation begins. This check always fires, resolving the promise before `chrome.tabs.update` is even called. The result: `navigate` returns immediately with the **pre-navigation URL** (e.g. `about:blank`), not the destination.

**Fix:** Do not check for early-complete. Register the listener before calling `tabs.update` — that is sufficient to avoid missing the event:

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

    // Register BEFORE tabs.update — cannot miss the event this way.
    // No early-complete check: the tab is always 'complete' before navigation.
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// Correct call site
async function handleNavigate(id, message) {
  const loadComplete = waitForTabComplete(tab.id);  // listener registered first
  await chrome.tabs.update(tab.id, { url: message.url });
  await loadComplete;                                // now wait for real completion
  // ...
}
```

---

## 2. `chrome.scripting.executeScript` returns errors, not throws, on script failures

**What happens:** When the injected function throws inside `executeScript`, the result's `result` property is `undefined` and `chrome.runtime.lastError` is set — the outer `await` does NOT throw. Code that checks `result?.result` for null/false will incorrectly return `ELEMENT_NOT_FOUND` when the real error is something else (e.g. the tab URL is `about:blank`).

**Symptom:** Getting `ELEMENT_NOT_FOUND` even when the element exists (or `UNKNOWN` when it should be `ELEMENT_NOT_FOUND`).

**Pattern to follow:** Wrap `executeScript` in try/catch AND validate the result distinctly:

```javascript
let results;
try {
  results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
} catch (error) {
  // Tab URL not scriptable (about:blank, chrome://, etc.) or permission error
  return errorResponse(id, 'UNKNOWN', error.message);
}

const value = results[0]?.result;
if (value === null || value === undefined) {
  return errorResponse(id, 'ELEMENT_NOT_FOUND', `No element matches '${selector}'`);
}
```

---

## 3. Service worker WS connection is fire-and-forget on startup

`connect()` in `background.js` is called at module load. If the relay server is not yet listening, the WebSocket `error` event fires and the connection is silently dropped. The service worker continues to run (it does not crash), but the plugin is never connected to the relay.

**Implication for tests:** Always start the relay server and confirm it is listening before launching the browser. See `playwright-chrome-extensions.md` § 3.

**Implication for production:** Phase 5 reconnection logic should retry `connect()` on `socket.addEventListener('close', ...)` with exponential backoff so transient relay restarts recover automatically.

---

## 4. `chrome.tabs.query({ active: true, currentWindow: true })` in tests

When multiple tabs are open in the Playwright persistent context, `currentWindow: true` refers to the window that has focus. After `context.newPage()`, the new tab is focused and active — this is the tab the plugin will operate on. Close pages between tests to avoid stale tab references.
