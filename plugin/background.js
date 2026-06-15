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
      case 'read_html':
        return await handleReadHtml(id, message);
      default:
        return errorResponse(id, 'UNKNOWN', `Unknown action type: ${type}`);
    }
  } catch (error) {
    return errorResponse(id, 'UNKNOWN', error.message ?? 'Unexpected error');
  }
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

function errorResponse(id, code, message) {
  return { id, type: 'error', code, message };
}

connect();
