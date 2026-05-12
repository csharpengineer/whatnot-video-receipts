// MV3 background service worker — handles chrome.downloads on behalf of content scripts
// (content scripts cannot call chrome.downloads directly)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Generic credentialed fetch proxy — content scripts in the isolated world are
  // distinguishable from real page requests and can get blocked by bot-protection
  // middleware (Kasada). Background service workers bypass that.
  if (msg.type === 'WN_FETCH') {
    const { url, method = 'GET', headers = {}, body = null } = msg;
    fetch(url, {
      method,
      credentials: 'include',
      headers,
      ...(body != null ? { body } : {}),
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get('content-type') || '';
        return ct.includes('json') ? r.json() : r.text();
      })
      .then(data => sendResponse({ data }))
      .catch(err => sendResponse({ error: String(err.message || err) }));
    return true;
  }

  // Fetch a cross-origin URL and return the text — content scripts are CORS-blocked
  // from S3, but background service workers are not.
  if (msg.type === 'WN_FETCH_CSV') {
    fetch(msg.url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(text => sendResponse({ text }))
      .catch(err => sendResponse({ error: String(err.message || err) }));
    return true; // keep channel open for async response
  }

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
