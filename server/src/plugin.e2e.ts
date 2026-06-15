import { test, expect, chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { createRelayServer } from './relay';

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

test.describe('Plugin E2E', () => {
  let relayWss: WebSocketServer;
  let browserContext: BrowserContext;
  let agent: WsClient;
  let testServer: http.Server;
  let testServerPort: number;
  let userDataDir: string;

  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(60_000);

    // Start relay and wait until it is actually listening before launching the browser
    const relay = createRelayServer(SERVER_PORT);
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

    // Wait for the plugin's service worker to connect to the relay
    await relay.waitForPlugin();

    // Connect the test agent
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
    };
    testServer = http.createServer((req, res) => {
      const html = routes[req.url ?? '/'] ?? routes['/'];
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
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

  // ── read_html ────────────────────────────────────────────────────────────

  test('read_html returns full page HTML', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/hello`);

    const response = await request(agent, { id: '1', type: 'read_html' }) as any;

    expect(response.id).toBe('1');
    expect(response.type).toBe('result');
    expect(response.data.html).toContain('<h1>Hello World</h1>');

    await page.close();
  });

  test('read_html with selector returns matching subtree', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/main`);

    const response = await request(agent, { id: '2', type: 'read_html', selector: '#main' }) as any;

    expect(response.type).toBe('result');
    expect(response.data.html).toContain('<p>Content</p>');
    expect(response.data.html).not.toContain('<body>');

    await page.close();
  });

  test('read_html with missing selector returns ELEMENT_NOT_FOUND', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/plain`);

    const response = await request(agent, { id: '3', type: 'read_html', selector: '#does-not-exist' }) as any;

    expect(response.type).toBe('error');
    expect(response.code).toBe('ELEMENT_NOT_FOUND');

    await page.close();
  });

  // ── navigate ─────────────────────────────────────────────────────────────

  test('navigate loads a URL and returns complete', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/`);
    const targetUrl = `http://localhost:${testServerPort}/navigate`;

    const response = await request(agent, { id: '4', type: 'navigate', url: targetUrl }) as any;

    expect(response.id).toBe('4');
    expect(response.type).toBe('result');
    expect(response.data.status).toBe('complete');
    expect(response.data.url).toContain(`localhost:${testServerPort}`);

    await page.close();
  });

  // ── click ─────────────────────────────────────────────────────────────────

  test('click triggers the element and returns ok', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/button`);

    const response = await request(agent, { id: '5', type: 'click', selector: '#btn' }) as any;

    expect(response.type).toBe('result');
    expect(response.data.status).toBe('ok');

    const wasClicked = await page.locator('#btn').getAttribute('data-clicked');
    expect(wasClicked).toBe('true');

    await page.close();
  });

  test('click with missing selector returns ELEMENT_NOT_FOUND', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/nobutton`);

    const response = await request(agent, { id: '6', type: 'click', selector: '#missing-btn' }) as any;

    expect(response.type).toBe('error');
    expect(response.code).toBe('ELEMENT_NOT_FOUND');

    await page.close();
  });

  // ── screenshot ────────────────────────────────────────────────────────────

  test('screenshot returns a base64-encoded PNG', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/capture`);

    const response = await request(agent, { id: '7', type: 'screenshot' }) as any;

    expect(response.type).toBe('result');
    expect(typeof response.data.image).toBe('string');
    // PNG magic bytes in base64 always start with 'iVBOR'
    expect(response.data.image).toMatch(/^iVBOR/);

    await page.close();
  });

  // ── unknown action ────────────────────────────────────────────────────────

  test('unknown action type returns UNKNOWN error', async () => {
    const page = await browserContext.newPage();
    await page.goto(`http://localhost:${testServerPort}/`);

    const response = await request(agent, { id: '8', type: 'nonexistent_action' }) as any;

    expect(response.type).toBe('error');
    expect(response.code).toBe('UNKNOWN');

    await page.close();
  });
});
