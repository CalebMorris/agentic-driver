# Playwright + Chrome Extension Testing

Pitfalls and correct patterns when testing MV3 Chrome extensions with Playwright.

---

## 1. `headless: true` silently breaks extension loading

**What happens:** Playwright 1.46+ ships two Chromium binaries:
- `chromium-XXXX/chrome-linux/chrome` — full browser, supports extensions
- `chromium_headless_shell-XXXX/...` — lightweight shell, **does not support extensions**

`headless: true` routes to the headless shell. Extensions appear to load (no error thrown), but the background service worker never registers, `waitForEvent('serviceworker')` hangs forever, and the context eventually closes with:

```
Error: browserContext.waitForEvent: Target page, context or browser has been closed
```

**Fix:** Force the full Chromium binary with `--headless=new` passed as an arg, while setting `headless: false` so Playwright does not add its own headless flags:

```typescript
browserContext = await chromium.launchPersistentContext(userDataDir, {
  headless: false,           // prevents Playwright routing to headless shell
  args: [
    '--headless=new',        // runs full Chromium in headless mode
    '--no-sandbox',          // required on Linux CI / non-root environments
    '--disable-setuid-sandbox',
    `--disable-extensions-except=${PLUGIN_PATH}`,
    `--load-extension=${PLUGIN_PATH}`,
  ],
});
```

---

## 2. Extension scripting APIs refuse `about:blank` pages

**What happens:** `chrome.scripting.executeScript` and `chrome.tabs.captureVisibleTab` cannot operate on `about:blank` or `chrome://` URLs. Playwright's `page.setContent()` writes to what is effectively an `about:blank` page — the URL never changes to a real origin. Calling any extension scripting API on it returns an `UNKNOWN` error from the plugin (the `executeScript` call itself throws internally).

**Symptom:** All `read_html`, `click`, and `screenshot` actions return `type: 'error', code: 'UNKNOWN'` even when the page visibly has content.

**Fix:** Navigate to a real `http://` URL before sending any action. Use a local HTTP server with path-based routes so each test gets specific content without network dependency:

```typescript
// In beforeAll
const routes: Record<string, string> = {
  '/hello':   '<html><body><h1>Hello World</h1></body></html>',
  '/button':  `<html><body><button id="btn" onclick="this.dataset.clicked='true'">Click</button></body></html>`,
  // ...
};
testServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(routes[req.url ?? '/'] ?? '<html><body></body></html>');
});
await new Promise<void>((resolve) => testServer.listen(0, 'localhost', () => resolve()));

// In each test — never page.setContent()
const page = await browserContext.newPage();
await page.goto(`http://localhost:${testServerPort}/hello`);
```

---

## 3. Relay server must be listening before the browser launches

**What happens:** `new WebSocketServer({ port })` starts listening asynchronously. If the browser is launched immediately after creating the server, the extension's background service worker may try to connect before the server is ready, fail silently, and never connect.

**Fix:** Wait for the `'listening'` event before calling `launchPersistentContext`:

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

**What happens:** `browserContext.waitForEvent('serviceworker')` fires when the service worker registers — but that is before `connect()` in `background.js` has finished establishing the WebSocket. Proceeding immediately after the service worker event means the relay has no plugin client yet, so the first agent message gets "Plugin is not connected" error.

**Fix:** Wait for the relay server to confirm the plugin connected:

```typescript
// Expose a promise from createRelayServer
await relay.waitForPlugin();    // resolves when /plugin WS handshake completes
agent = await connectClient('/agent');
```

---

## 5. Full working `beforeAll` skeleton

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
