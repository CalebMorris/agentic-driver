const WS_URL = 'ws://localhost:9999/plugin';

let socket = null;

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

async function handleMessage(message) {
  const { id, type } = message;

  try {
    switch (type) {
      case 'navigate':   return await handleNavigate(id, message);
      case 'click':      return await handleClick(id, message);
      case 'read_html':  return await handleReadHtml(id, message);
      case 'screenshot': return await handleScreenshot(id);
      default:
        return errorResponse(id, 'UNKNOWN', `Unknown action type: ${type}`);
    }
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Unexpected error');
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleNavigate(id, message) {
  const { url } = message;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return errorResponse(id, 'UNKNOWN', 'No active tab found');
  }

  try {
    // Register listener before update to avoid missing the complete event
    const loadComplete = waitForTabComplete(tab.id);
    await chrome.tabs.update(tab.id, { url });
    await loadComplete;

    const [updatedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { id, type: 'result', data: { url: updatedTab?.url ?? url, status: 'complete' } };
  } catch (error) {
    return errorResponse(id, 'NAVIGATION_FAILED', error.message ?? 'Navigation failed');
  }
}

async function handleClick(id, message) {
  const { selector } = message;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return errorResponse(id, 'UNKNOWN', 'No active tab found');
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return errorResponse(id, 'UNKNOWN', 'No active tab found');
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
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
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

    // Register the listener before calling tabs.update so we cannot miss the event.
    // No early-complete shortcut: the tab is always in 'complete' state before
    // navigation starts, so checking it immediately would resolve before the
    // navigation even begins.
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function errorResponse(id, code, message) {
  return { id, type: 'error', code, message };
}

connect();
