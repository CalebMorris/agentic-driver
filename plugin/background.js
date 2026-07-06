const WS_URL = 'ws://localhost:9999/plugin';
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const KEEP_ALIVE_ALARM = 'agentic-driver-keep-alive';

let socket = null;
var reconnectDelayMs = RECONNECT_BASE_DELAY_MS;

// var so these are accessible as service-worker globals (e.g. from worker.evaluate in tests)
var pinnedTabId = null;
var drivingEnabled = false;
var handoffPending = false;
var handoffReason = null;

// Persist driving state so it survives MV3 service worker termination.
async function saveState() {
  await chrome.storage.session.set({ drivingEnabled, pinnedTabId });
}

// Called at module level on every service worker startup. If driving was active before
// the worker was terminated, this reconnects the WebSocket and restores state.
async function restoreStateFromStorage() {
  const stored = await chrome.storage.session.get(['drivingEnabled', 'pinnedTabId']);
  if (stored.drivingEnabled && !socket) {
    drivingEnabled = stored.drivingEnabled;
    pinnedTabId = stored.pinnedTabId;
    updateActionIcon(true);
    reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
    connect();
  }
}

// Test helper: atomically reset in-memory state (as Chrome does on SW termination)
// then immediately restore from storage (as module-level startup code does on restart).
// Using a single evaluate() prevents the SW from being truly terminated between the two steps.
async function simulateWorkerRestart() {
  drivingEnabled = false;
  pinnedTabId = null;
  handoffPending = false;
  handoffReason = null;
  if (socket) {
    socket.close();
    socket = null;
  }
  await restoreStateFromStorage();
}

function connect() {
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    console.log('[agentic-driver] Connected to relay server');
    reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
    if (drivingEnabled && pinnedTabId !== null) {
      ws.send(JSON.stringify({ type: 'driving_enabled', tabId: pinnedTabId }));
    }
  });

  ws.addEventListener('message', async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      logToRelay('error', 'ws_message_parse_error', { data: String(event.data).slice(0, 200), error: error?.message });
      return;
    }

    if (message.type === 'server_closing') {
      console.log('[agentic-driver] Relay server is shutting down — disabling driving');
      pinnedTabId = null;
      drivingEnabled = false;
      updateActionIcon(false);
      saveState();
      chrome.alarms.clear(KEEP_ALIVE_ALARM);
      socket = null;
      ws.close();
      return;
    }

    const response = await handleMessage(message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    console.log('[agentic-driver] Disconnected from relay server');
    socket = null;
    scheduleReconnect();
  });

  ws.addEventListener('error', (error) => {
    console.error('[agentic-driver] WebSocket error:', error);
    // close event fires after error and triggers reconnect
  });
}

function scheduleReconnect() {
  if (!drivingEnabled) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  console.log(`[agentic-driver] Reconnecting in ${delay}ms`);
  setTimeout(connect, delay);
}

