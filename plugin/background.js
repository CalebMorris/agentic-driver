const WS_URL = 'ws://localhost:9999/plugin';

let socket = null;

// var so these are accessible as service-worker globals (e.g. from worker.evaluate in tests)
var pinnedTabId = null;
var drivingEnabled = false;

function connect() {
  socket = new WebSocket(WS_URL);

  socket.addEventListener('open', () => {
    console.log('[agentic-driver] Connected to relay server');
  });

  socket.addEventListener('message', async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      console.error('[agentic-driver] Invalid JSON received:', event.data);
      return;
    }

    const response = await handleMessage(message);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response));
    }
  });

  socket.addEventListener('close', () => {
    console.log('[agentic-driver] Disconnected from relay server');
    socket = null;
  });

  socket.addEventListener('error', (error) => {
    console.error('[agentic-driver] WebSocket error:', error);
  });
}

function sendControlMessage(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

async function enableDriving() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    pinnedTabId = tab.id;
    drivingEnabled = true;
    sendControlMessage({ type: 'driving_enabled', tabId: tab.id });
  }
}

function disableDriving() {
  pinnedTabId = null;
  drivingEnabled = false;
  sendControlMessage({ type: 'driving_disabled' });
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
      default:
        return errorResponse(id, 'UNKNOWN', `Unknown action type: ${type}`);
    }
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Unexpected error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPinnedTab() {
  if (!pinnedTabId) return null;
  try {
    return await chrome.tabs.get(pinnedTabId);
  } catch {
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

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (cssSelector) => {
      const element = document.querySelector(cssSelector);
      if (!element) return false;
      element.click();
      return true;
    },
    args: [selector],
  });

  if (!result?.result) {
    return errorResponse(id, 'ELEMENT_NOT_FOUND', `No element matches selector '${selector}'`);
  }

  return { id, type: 'result', data: { status: 'ok' } };
}

async function handleReadHtml(id, message) {
  const tab = await getPinnedTab();
  if (!tab) {
    return errorResponse(id, 'UNKNOWN', 'No tab is pinned for driving');
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      if (selector) {
        const element = document.querySelector(selector);
        return element ? element.outerHTML : null;
      }
      return document.documentElement.outerHTML;
    },
    args: [message.selector ?? null],
  });

  const html = result?.result;

  if (html === null || html === undefined) {
    return errorResponse(
      id,
      'ELEMENT_NOT_FOUND',
      `No element matches selector '${message.selector}'`
    );
  }

  return { id, type: 'result', data: { html } };
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
    return errorResponse(id, 'CAPTURE_FAILED', error.message ?? 'Screenshot failed');
  }
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

function errorResponse(id, code, message) {
  return { id, type: 'error', code, message };
}

connect();
