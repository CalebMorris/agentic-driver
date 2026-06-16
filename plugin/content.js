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
