# Playwright + Chrome Extension Testing

Pitfalls and correct patterns for MV3 Chrome extensions with Playwright. Each section is self-contained.

| § | Symptom |
|---|---------|
| 1 | Service worker never registers; `waitForEvent('serviceworker')` hangs |
| 2 | All scripting actions return `UNKNOWN` despite visible page content |
| 3 | Plugin never connects to relay |
| 4 | First agent message fails with "Plugin is not connected" |
| 5 | Working `beforeAll` skeleton |
| 6 | Tests need to call or read `background.js` functions directly |
| 7 | Agent action beats relay state update (control message race) |
| 8 | Phase-dependent tests interfere or have ordering dependencies |

---

## 1. Use `headless: false` + `--headless=new` to load extensions

**Trap:** `headless: true` routes Playwright to the headless shell binary, which does not support extensions. The service worker never registers; `waitForEvent('serviceworker')` hangs until the context closes:

```
Error: browserContext.waitForEvent: Target page, context or browser has been closed
```

**Fix:**

```typescript
browserContext = await chromium.launchPersistentContext(userDataDir, {
  headless: false,           // prevents Playwright from routing to the headless shell
  args: [
    '--headless=new',        // runs full Chromium in headless mode
    '--no-sandbox',
    '--disable-setuid-sandbox',
    `--disable-extensions-except=${PLUGIN_PATH}`,
    `--load-extension=${PLUGIN_PATH}`,
  ],
});
```

---

## 2. Navigate to a real `http://` URL — scripting APIs refuse `about:blank`

**Trap:** `page.setContent()` leaves the page at `about:blank`. `executeScript` and `captureVisibleTab` refuse `about:blank`/`chrome://` URLs and return `UNKNOWN` even when the page visually has content.

**Fix:** Use a local HTTP server with path-based routes. Never call `page.setContent()` in extension tests.

```typescript
const routes: Record<string, string> = {
  '/hello':  '<html><body><h1>Hello World</h1></body></html>',
  '/button': `<html><body><button id="btn" onclick="this.dataset.clicked='true'">Click</button></body></html>`,
};
testServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(routes[req.url ?? '/'] ?? '<html><body></body></html>');
});
await new Promise<void>((resolve) => testServer.listen(0, 'localhost', () => resolve()));

// In tests — never page.setContent()
await page.goto(`http://localhost:${testServerPort}/hello`);
```

---

## 3. Wait for relay `'listening'` before launching the browser

**Trap:** `new WebSocketServer({ port })` starts async. If the browser launches first, the extension connects before the server is ready, fails silently, and never links.

**Fix:**

```typescript
const relay = createRelayServer(SERVER_PORT);
await new Promise<void>((resolve) => {
  if (relay.wss.address()) resolve();
  else relay.wss.once('listening', resolve);
});

browserContext = await chromium.launchPersistentContext(userDataDir, { ... });
```

---

## 4. Wait for the plugin WS connection, not the service worker event

**Trap:** `waitForEvent('serviceworker')` fires before `connect()` in `background.js` finishes establishing the WebSocket. Sending an agent message immediately gets "Plugin is not connected."

**Fix:** Wait for the relay to confirm the plugin socket is connected.

```typescript
await relay.waitForPlugin();   // resolves on /plugin WS handshake
agent = await connectClient('/agent');
```

---

## 5. Full `beforeAll` skeleton

```typescript
test.beforeAll(async ({ }, testInfo) => {
  testInfo.setTimeout(60_000);

  const relay = createRelayServer(SERVER_PORT);
  relayWss = relay.wss;
  await new Promise<void>((resolve) => {
    if (relayWss.address()) resolve();
    else relayWss.once('listening', resolve);
  });

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--disable-extensions-except=${PLUGIN_PATH}`,
      `--load-extension=${PLUGIN_PATH}`,
    ],
  });

  await relay.waitForPlugin();
  agent = await connectClient('/agent');
});
```

---

## 6. Calling `background.js` functions from tests via `worker.evaluate()`

**What it does:** `browserContext.serviceWorkers()[0]` returns the extension's service worker. `.evaluate(fn)` runs `fn` in its global scope.

**Requirement:** The target must be a top-level `function` declaration in `background.js` — not `const foo = () => {}`. See `mv3-background-service-worker.md` § 5.

```typescript
const [worker] = browserContext.serviceWorkers();

// No-arg call
await worker.evaluate(() =>
  (globalThis as unknown as { disableDriving: () => void }).disableDriving()
);

// With argument
await worker.evaluate(
  (id: number) =>
    (globalThis as unknown as { enableDriving: (id: number) => Promise<void> }).enableDriving(id),
  tabId
);
```

**When to use:** Any time a test needs to trigger driving-state changes without going through the popup UI. See `mv3-background-service-worker.md` § 6 for why the popup is problematic in tests.

---

## 7. Yield to the event loop after sending relay control messages

**Trap:** Sending `driving_enabled` then immediately sending an agent action is a race. The relay processes WS messages via async I/O — the agent action can arrive before the state update.

```typescript
// BROKEN — race condition
pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
agentSocket.send(JSON.stringify({ id: '1', type: 'read_html' })); // relay may not see driving=true yet
```

**Fix:** Add a short delay after every control message.

```typescript
// Unit tests (in-process relay): 10ms sufficient
// E2E tests (browser adds extra async hops): 50ms safer
function waitForRelayProcess(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
await waitForRelayProcess();
agentSocket.send(JSON.stringify({ id: '1', type: 'read_html' }));
```

Apply after every `driving_enabled` / `driving_disabled`, whether sent via mock socket or `worker.evaluate()`.

---

## 8. Use nested `test.describe` for phase-dependent tests

**Trap:** Tests that depend on feature state (enabled/disabled) in a flat describe share fragile ordering assumptions.

**Fix:** Nest describes. The outer `beforeAll` sets up shared fixtures without enabling optional features; inner describes opt in.

```typescript
test.describe('Plugin E2E', () => {
  let browserContext: BrowserContext;
  let agent: WsClient;

  test.beforeAll(async () => {
    // relay, browser, agent — driving NOT enabled
  });
  test.afterAll(async () => { /* teardown */ });

  // Outer: verify gate behavior
  test('rejects action when driving not enabled', async () => { ... });
  test('allows action after driving enabled', async () => { ... });
  test('rejects action after driving disabled', async () => { ... });

  // Inner: all action tests share one stable pinned tab
  test.describe('Actions', () => {
    let drivingPage: Page;

    test.beforeAll(async () => {
      drivingPage = await browserContext.newPage();
      await drivingPage.goto(`http://localhost:${testServerPort}/`);
      await enableDrivingOnWorker(worker);
    });

    test.afterAll(async () => {
      await disableDrivingOnWorker(worker);
      await drivingPage.close();
    });

    test('read_html', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/hello`);
      // test against drivingPage (the pinned tab)
    });
  });
});
```

**Rules:**
- Tests that modify driving state must leave it in a known state for the next test.
- Use one persistent `drivingPage` for all action tests — new pages are not the pinned tab.
- Navigate `drivingPage` via `drivingPage.goto()` to set up per-test content.
