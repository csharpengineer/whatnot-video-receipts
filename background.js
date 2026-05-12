// MV3 background service worker — handles chrome.downloads on behalf of content scripts
// (content scripts cannot call chrome.downloads directly)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'download') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename },
      (id) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ id });
        }
      }
    );
    return true; // keep channel open for async callback
  }
});