function sendControlMessage(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// Log to the console and mirror to the relay as a 'log' message, which the
// relay writes to relay.log server-side without forwarding to the agent.
// The relay send silently no-ops when the socket is down, so this is safe to
// call from connection-failure paths.
function logToRelay(level, event, context = {}) {
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[agentic-driver] ${event}`, context);
  sendControlMessage({ type: 'log', level, event, context });
}

function updateActionIcon(isActive) {
  const color = isActive ? '#dc2626' : '#6b7280';
  const imageDataBySize = {};
  for (const size of [16, 32, 48]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI);
    ctx.fill();
    imageDataBySize[size] = ctx.getImageData(0, 0, size, size);
  }
  chrome.action.setIcon({ imageData: imageDataBySize });
}

async function enableDriving() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    pinnedTabId = tab.id;
    drivingEnabled = true;
    updateActionIcon(true);
    await saveState();
    chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
    reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
    if (!socket) {
      connect();
    }
    // driving_enabled is sent in the socket's open handler once connected
  }
}

function disableDriving() {
  pinnedTabId = null;
  drivingEnabled = false;
  updateActionIcon(false);
  saveState();
  chrome.alarms.clear(KEEP_ALIVE_ALARM);
  sendControlMessage({ type: 'driving_disabled' });
  if (socket) {
    socket.close();
    socket = null;
  }
}

// Handle messages from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'get_status') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({
        drivingEnabled,
        pinnedTabId,
        activeTabId: tab?.id ?? null,
        activeTabUrl: tab?.url ?? null,
        handoffPending,
        handoffReason,
      });
    });
    return true; // async response
  }
  if (message.type === 'enable_driving') {
    enableDriving().then(() => sendResponse({ success: true }));
    return true; // async response
  }
  if (message.type === 'disable_driving') {
    disableDriving();
    sendResponse({ success: true });
  }
  if (message.type === 'complete_handoff') {
    handoffPending = false;
    handoffReason = null;
    chrome.action.setBadgeText({ text: '' });
    sendControlMessage({ type: 'handoff_complete' });
    sendResponse({ success: true });
  }
});

// Disable driving automatically when the pinned tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === pinnedTabId) {
    disableDriving();
  }
});

async function handleMessage(message) {
  const { id, type } = message;

  try {
    switch (type) {
      case 'view_current_site': return await handleViewCurrentSite(id);
      case 'navigate':          return await handleNavigate(id, message);
      case 'click':             return await handleClick(id, message);
      case 'read_html':         return await handleReadHtml(id, message);
      case 'screenshot':        return await handleScreenshot(id);
      case 'bundle':            return await handleBundle(id);
      case 'handoff':           return await handleHandoff(id, message);
      default:
        return errorResponse(id, 'UNKNOWN', `Unknown action type: ${type}`);
    }
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Unexpected error', { action: type, stack: error.stack });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPinnedTab() {
  if (!pinnedTabId) return null;
  try {
    return await chrome.tabs.get(pinnedTabId);
  } catch (error) {
    logToRelay('warn', 'pinned_tab_lookup_failed', { tabId: pinnedTabId, error: error?.message });
    return null;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleViewCurrentSite(id) {
  const tab = await getPinnedTab();
  if (!tab) {
    return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  }
  return {
    id,
    type: 'result',
    data: {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      active: tab.active,
      faviconUrl: tab.favIconUrl ?? null,
    },
  };
}

async function handleNavigate(id, message) {
  const { url } = message;
  const tab = await getPinnedTab();
  if (!tab) {
    return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  }

  try {
    // Register listener before update to avoid missing the complete event
    const loadComplete = waitForTabComplete(tab.id);
    await chrome.tabs.update(tab.id, { url });
    await loadComplete;

    const updatedTab = await chrome.tabs.get(tab.id);
    return { id, type: 'result', data: { url: updatedTab?.url ?? url, status: 'complete' } };
  } catch (error) {
    return errorResponse(id, 'NAVIGATION_FAILED', error.message ?? 'Navigation failed');
  }
}

async function handleClick(id, message) {
  const { selector } = message;
  const tab = await getPinnedTab();
  if (!tab) {
    return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  }

  let result;
  try {
    result = await chrome.tabs.sendMessage(tab.id, { type: 'click', selector });
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Message delivery failed');
  }

  if (!result?.success) {
    return errorResponse(id, result?.errorCode ?? 'UNKNOWN', result?.errorMessage ?? 'Click failed');
  }

  return { id, type: 'result', data: { status: 'ok' } };
}

async function handleReadHtml(id, message) {
  const tab = await getPinnedTab();
  if (!tab) {
    return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  }

  let result;
  try {
    result = await chrome.tabs.sendMessage(tab.id, { type: 'read_html', selector: message.selector ?? null });
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Message delivery failed');
  }

  if (!result?.success) {
    return errorResponse(id, result?.errorCode ?? 'UNKNOWN', result?.errorMessage ?? 'Read HTML failed');
  }

  return { id, type: 'result', data: { html: result.html } };
}

async function handleScreenshot(id) {
  const tab = await getPinnedTab();
  if (!tab) {
    return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // Strip the "data:image/png;base64," prefix
    const base64Image = dataUrl.replace(/^data:image\/png;base64,/, '');
    return { id, type: 'result', data: { image: base64Image } };
  } catch (error) {
    // tabActive/windowId reveal the usual cause: the pinned tab is not the
    // active tab of a visible window, so Chrome refuses the capture.
    return errorResponse(id, 'CAPTURE_FAILED', error.message ?? 'Screenshot failed', {
      action: 'screenshot',
      tabId: tab.id,
      windowId: tab.windowId,
      tabActive: tab.active,
      tabStatus: tab.status,
    });
  }
}

async function handleBundle(id) {
  const tab = await getPinnedTab();
  if (!tab) {
    return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  }

  let collected;
  try {
    collected = await chrome.tabs.sendMessage(tab.id, { type: 'collect_bundle' });
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Message delivery failed');
  }
  if (!collected?.success) {
    return errorResponse(id, collected?.errorCode ?? 'UNKNOWN', collected?.errorMessage ?? 'Bundle collection failed');
  }

  // The live DOM is the archive's entry point.
  const files = [{ path: 'index.html', bytes: new TextEncoder().encode(collected.html) }];

  // Fetch every loaded subresource from the background worker (bypasses page CORS).
  // A single resource that fails (opaque response, 404, unsupported scheme) is skipped
  // rather than failing the whole bundle.
  const seenPaths = new Set(['index.html']);
  for (const resourceUrl of collected.resources ?? []) {
    try {
      const bytes = await fetchResourceBytes(resourceUrl);
      if (!bytes) continue;
      const archivePath = resourceUrlToArchivePath(resourceUrl, seenPaths);
      seenPaths.add(archivePath);
      files.push({ path: archivePath, bytes });
    } catch (error) {
      logToRelay('warn', 'bundle_resource_fetch_failed', { url: resourceUrl, error: error?.message });
    }
  }

  let zipBytes;
  try {
    zipBytes = await buildZipArchive(files);
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Failed to build zip archive');
  }

  return {
    id,
    type: 'result',
    data: {
      zip: bytesToBase64(zipBytes),
      url: collected.baseUrl,
      fileCount: files.length,
      byteSize: zipBytes.length,
    },
  };
}

async function handleHandoff(id, message) {
  handoffPending = true;
  handoffReason = message.reason ?? null;
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  return { id, type: 'result', data: { status: 'waiting_for_human' } };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function errorResponse(id, code, message, context = {}) {
  logToRelay('error', 'action_error', { id, code, message, ...context });
  return { id, type: 'error', code, message };
}

// ── Bundle helpers ──────────────────────────────────────────────────────────────

// Fetch a subresource as raw bytes. Returns null for schemes we can't archive
// (data:, blob:, chrome-extension:) or non-OK responses.
async function fetchResourceBytes(url) {
  if (!/^https?:/i.test(url)) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

// Map a resource URL to a stable, sanitized, unique path inside the archive,
// e.g. https://ex.com/css/main.css?v=2 -> ex.com/css/main.css
function resourceUrlToArchivePath(rawUrl, seenPaths) {
  let candidate;
  try {
    const parsed = new URL(rawUrl);
    let pathname = parsed.pathname;
    if (pathname === '' || pathname.endsWith('/')) pathname += 'index';
    candidate = `${parsed.hostname}${pathname}`;
  } catch (error) {
    logToRelay('warn', 'archive_path_url_parse_failed', { url: rawUrl, error: error?.message });
    candidate = 'resource';
  }
  candidate = candidate.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._/-]/g, '_');
  if (candidate === '') candidate = 'resource';

  let unique = candidate;
  let counter = 1;
  while (seenPaths.has(unique)) {
    unique = `${candidate}.${counter}`;
    counter += 1;
  }
  return unique;
}

// Base64-encode a Uint8Array in chunks so large archives don't overflow the
// call stack via String.fromCharCode(...spread).
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

var crc32Table = null;
function crc32(bytes) {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Raw DEFLATE via the service worker's built-in CompressionStream.
async function deflateRaw(bytes) {
  const compressedStream = new Response(bytes).body.pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = await new Response(compressedStream).arrayBuffer();
  return new Uint8Array(compressed);
}

// Build a valid ZIP archive (method 8 / DEFLATE) from [{ path, bytes }] entries.
async function buildZipArchive(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const uncompressedSize = file.bytes.length;
    const compressed = await deflateRaw(file.bytes);
    const compressedSize = compressed.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);  // local file header signature
    lv.setUint16(4, 20, true);          // version needed to extract
    lv.setUint16(6, 0, true);           // general purpose flags
    lv.setUint16(8, 8, true);           // compression method: deflate
    lv.setUint16(10, 0, true);          // mod time
    lv.setUint16(12, 0, true);          // mod date
    lv.setUint32(14, crc, true);        // crc-32 of uncompressed data
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, compressed);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);  // central directory header signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed to extract
    cv.setUint16(8, 0, true);           // general purpose flags
    cv.setUint16(10, 8, true);          // compression method: deflate
    cv.setUint16(12, 0, true);          // mod time
    cv.setUint16(14, 0, true);          // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);          // extra field length
    cv.setUint16(32, 0, true);          // comment length
    cv.setUint16(34, 0, true);          // disk number start
    cv.setUint16(36, 0, true);          // internal attributes
    cv.setUint32(38, 0, true);          // external attributes
    cv.setUint32(42, offset, true);     // relative offset of local header
    centralHeader.set(nameBytes, 46);
    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  const centralSize = centralHeaders.reduce((sum, header) => sum + header.length, 0);
  const centralOffset = offset;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);    // end of central directory signature
  ev.setUint16(4, 0, true);             // disk number
  ev.setUint16(6, 0, true);             // disk with central directory
  ev.setUint16(8, files.length, true);  // entries on this disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);            // comment length

  const totalSize = offset + centralSize + end.length;
  const archive = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of localParts) { archive.set(part, pos); pos += part.length; }
  for (const header of centralHeaders) { archive.set(header, pos); pos += header.length; }
  archive.set(end, pos);
  return archive;
}

// Reconnect if the service worker was restarted by the keep-alive alarm.
// The alarm is only active while driving is enabled (created in enableDriving,
// cleared in disableDriving), so the worker idles normally when not driving.
chrome.alarms.onAlarm.addListener(() => restoreStateFromStorage());

updateActionIcon(false);
restoreStateFromStorage();
