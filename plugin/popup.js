async function render() {
  const statusEl = document.getElementById('status');
  const button = document.getElementById('toggle-btn');

  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: 'get_status' });
  } catch {
    statusEl.textContent = 'Service worker not running.';
    statusEl.className = 'muted';
    button.disabled = true;
    button.textContent = 'Unavailable';
    return;
  }

  button.disabled = false;

  if (status.drivingEnabled) {
    statusEl.textContent = `Driving: ${status.activeTabUrl ? new URL(status.activeTabUrl).hostname : 'tab #' + status.pinnedTabId}`;
    statusEl.className = '';
    button.textContent = 'Disable Driving';
    button.className = 'danger';
    button.onclick = async () => {
      button.disabled = true;
      await chrome.runtime.sendMessage({ type: 'disable_driving' });
      await render();
    };
  } else {
    const hostname = status.activeTabUrl ? new URL(status.activeTabUrl).hostname : null;
    statusEl.textContent = hostname ? `Will pin: ${hostname}` : 'No active tab found.';
    statusEl.className = hostname ? '' : 'muted';
    button.textContent = 'Enable Driving';
    button.className = 'primary';
    button.disabled = !hostname;
    button.onclick = async () => {
      button.disabled = true;
      await chrome.runtime.sendMessage({ type: 'enable_driving' });
      await render();
    };
  }
}

document.addEventListener('DOMContentLoaded', render);
