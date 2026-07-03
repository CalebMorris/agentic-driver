import { test, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { createRelayServer, RelayServer } from './relay';

const PLUGIN_PATH = path.resolve(__dirname, '../../plugin');
const SERVER_PORT = 9999;

function connectClient(clientPath: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://localhost:${SERVER_PORT}${clientPath}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Send one message, await the single response
function request(agent: WsClient, message: object): Promise<unknown> {
  return new Promise((resolve) => {
    agent.once('message', (data) => resolve(JSON.parse(data.toString())));
    agent.send(JSON.stringify(message));
  });
}

// Yield to the event loop so the relay can process an in-flight message.
function waitForRelayProcess(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 50));
}

// Enable driving on the service worker for the currently active tab.
async function enableDrivingOnWorker(worker: Worker): Promise<void> {
  await worker.evaluate(() => (globalThis as unknown as { enableDriving: () => Promise<void> }).enableDriving());
  await waitForRelayProcess();
}

async function disableDrivingOnWorker(worker: Worker): Promise<void> {
  await worker.evaluate(() => (globalThis as unknown as { disableDriving: () => void }).disableDriving());
  await waitForRelayProcess();
}

test.describe('Plugin E2E', () => {
  let relay: RelayServer;
  let relayWss: WebSocketServer;
  let browserContext: BrowserContext;
  let agent: WsClient;
  let testServer: http.Server;
  let testServerPort: number;
  let userDataDir: string;

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(60_000);

    // Start relay and wait until it is actually listening before launching the browser
    relay = createRelayServer(SERVER_PORT);
    relayWss = relay.wss;
    await new Promise<void>((resolve) => {
      if (relayWss.address()) resolve();
      else relayWss.once('listening', resolve);
    });

    // Use headless: false + --headless=new so Playwright picks the full Chromium
    // binary (chromium-XXXX) instead of chromium_headless_shell, which does not
    // support Chrome extensions.
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-driver-e2e-'));
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

    // Connect the test agent — the plugin only connects to the relay once driving is enabled
    agent = await connectClient('/agent');

    // Local HTTP server with path-based content so every test page is on a
    // real HTTP URL — chrome.scripting.executeScript cannot inject into about:blank.
    const routes: Record<string, string> = {
      '/':          '<html><body><h1>Test Page</h1></body></html>',
      '/hello':     '<html><body><h1>Hello World</h1></body></html>',
      '/main':      '<html><body><div id="main"><p>Content</p></div><div id="other">Other</div></body></html>',
      '/plain':     '<html><body><p>Hello</p></body></html>',
      '/button':    `<html><body><button id="btn" onclick="this.dataset.clicked='true'">Click me</button></body></html>`,
      '/nobutton':  '<html><body><p>No button here</p></body></html>',
      '/capture':   '<html><body><h1>Screenshot test</h1></body></html>',
      '/navigate':  '<html><body><h1>Navigation target</h1></body></html>',
      '/view':      '<html><head><title>View Test Page</title></head><body><h1>View</h1></body></html>',
      '/bundle':    '<html><head><link rel="stylesheet" href="/bundle.css"></head><body><h1>Bundle Me</h1></body></html>',
      '/bundle.css': 'h1 { color: rebeccapurple; }',
    };
    testServer = http.createServer((req, res) => {
      const requestPath = req.url ?? '/';
      const body = routes[requestPath] ?? routes['/'];
      const contentType = requestPath.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(body);
    });
    await new Promise<void>((resolve) => testServer.listen(0, 'localhost', () => resolve()));
    testServerPort = (testServer.address() as AddressInfo).port;
  });

  test.afterAll(async () => {
    agent?.close();
    await browserContext?.close();
    await new Promise<void>((resolve) => relayWss.close(() => resolve()));
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // ── Plugin Connection Gate ────────────────────────────────────────────────
  // Verify the plugin does not open a relay WebSocket until driving is enabled.

  test('plugin is not connected to relay before driving is enabled', async () => {
    await waitForRelayProcess();
    expect(relay.isPluginConnected()).toBe(false);
  });

  test('plugin connects to relay when driving is enabled', async () => {
    const [worker] = browserContext.serviceWorkers();
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/`);

    const pluginConnected = relay.waitForPluginConnect();
    await enableDrivingOnWorker(worker);
    await pluginConnected;

    expect(relay.isPluginConnected()).toBe(true);

    await disableDrivingOnWorker(worker);
    await page.close();
  });

  test('plugin disconnects from relay when driving is disabled', async () => {
    const [worker] = browserContext.serviceWorkers();
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/`);

    await enableDrivingOnWorker(worker);
    await relay.waitForPluginConnect();

    const pluginDisconnected = relay.waitForPluginDisconnect();
    await disableDrivingOnWorker(worker);
    await pluginDisconnected;

    expect(relay.isPluginConnected()).toBe(false);

    await page.close();
  });

  test('resumes driving after service worker state is reset (simulated restart)', async () => {
    const [worker] = browserContext.serviceWorkers();
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/`);

    const pluginConnected = relay.waitForPluginConnect();
    await enableDrivingOnWorker(worker);
    await pluginConnected;
    expect(relay.isPluginConnected()).toBe(true);

    // simulateWorkerRestart() atomically resets in-memory state (as Chrome does on SW
    // termination) then immediately calls restoreStateFromStorage() (as module-level
    // startup code does on restart). A single evaluate() keeps the worker alive throughout.
    const pluginDisconnected = relay.waitForPluginDisconnect();
    await worker.evaluate(() =>
      (globalThis as unknown as { simulateWorkerRestart: () => Promise<void> }).simulateWorkerRestart()
    );
    await pluginDisconnected;

    // After restart the plugin must have reconnected to the relay with driving re-enabled.
    await relay.waitForPluginConnect();
    expect(relay.isPluginConnected()).toBe(true);

    // Driving actions must still work after reconnection.
    await waitForRelayProcess();
    const response = await request(agent, { id: 'sw1', type: 'read_html' }) as Record<string, unknown>;
    expect(response.type).toBe('result');

    await disableDrivingOnWorker(worker);
    await page.close();
  });

  // ── Phase 0: Driving Gate ─────────────────────────────────────────────────
  // These tests run before any driving is enabled.

  test('agent action is rejected when driving is not enabled', async () => {
    const response = await request(agent, { id: 'g1', type: 'read_html' }) as Record<string, string>;

    expect(response.type).toBe('error');
    expect(response.code).toBe('DRIVING_DISABLED');
  });

  test('agent action succeeds after driving is enabled', async () => {
    const [worker] = browserContext.serviceWorkers();
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/hello`);

    await enableDrivingOnWorker(worker);

    const response = await request(agent, { id: 'g2', type: 'read_html' }) as Record<string, unknown>;

    expect(response.type).toBe('result');
    expect((response.data as Record<string, string>).html).toContain('<h1>Hello World</h1>');

    await page.close();
  });

  test('agent action is rejected again after driving is disabled', async () => {
    const [worker] = browserContext.serviceWorkers();
    await disableDrivingOnWorker(worker);

    const response = await request(agent, { id: 'g3', type: 'read_html' }) as Record<string, string>;

    expect(response.type).toBe('error');
    expect(response.code).toBe('DRIVING_DISABLED');
  });

  // ── Actions (driving enabled on a persistent pinned tab) ──────────────────
  // All action tests share a single driving page. Driving is enabled in beforeAll
  // and the same tab is used for the duration of this section.

  test.describe('Actions', () => {
    let drivingPage: Page;

    test.beforeAll(async () => {
      const [worker] = browserContext.serviceWorkers();

      drivingPage = await browserContext.newPage();
      await drivingPage.goto(`http://localhost:${testServerPort}/`);

      await enableDrivingOnWorker(worker);
    });

    test.afterAll(async () => {
      const [worker] = browserContext.serviceWorkers();
      await disableDrivingOnWorker(worker);
      await drivingPage.close();
    });

    // ── view_current_site ───────────────────────────────────────────────────

    test('view_current_site returns pinned tab info', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/view`);

      const response = await request(agent, { id: 'v1', type: 'view_current_site' }) as Record<string, unknown>;

      expect(response.type).toBe('result');
      const data = response.data as Record<string, unknown>;
      expect(typeof data.id).toBe('number');
      expect((data.url as string)).toContain(`localhost:${testServerPort}/view`);
      expect(data.title).toBe('View Test Page');
    });

    // ── read_html ───────────────────────────────────────────────────────────

    test('read_html returns full page HTML', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/hello`);

      const response = await request(agent, { id: '1', type: 'read_html' }) as Record<string, unknown>;

      expect(response.id).toBe('1');
      expect(response.type).toBe('result');
      expect((response.data as Record<string, string>).html).toContain('<h1>Hello World</h1>');
    });

    test('read_html with selector returns matching subtree', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/main`);

      const response = await request(agent, { id: '2', type: 'read_html', selector: '#main' }) as Record<string, unknown>;

      expect(response.type).toBe('result');
      const html = (response.data as Record<string, string>).html;
      expect(html).toContain('<p>Content</p>');
      expect(html).not.toContain('<body>');
    });

    test('read_html with missing selector returns ELEMENT_NOT_FOUND', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/plain`);

      const response = await request(agent, { id: '3', type: 'read_html', selector: '#does-not-exist' }) as Record<string, string>;

      expect(response.type).toBe('error');
      expect(response.code).toBe('ELEMENT_NOT_FOUND');
    });

    // ── navigate ────────────────────────────────────────────────────────────

    test('navigate loads a URL and returns complete', async () => {
      const targetUrl = `http://localhost:${testServerPort}/navigate`;

      const response = await request(agent, { id: '4', type: 'navigate', url: targetUrl }) as Record<string, unknown>;

      expect(response.id).toBe('4');
      expect(response.type).toBe('result');
      expect((response.data as Record<string, string>).status).toBe('complete');
      expect((response.data as Record<string, string>).url).toContain(`localhost:${testServerPort}`);
    });

    // ── click ───────────────────────────────────────────────────────────────

    test('click triggers the element and returns ok', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/button`);

      const response = await request(agent, { id: '5', type: 'click', selector: '#btn' }) as Record<string, unknown>;

      expect(response.type).toBe('result');
      expect((response.data as Record<string, string>).status).toBe('ok');

      const wasClicked = await drivingPage.locator('#btn').getAttribute('data-clicked');
      expect(wasClicked).toBe('true');
    });

    test('click with missing selector returns ELEMENT_NOT_FOUND', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/nobutton`);

      const response = await request(agent, { id: '6', type: 'click', selector: '#missing-btn' }) as Record<string, string>;

      expect(response.type).toBe('error');
      expect(response.code).toBe('ELEMENT_NOT_FOUND');
    });

    // ── screenshot ──────────────────────────────────────────────────────────

    test('screenshot returns a base64-encoded PNG', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/capture`);

      const response = await request(agent, { id: '7', type: 'screenshot' }) as Record<string, unknown>;

      expect(response.type).toBe('result');
      const image = (response.data as Record<string, string>).image;
      expect(typeof image).toBe('string');
      // PNG magic bytes in base64 always start with 'iVBOR'
      expect(image).toMatch(/^iVBOR/);
    });

    // ── bundle ────────────────────────────────────────────────────────────────

    test('bundle returns a deflate-compressed zip of the DOM and loaded resources', async () => {
      await drivingPage.goto(`http://localhost:${testServerPort}/bundle`);

      const response = await request(agent, { id: 'b1', type: 'bundle' }) as Record<string, unknown>;

      expect(response.type).toBe('result');
      const data = response.data as { zip: string; url: string; fileCount: number; byteSize: number };
      expect(typeof data.zip).toBe('string');
      // index.html + the stylesheet (there may be more, e.g. favicon)
      expect(data.fileCount).toBeGreaterThanOrEqual(2);

      const buffer = Buffer.from(data.zip, 'base64');
      // Local file header magic 'PK\x03\x04'
      expect([...buffer.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

      // Entry names are stored uncompressed in the headers.
      const headerText = buffer.toString('latin1');
      expect(headerText).toContain('index.html');
      expect(headerText).toContain('bundle.css');

      // Prove DEFLATE round-trips: inflate the first entry (always index.html) and
      // verify it holds the live DOM.
      const nameLength = buffer.readUInt16LE(26);
      const extraLength = buffer.readUInt16LE(28);
      const compressedSize = buffer.readUInt32LE(18);
      const dataStart = 30 + nameLength + extraLength;
      const inflated = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize));
      expect(inflated.toString('utf8')).toContain('<h1>Bundle Me</h1>');
    });

    // ── unknown action ──────────────────────────────────────────────────────

    test('unknown action type returns UNKNOWN error', async () => {
      const response = await request(agent, { id: '8', type: 'nonexistent_action' }) as Record<string, string>;

      expect(response.type).toBe('error');
      expect(response.code).toBe('UNKNOWN');
    });
  });
});
