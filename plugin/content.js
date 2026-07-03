chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'click') {
    const element = document.querySelector(message.selector);
    if (!element) {
      sendResponse({ success: false, errorCode: 'ELEMENT_NOT_FOUND', errorMessage: `No element matches selector '${message.selector}'` });
    } else {
      element.click();
      sendResponse({ success: true });
    }
    return;
  }

  if (message.type === 'collect_bundle') {
    // performance resource timing lists every subresource the browser loaded for
    // this document (CSS, JS, images, fonts). It resets per navigation, so it
    // reflects only the current page. The background worker fetches these URLs —
    // it holds <all_urls> host permission and so bypasses the page's CORS rules.
    const resources = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name))];
    sendResponse({
      success: true,
      html: document.documentElement.outerHTML,
      baseUrl: location.href,
      resources,
    });
    return;
  }

  if (message.type === 'read_html') {
    if (message.selector) {
      const element = document.querySelector(message.selector);
      if (!element) {
        sendResponse({ success: false, errorCode: 'ELEMENT_NOT_FOUND', errorMessage: `No element matches selector '${message.selector}'` });
      } else {
        sendResponse({ success: true, html: element.outerHTML });
      }
    } else {
      sendResponse({ success: true, html: document.documentElement.outerHTML });
    }
    return;
  }
});
