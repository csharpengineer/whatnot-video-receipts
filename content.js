(() => {
  'use strict';

  const BTN_ID = 'wn-video-receipt-btn';

  // ── Inject hls.js then the page-context helper script ──────────────────────
  const hlsScript = document.createElement('script');
  hlsScript.src = chrome.runtime.getURL('hls.min.js');
  (document.head || document.documentElement).appendChild(hlsScript);

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ── IPC with injected.js (runs in MAIN world via manifest content_scripts) ─
  function getOrderUuid() {
    const m = window.location.pathname.match(/^\/order\/([^/]+)/);
    return m ? m[1] : null;
  }

  const pendingResolvers = {};
  window.addEventListener('__whatnot_ext_response__', (evt) => {
    const { requestId, ...payload } = evt.detail;
    if (pendingResolvers[requestId]) {
      pendingResolvers[requestId](payload);
      delete pendingResolvers[requestId];
    }
  });

  function requestVideoReceipt(orderUuid) {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).slice(2);
      pendingResolvers[requestId] = resolve;
      window.dispatchEvent(
        new CustomEvent('__whatnot_ext_request__', {
          detail: { orderUuid, requestId },
        })
      );
    });
  }

  // ── Build action-item button (matches native item style) ──────────────────
  function createActionButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    // Play-circle SVG (outlined, 24×24 — matches Whatnot icon style)
    const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="fill-neutrals-opaque-900" role="presentation">
      <path d="M10 8.3 16.4 12 10 15.7V8.3z"/>
      <path fill-rule="evenodd" d="M12 23C5.925 23 1 18.075 1 12S5.925 1 12 1s11 4.925 11 11-4.925 11-11 11zm0-2a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" clip-rule="evenodd"/>
    </svg>`;
    // Chevron-right SVG (matches native chevron)
    const chevronSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="fill-neutrals-opaque-900" role="presentation">
      <path fill-rule="evenodd" d="M9.293 17.707a1 1 0 0 1 0-1.414L13.586 12 9.293 7.707a1 1 0 1 1 1.414-1.414L15 10.586a2 2 0 0 1 0 2.828l-4.293 4.293a1 1 0 0 1-1.414 0" clip-rule="evenodd"/>
    </svg>`;

    btn.innerHTML = `
      <div class="flex basis-auto items-center gap-3">
        <div class="size-12 shrink-0 rounded-full bg-neutrals-opaque-50 p-3">
          <div class="shrink-0">${iconSvg}</div>
        </div>
        <div class="w-full">
          <strong id="wn-btn-label" class="text-current block font-sans text-body1 leading-body1 font-semibold text-pretty">Watch video receipt</strong>
          <strong class="text-neutrals-opaque-700 dark:text-neutrals-opaque-200 block text-body1 leading-body1 font-regular text-pretty"></strong>
        </div>
        <div class="shrink-0">
          <div class="shrink-0">${chevronSvg}</div>
        </div>
      </div>`;

    btn.addEventListener('click', onButtonClick);
    return btn;
  }

  // ── Find the actions section (contains "Message seller") ──────────────────
  function findActionsSection() {
    for (const el of document.querySelectorAll('a, button')) {
      if (el.textContent.includes('Message seller')) {
        let node = el;
        while (node && node.tagName !== 'SECTION') node = node.parentElement;
        if (node) return node;
      }
    }
    return null;
  }

  // ── Inject + watchdog ─────────────────────────────────────────────────────
  let sectionObserver = null;

  function injectIntoSection(section) {
    if (section.querySelector('#' + BTN_ID)) return; // already present
    section.appendChild(createActionButton());

    // Re-inject if React wipes our node from this section
    if (sectionObserver) sectionObserver.disconnect();
    sectionObserver = new MutationObserver(() => {
      if (!section.isConnected) {
        sectionObserver.disconnect();
        sectionObserver = null;
        return;
      }
      if (!section.querySelector('#' + BTN_ID)) {
        section.appendChild(createActionButton());
      }
    });
    sectionObserver.observe(section, { childList: true });
  }

  // Body-level observer: fires when the section first appears (or reappears)
  const bodyObserver = new MutationObserver(() => {
    const section = findActionsSection();
    if (section) injectIntoSection(section);
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  // Also try immediately (page may already be rendered)
  const existingSection = findActionsSection();
  if (existingSection) injectIntoSection(existingSection);

  // ── Button click handler ──────────────────────────────────────────────────
  async function onButtonClick() {
    const uuid = getOrderUuid();
    if (!uuid) { showError('Could not determine the order ID from the URL.'); return; }

    const label = document.getElementById('wn-btn-label');
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.disabled = true;
    if (label) label.textContent = '⏳ Loading…';

    const result = await requestVideoReceipt(uuid);

    if (btn) btn.disabled = false;
    if (label) label.textContent = 'Watch video receipt';

    if (result.error) { showError(result.error); return; }
    openOverlay(result); // result has { indexUrl, timeOffset, countdown }
  }

  // ── Filename helpers ──────────────────────────────────────────────────────
  function sanitizeFilePart(str) {
    return (str || '')
      .replace(/[^\x20-\x7E]/g, '')        // remove non-ASCII (incl. emoji)
      .replace(/[\/\\:*?"<>|#%&]/g, '')   // remove filesystem-unsafe chars
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 50);
  }

  function buildFilename(meta, suffix) {
    const date = meta.orderCreatedAt
      ? new Date(meta.orderCreatedAt).toISOString().slice(0, 10).replace(/-/g, '')
      : 'unknown';
    const parts = [
      'whatnot',
      sanitizeFilePart(meta.sellerUsername) || 'unknown',
      date,
      sanitizeFilePart(meta.itemTitle)  || '',
      sanitizeFilePart(meta.displayId)  || '',
      suffix,
    ].filter(Boolean);
    return parts.join('-') + '.mp4';
  }

  // ── Video overlay ─────────────────────────────────────────────────────────
  function openOverlay({ indexUrl, timeOffset, countdown, mp4BaseUrl, sellerUsername, itemTitle, displayId, orderCreatedAt }) {
    if (document.getElementById('wn-overlay')) return;

    const saleTime = timeOffset + countdown;

    const overlay = document.createElement('div');
    overlay.id = 'wn-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Video Receipt Player');
    overlay.innerHTML = `
      <div id="wn-overlay-backdrop"></div>
      <div id="wn-overlay-panel">
        <div id="wn-overlay-header">
          <span id="wn-overlay-title">Video Receipt</span>
          <div id="wn-overlay-controls">
            <button id="wn-btn-sale" title="Jump to sale moment">⚡ Sale moment</button>
            <button id="wn-btn-start" title="Watch from beginning">⏮ From start</button>
            <button id="wn-btn-dl-full" title="Download full livestream recording (may be several GB)"${mp4BaseUrl ? '' : ' disabled'}>⬇ Full video</button>
            <button id="wn-btn-dl-clip" title="Download 30-second clip around your sale moment">✂ Clip (30s)</button>
            <button id="wn-btn-close" title="Close" aria-label="Close">✕</button>
          </div>
        </div>
        <video id="wn-video" controls playsinline></video>
        <div id="wn-overlay-info">
          Opening 30 s before your item was sold
          &nbsp;·&nbsp;
          Sale at <strong>${formatTime(saleTime)}</strong> into the stream
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Delegate actual HLS setup to injected.js (page context, has window.Hls)
    window.dispatchEvent(new CustomEvent('__whatnot_ext_play__', {
      detail: { indexUrl, timeOffset, saleTime }
    }));

    document.getElementById('wn-btn-sale').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('__whatnot_ext_seek__', { detail: { time: saleTime } }));
    });
    document.getElementById('wn-btn-start').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('__whatnot_ext_seek__', { detail: { time: 0 } }));
    });

    // Full video download — background service worker calls chrome.downloads.download()
    if (mp4BaseUrl) {
      document.getElementById('wn-btn-dl-full').addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'download',
          url: mp4BaseUrl,
          filename: buildFilename({ sellerUsername, orderCreatedAt }, 'full'),
        });
      });
    }

    // Clip download — injected.js fetches byte ranges + returns a same-origin blob URL
    document.getElementById('wn-btn-dl-clip').addEventListener('click', () => {
      const btn = document.getElementById('wn-btn-dl-clip');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '⏳';
      window.addEventListener('__whatnot_ext_download_resp__', ({ detail }) => {
        btn.disabled = false;
        btn.textContent = '✂ Clip (30s)';
        if (detail.error) { showError('Clip download failed: ' + detail.error); return; }
        const a = Object.assign(document.createElement('a'), {
          href: detail.url,
          download: detail.filename,
        });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(detail.url), 30000);
      }, { once: true });
      window.dispatchEvent(new CustomEvent('__whatnot_ext_download_clip__'));
    });

    document.getElementById('wn-btn-close').addEventListener('click', closeOverlay);
    overlay.querySelector('#wn-overlay-backdrop').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', onEscKey);
  }

  function closeOverlay() {
    const overlay = document.getElementById('wn-overlay');
    if (overlay) {
      window.dispatchEvent(new CustomEvent('__whatnot_ext_destroy__'));
      overlay.remove();
    }
    document.removeEventListener('keydown', onEscKey);
  }

  // ── Enhance order date display with time ─────────────────────────────────────
  // Track pending MutationObservers so we can cancel them if navigation fires again
  const _metaObservers = [];
  function _trackObs(obs, timeoutMs) {
    _metaObservers.push(obs);
    setTimeout(() => { obs.disconnect(); }, timeoutMs);
  }
  function _cancelMetaObservers() {
    while (_metaObservers.length) _metaObservers.pop().disconnect();
  }

  window.addEventListener('__whatnot_ext_meta__', ({ detail: {
    createdAt, expiresAt,
    shippingServiceName, courierLogoSmallUrl,
    itemTitle, description, listingAttributes,
    sellerRatingOverall, sellerRatingCount, soldCount, averageShipDays,
    profileImageUrl, isPremierShop, isVerifiedSeller, sellerBio,
    salesChannel,
    trackingTitle, trackingEta, trackingIsDelayed, trackingArrivesToday,
  } }) => {
    // Cancel any observers still waiting from a previous order page
    _cancelMetaObservers();

    // ── Update video receipt button availability ──────────────────────────
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      const ageMs      = createdAt ? (Date.now() - new Date(createdAt).getTime()) : 0;
      const expired    = createdAt && ageMs > 60 * 24 * 60 * 60 * 1000;
      const notLive    = salesChannel && salesChannel !== 'LIVESTREAM';
      const label      = btn.querySelector('#wn-btn-label');
      if (expired || notLive) {
        btn.disabled = true;
        btn.style.opacity = '0.45';
        btn.style.cursor = 'default';
        if (label) label.textContent = expired
          ? 'Video receipt expired (60-day limit)'
          : 'Video receipt not available for this sales channel';
      } else {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
        if (label) label.textContent = 'Watch video receipt';
      }
    }

    // ── Update Order Date to include time with seconds ────────────────────
    const d = new Date(createdAt);
    if (!isNaN(d)) {
      const dateOnly = d.toLocaleDateString('en-US');
      const withTime = d.toLocaleString('en-US', {
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit',
      });
      function updateDate() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue.trim() === dateOnly) {
            node.nodeValue = withTime;
            return true;
          }
        }
        return false;
      }
      if (!updateDate()) {
        const obs = new MutationObserver(() => { if (updateDate()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Insert Return Deadline row after Order Date ───────────────────────
    if (expiresAt) {
      const deadline = new Date(expiresAt + 'T00:00:00');
      const deadlineStr = deadline.toLocaleDateString('en-US', {
        year: 'numeric', month: 'numeric', day: 'numeric',
      });
      function insertDeadline() {
        if (document.getElementById('wn-return-deadline')) return true;
        const labels = document.querySelectorAll('strong');
        for (const label of labels) {
          if (label.textContent.trim() === 'Order Date') {
            const row = label.parentElement;
            if (!row) continue;
            const newRow = row.cloneNode(false);
            newRow.id = 'wn-return-deadline';
            const lbl = document.createElement('strong');
            lbl.textContent = 'Return By';
            // Copy the label's className so it matches native style
            lbl.className = label.className;
            const val = document.createTextNode('\u00a0' + deadlineStr);
            newRow.appendChild(lbl);
            newRow.appendChild(val);
            row.insertAdjacentElement('afterend', newRow);
            return true;
          }
        }
        return false;
      }
      if (!insertDeadline()) {
        const obs = new MutationObserver(() => { if (insertDeadline()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Append shipping service name + tracking status to tracking link ────
    if (shippingServiceName || trackingTitle) {
      function insertShippingService() {
        if (document.getElementById('wn-shipping-service')) return true;
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (link.textContent.includes('Track your purchase')) {
            // Service name row
            const svcTag = document.createElement('span');
            svcTag.id = 'wn-shipping-service';
            svcTag.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:0.8em;opacity:0.65;margin-top:2px';
            if (courierLogoSmallUrl) {
              const img = document.createElement('img');
              img.src = courierLogoSmallUrl;
              img.alt = '';
              img.style.cssText = 'height:1em;width:auto;vertical-align:middle';
              svcTag.appendChild(img);
            }
            if (shippingServiceName) svcTag.appendChild(document.createTextNode(shippingServiceName));
            link.appendChild(svcTag);
            // Tracking status row
            if (trackingTitle && trackingTitle !== 'Unknown') {
              const statusTag = document.createElement('span');
              statusTag.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:0.8em;margin-top:3px;flex-wrap:wrap';
              // Status text
              const titleSpan = document.createElement('span');
              titleSpan.style.cssText = 'font-weight:600';
              titleSpan.textContent = trackingTitle;
              statusTag.appendChild(titleSpan);
              // Arriving today badge
              if (trackingArrivesToday) {
                const badge = document.createElement('span');
                badge.style.cssText = 'background:#22c55e;color:#fff;font-size:0.85em;font-weight:700;padding:1px 6px;border-radius:999px;white-space:nowrap';
                badge.textContent = 'Arriving Today';
                statusTag.appendChild(badge);
              }
              // Delayed badge
              if (trackingIsDelayed) {
                const badge = document.createElement('span');
                badge.style.cssText = 'background:#ef4444;color:#fff;font-size:0.85em;font-weight:700;padding:1px 6px;border-radius:999px;white-space:nowrap';
                badge.textContent = 'Delayed';
                statusTag.appendChild(badge);
              }
              link.appendChild(statusTag);
            }
            return true;
          }
        }
        return false;
      }
      if (!insertShippingService()) {
        const obs = new MutationObserver(() => { if (insertShippingService()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Sales channel pill under item title ───────────────────────────────
    if (salesChannel) {
      const channelLabel = salesChannel === 'LIVESTREAM' ? 'Live Auction'
        : salesChannel === 'FIXED_PRICE' ? 'Fixed Price'
        : salesChannel === 'AUCTION' ? 'Auction'
        : salesChannel.replace(/_/g, ' ');
      function insertSalesChannel() {
        if (document.getElementById('wn-sales-channel')) return true;
        const strongs = document.querySelectorAll('strong');
        for (const s of strongs) {
          if (s.textContent.trim() === itemTitle) {
            const pill = document.createElement('span');
            pill.id = 'wn-sales-channel';
            pill.style.cssText = 'display:inline-block;font-size:0.72em;font-weight:600;letter-spacing:0.02em;padding:1px 7px;border-radius:999px;margin-left:6px;vertical-align:middle;background:rgba(99,102,241,0.12);color:#6366f1';
            pill.textContent = channelLabel;
            s.appendChild(pill);
            return true;
          }
        }
        return false;
      }
      if (!insertSalesChannel()) {
        const obs = new MutationObserver(() => { if (insertSalesChannel()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Insert description + attributes under item title ─────────────────
    if (itemTitle && (description || (listingAttributes && listingAttributes.length))) {
      function insertItemMeta() {
        if (document.getElementById('wn-item-meta')) return true;
        const strongs = document.querySelectorAll('strong');
        for (const strong of strongs) {
          const firstText = strong.childNodes[0]?.nodeType === Node.TEXT_NODE
          ? strong.childNodes[0].textContent.trim() : strong.textContent.trim();
        if (firstText === itemTitle) {
            const tag = document.createElement('div');
            tag.id = 'wn-item-meta';
            tag.style.cssText = 'font-size:0.8em;opacity:0.65;margin-top:2px;margin-bottom:4px';
            const parts = [];
            if (description) parts.push(description);
            if (listingAttributes && listingAttributes.length) parts.push(listingAttributes.join(' · '));
            tag.textContent = parts.join(' — ');
            strong.insertAdjacentElement('afterend', tag);
            return true;
          }
        }
        return false;
      }
      if (!insertItemMeta()) {
        const obs = new MutationObserver(() => { if (insertItemMeta()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Seller avatar (+ premier wings) next to seller link ─────────────
    if (profileImageUrl) {
      const WINGS_SVG = `<svg fill="none" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"><g><path d="M32.3776 12.1644C31.1032 13.437 31.0795 14.6153 31.4769 16.2019C31.6705 17.0997 31.7725 18.0316 31.7725 18.9872C31.7725 19.7721 31.7037 20.541 31.572 21.2881C31.4939 21.7292 31.3942 22.162 31.2738 22.586C30.3229 25.9369 28.0778 28.744 25.1106 30.4356C24.7941 30.6159 24.6841 31.0184 24.8647 31.3342C24.9694 31.517 25.1482 31.6309 25.342 31.6594C25.483 31.6801 25.6317 31.6557 25.7649 31.5796C26.6107 31.0973 27.4034 30.5326 28.1317 29.8962C29.1625 30.6969 30.7017 31.4334 32.1067 31.0127C33.4494 30.6534 34.2498 29.6602 34.874 28.4751C35.0252 28.188 34.9348 27.8316 34.6681 27.6635C33.5414 26.9535 32.4039 26.4592 31.0569 26.8196C30.9412 26.8504 30.8296 26.8861 30.7218 26.9261C31.2702 26.0917 31.7346 25.1972 32.1031 24.2547C33.3321 24.2784 34.4668 24.0942 35.3868 23.1759C36.3697 22.1944 36.5655 20.9348 36.5125 19.5968C36.4998 19.2726 36.2429 19.0091 35.9277 18.9967C34.8974 18.9561 33.9259 19.0307 33.0822 19.523C33.0886 19.3452 33.0919 19.1666 33.0919 18.9872C33.0919 18.081 33.0087 17.1943 32.8492 16.3341C33.7903 16.2673 34.6562 16.001 35.3868 15.2717C36.3697 14.2903 36.5655 13.0307 36.5125 11.6926C36.4998 11.3684 36.2429 11.105 35.9277 11.0926C34.5964 11.0401 33.3638 11.1798 32.3776 12.1644Z" fill="url(#wng0)"/><path d="M5.62045 12.1644C6.8948 13.437 6.91851 14.6153 6.52113 16.2019C6.32759 17.0997 6.22554 18.0316 6.22554 18.9872C6.22554 19.7721 6.29435 20.541 6.42604 21.2881C6.50412 21.7292 6.60385 22.162 6.7242 22.586C7.67513 25.9369 9.92025 28.744 12.8874 30.4356C13.2039 30.6159 13.3139 31.0184 13.1333 31.3342C13.0287 31.517 12.8498 31.6309 12.656 31.6594C12.5151 31.6801 12.3664 31.6557 12.2331 31.5796C11.3874 31.0973 10.5947 30.5326 9.86639 29.8962C8.83557 30.6969 7.2963 31.4334 5.8913 31.0127C4.54866 30.6534 3.74823 29.6602 3.12408 28.4751C2.9728 28.188 3.06326 27.8316 3.32998 27.6635C4.45666 26.9535 5.59417 26.4592 6.94119 26.8196C7.0569 26.8504 7.16848 26.8861 7.2762 26.9261C6.72781 26.0917 6.26343 25.1972 5.89491 24.2547C4.66592 24.2784 3.53125 24.0942 2.61125 23.1759C1.62836 22.1944 1.43251 20.9348 1.48559 19.5968C1.49822 19.2726 1.75515 19.0091 2.07032 18.9967C3.10063 18.9561 4.07217 19.0307 4.91589 19.523C4.90945 19.3452 4.9061 19.1666 4.9061 18.9872C4.9061 18.081 4.98934 17.1943 5.14886 16.3341C4.20772 16.2673 3.34184 16.001 2.61125 15.2717C1.62836 14.2903 1.43251 13.0307 1.48559 11.6926C1.49822 11.3684 1.75515 11.105 2.07032 11.0926C3.40162 11.0401 4.63422 11.1798 5.62045 12.1644Z" fill="url(#wng1)"/></g><defs><linearGradient id="wng0" x1="30.7666" x2="30.7666" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient><linearGradient id="wng1" x1="7.231" x2="7.231" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient></defs></svg>`;
      function insertSellerAvatar() {
        if (document.getElementById('wn-seller-avatar')) return true;
        const labels = document.querySelectorAll('strong');
        for (const label of labels) {
          if (label.textContent.trim() === 'Sold By') {
            label.style.whiteSpace = 'nowrap';
            const row = label.parentElement;
            if (!row) continue;
            const sellerLink = row.querySelector('a');
            if (!sellerLink) continue;
            const size = 32;
            const wingPad = isPremierShop ? Math.round(size * 0.3) : 0;
            const wrap = document.createElement('span');
            wrap.id = 'wn-seller-avatar';
            wrap.style.cssText = `display:inline-block;position:relative;width:${size}px;height:${size}px;vertical-align:middle;margin-right:${wingPad + 6}px;flex-shrink:0`;
            const img = document.createElement('img');
            img.src = profileImageUrl;
            img.alt = '';
            img.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block`;
            wrap.appendChild(img);
            if (isPremierShop) {
              const wingWrap = document.createElement('span');
              wingWrap.style.cssText = `position:absolute;inset:-${Math.round(size*0.3)}px;pointer-events:none`;
              wingWrap.innerHTML = WINGS_SVG;
              wrap.appendChild(wingWrap);
            }
            // Wrap sellerLink + future stats/bio in a block container so they stack vertically
            const topMargin = isPremierShop ? 10 : 4;
            const leftMargin = isPremierShop ? 10 : 0;
            const sellerWrap = document.createElement('span');
            sellerWrap.id = 'wn-seller-wrap';
            sellerWrap.style.cssText = `display:block;margin-top:${topMargin}px;margin-left:${leftMargin}px`;
            row.insertBefore(sellerWrap, sellerLink);
            sellerWrap.appendChild(sellerLink);
            sellerLink.style.cssText = 'display:inline-flex;align-items:center;white-space:nowrap';
            sellerLink.insertBefore(wrap, sellerLink.firstChild);
            return true;
          }
        }
        return false;
      }
      if (!insertSellerAvatar()) {
        const obs = new MutationObserver(() => { if (insertSellerAvatar()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Verified seller badge next to seller name ─────────────────────────
    if (isVerifiedSeller) {
      function insertVerifiedBadge() {
        if (document.getElementById('wn-verified-badge')) return true;
        const labels = document.querySelectorAll('strong');
        for (const label of labels) {
          if (label.textContent.trim() === 'Sold By') {
            const row = label.parentElement;
            if (!row) continue;
            const sellerLink = row.querySelector('a');
            if (!sellerLink) continue;
            const badge = document.createElement('span');
            badge.id = 'wn-verified-badge';
            badge.title = 'Verified Seller';
            badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#3b82f6;flex-shrink:0;margin-left:4px;vertical-align:middle';
            badge.innerHTML = '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:9px;height:9px"><path d="M2 6l2.5 2.5L10 3.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            sellerLink.appendChild(badge);
            return true;
          }
        }
        return false;
      }
      if (!insertVerifiedBadge()) {
        const obs = new MutationObserver(() => { if (insertVerifiedBadge()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Seller bio under stats ─────────────────────────────────────────────
    if (sellerBio) {
      function insertSellerBio() {
        if (document.getElementById('wn-seller-bio')) return true;
        const wrap = document.getElementById('wn-seller-wrap');
        if (!wrap) return false;
        const bio = document.createElement('span');
        bio.id = 'wn-seller-bio';
        bio.style.cssText = 'display:block;font-size:0.8em;opacity:0.6;margin-top:4px;font-style:italic;white-space:normal;line-height:1.35';
        bio.textContent = sellerBio;
        wrap.appendChild(bio);
        return true;
      }
      if (!insertSellerBio()) {
        const obs = new MutationObserver(() => { if (insertSellerBio()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }

    // ── Append seller stats under "Sold By" ──────────────────────────────
    if (sellerRatingOverall != null || soldCount != null || averageShipDays != null) {
      function fmtCount(n) {
        if (n == null) return '';
        if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
      }
      function insertSellerStats() {
        if (document.getElementById('wn-seller-stats')) return true;
        const labels = document.querySelectorAll('strong');
        for (const label of labels) {
          if (label.textContent.trim() === 'Sold By') {
            const row = label.parentElement;
            if (!row) continue;
            const sellerLink = row.querySelector('a');
            if (!sellerLink) continue;
            const tag = document.createElement('span');
            tag.id = 'wn-seller-stats';
            tag.style.cssText = 'display:block;font-size:0.8em;opacity:0.65;margin-top:3px';
            const parts = [];
            if (sellerRatingOverall != null) {
              const countStr = sellerRatingCount != null ? ` (${fmtCount(sellerRatingCount)} reviews)` : '';
              parts.push(`⭐ ${sellerRatingOverall.toFixed(1)}${countStr}`);
            }
            if (averageShipDays != null) parts.push(`${averageShipDays}d avg ship`);
            if (soldCount != null) parts.push(`${fmtCount(soldCount)} sold`);
            tag.textContent = parts.join(' · ');
            // Append to wrapper (block container) so it appears below the name
            const wrap = document.getElementById('wn-seller-wrap') || sellerLink.parentElement;
            wrap.appendChild(tag);
            return true;
          }
        }
        return false;
      }
      if (!insertSellerStats()) {
        const obs = new MutationObserver(() => { if (insertSellerStats()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
        _trackObs(obs, 10000);
      }
    }
  });

  function onEscKey(e) { if (e.key === 'Escape') closeOverlay(); }

  // ── Activity feed enhancement ─────────────────────────────────────────────
  (function watchActivityFeed() {
    const FEED_WINGS_SVG = `<svg fill="none" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"><g><path d="M32.3776 12.1644C31.1032 13.437 31.0795 14.6153 31.4769 16.2019C31.6705 17.0997 31.7725 18.0316 31.7725 18.9872C31.7725 19.7721 31.7037 20.541 31.572 21.2881C31.4939 21.7292 31.3942 22.162 31.2738 22.586C30.3229 25.9369 28.0778 28.744 25.1106 30.4356C24.7941 30.6159 24.6841 31.0184 24.8647 31.3342C24.9694 31.517 25.1482 31.6309 25.342 31.6594C25.483 31.6801 25.6317 31.6557 25.7649 31.5796C26.6107 31.0973 27.4034 30.5326 28.1317 29.8962C29.1625 30.6969 30.7017 31.4334 32.1067 31.0127C33.4494 30.6534 34.2498 29.6602 34.874 28.4751C35.0252 28.188 34.9348 27.8316 34.6681 27.6635C33.5414 26.9535 32.4039 26.4592 31.0569 26.8196C30.9412 26.8504 30.8296 26.8861 30.7218 26.9261C31.2702 26.0917 31.7346 25.1972 32.1031 24.2547C33.3321 24.2784 34.4668 24.0942 35.3868 23.1759C36.3697 22.1944 36.5655 20.9348 36.5125 19.5968C36.4998 19.2726 36.2429 19.0091 35.9277 18.9967C34.8974 18.9561 33.9259 19.0307 33.0822 19.523C33.0886 19.3452 33.0919 19.1666 33.0919 18.9872C33.0919 18.081 33.0087 17.1943 32.8492 16.3341C33.7903 16.2673 34.6562 16.001 35.3868 15.2717C36.3697 14.2903 36.5655 13.0307 36.5125 11.6926C36.4998 11.3684 36.2429 11.105 35.9277 11.0926C34.5964 11.0401 33.3638 11.1798 32.3776 12.1644Z" fill="url(#fwng0)"/><path d="M5.62045 12.1644C6.8948 13.437 6.91851 14.6153 6.52113 16.2019C6.32759 17.0997 6.22554 18.0316 6.22554 18.9872C6.22554 19.7721 6.29435 20.541 6.42604 21.2881C6.50412 21.7292 6.60385 22.162 6.7242 22.586C7.67513 25.9369 9.92025 28.744 12.8874 30.4356C13.2039 30.6159 13.3139 31.0184 13.1333 31.3342C13.0287 31.517 12.8498 31.6309 12.656 31.6594C12.515 31.6801 12.3664 31.6557 12.2331 31.5796C11.3874 31.0973 10.5947 30.5326 9.86639 29.8962C8.83557 30.6969 7.2963 31.4334 5.8913 31.0127C4.54866 30.6534 3.74823 29.6602 3.12408 28.4751C2.9728 28.188 3.06326 27.8316 3.32998 27.6635C4.45666 26.9535 5.59417 26.4592 6.94119 26.8196C7.0569 26.8504 7.16848 26.8861 7.2762 26.9261C6.72781 26.0917 6.26343 25.1972 5.89491 24.2547C4.66592 24.2784 3.53125 24.0942 2.61125 23.1759C1.62836 22.1944 1.43251 20.9348 1.48559 19.5968C1.49822 19.2726 1.75515 19.0091 2.07032 18.9967C3.10063 18.9561 4.07217 19.0307 4.91589 19.523C4.90945 19.3452 4.9061 19.1666 4.9061 18.9872C4.9061 18.081 4.98934 17.1943 5.14886 16.3341C4.20772 16.2673 3.34184 16.001 2.61125 15.2717C1.62836 14.2903 1.43251 13.0307 1.48559 11.6926C1.49822 11.3684 1.75515 11.105 2.07032 11.0926C3.40162 11.0401 4.63422 11.1798 5.62045 12.1644Z" fill="url(#fwng1)"/></g><defs><linearGradient id="fwng0" x1="30.7666" x2="30.7666" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient><linearGradient id="fwng1" x1="7.231" x2="7.231" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient></defs></svg>`;
    // Local cache survives React re-renders; keyed by UUID
    const dataCache = new Map();   // uuid → { createdAt, sellerUsername, profileImageUrl, isPremierShop }
    const pending   = new Set();   // uuids currently in-flight

    window.addEventListener('__whatnot_ext_activity_resp__', ({ detail }) => {
      for (const [uuid, info] of Object.entries(detail)) {
        dataCache.set(uuid, info);
        pending.delete(uuid);
      }
      applyAll();
    });

    function fetchMissing(uuids) {
      const needed = uuids.filter(u => !dataCache.has(u) && !pending.has(u));
      if (!needed.length) return;
      needed.forEach(u => pending.add(u));
      window.dispatchEvent(new CustomEvent('__whatnot_ext_activity_req__', { detail: { uuids: needed } }));
    }

    function applyToLink(link) {
      const uuid = link.pathname.split('/')[2];
      if (!uuid) return;
      const info = dataCache.get(uuid);
      if (!info) return;
      try {
      // ── Date + time ──
      if (info.createdAt) {
        const d = new Date(info.createdAt);
        if (!isNaN(d)) {
          const withTime = d.toLocaleString('en-US', {
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: '2-digit', second: '2-digit',
          });
          const strongs = link.querySelectorAll('strong');
          for (const s of strongs) {
            if (s.textContent.trim() === 'Date:') {
              const v = s.nextElementSibling;
              if (v && !v.textContent.includes(',')) v.textContent = withTime;
              break;
            }
          }
        }
      }

      // ── Seller avatar + name in top-right, same line as status badge ──
      if (info.sellerUsername && !link.querySelector('.wn-feed-seller-top')) {
        // The status row is the flex justify-between div containing the badge <section>
        const statusRow = link.querySelector('.flex.justify-between');
        if (statusRow) {
          statusRow.classList.add('wn-feed-seller-top');
          const sellerSpan = document.createElement('span');
          sellerSpan.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex-shrink:0;margin-left:auto';
          if (info.profileImageUrl) {
            const size = 18;
            const wingPad = info.isPremierShop ? Math.round(size * 0.3) : 0;
            const avWrap = document.createElement('span');
            avWrap.style.cssText = `display:inline-block;position:relative;width:${size}px;height:${size}px;flex-shrink:0;margin-left:${wingPad}px;margin-right:${wingPad}px`;
            const avImg = document.createElement('img');
            avImg.src = info.profileImageUrl;
            avImg.alt = '';
            avImg.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block`;
            avWrap.appendChild(avImg);
            if (info.isPremierShop) {
              const ww = document.createElement('span');
              ww.style.cssText = `position:absolute;inset:-${Math.round(size * 0.3)}px;pointer-events:none`;
              ww.innerHTML = FEED_WINGS_SVG;
              avWrap.appendChild(ww);
            }
            sellerSpan.appendChild(avWrap);
          }
          const nameEl = document.createElement('span');
          nameEl.style.cssText = 'font-size:0.8em;opacity:0.75;white-space:nowrap';
          nameEl.textContent = info.sellerUsername;
          sellerSpan.appendChild(nameEl);
          statusRow.appendChild(sellerSpan);
        }
      }

      // ── Shipping row after Date row ──
      let shippingRowEl = link.querySelector('.wn-feed-shipping') || null;
      if (info.shippingServiceName && !shippingRowEl) {
        const strongs = link.querySelectorAll('strong');
        let dateRow = null;
        for (const s of strongs) {
          if (s.textContent.trim() === 'Date:') { dateRow = s.parentElement; break; }
        }
        if (dateRow) {
          const row = dateRow.cloneNode(false);
          row.classList.add('wn-feed-shipping');
          row.style.cssText = (row.style.cssText || '') + ';overflow:hidden;max-width:100%;min-width:0;box-sizing:border-box';
          const lbl = document.createElement('strong');
          lbl.textContent = 'Shipped:';
          lbl.className = dateRow.querySelector('strong')?.className || '';
          const val = document.createElement('strong');
          val.className = lbl.className;
          val.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
          if (info.courierLogoSmallUrl) {
            const logo = document.createElement('img');
            logo.src = info.courierLogoSmallUrl;
            logo.alt = '';
            logo.style.cssText = 'width:16px;height:16px;object-fit:contain;border-radius:2px;flex-shrink:0';
            val.appendChild(logo);
          }
          val.appendChild(document.createTextNode(' ' + info.shippingServiceName));
          if (info.trackingEta) {
            const etaNum = Number(info.trackingEta);
            const etaStr = !isNaN(etaNum) && etaNum > 1e9
              ? new Date(etaNum * 1000).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
              : String(info.trackingEta);
            const etaSep = document.createTextNode(' · ');
            const etaEl = document.createElement('span');
            etaEl.style.cssText = 'opacity:0.7';
            etaEl.textContent = 'ETA: ' + etaStr;
            val.appendChild(etaSep);
            val.appendChild(etaEl);
          }
          row.appendChild(lbl);
          row.appendChild(val);
          dateRow.insertAdjacentElement('afterend', row);
          shippingRowEl = row;
        }
      }

      // ── Description row — appended after shipping (safe: beyond React's last managed child) ──
      if (info.description && !link.querySelector('.wn-feed-desc')) {
        const strongs2 = link.querySelectorAll('strong');
        let anchorRow = shippingRowEl;
        if (!anchorRow) {
          for (const s of strongs2) {
            if (s.textContent.trim() === 'Date:') { anchorRow = s.parentElement; break; }
          }
        }
        if (anchorRow) {
          // Ensure the flex column parent can actually shrink below content width
          const col = anchorRow.parentElement;
          if (col) { col.style.minWidth = '0'; col.style.overflow = 'hidden'; }
          const row = anchorRow.cloneNode(false);
          row.classList.remove('wn-feed-shipping');
          row.classList.add('wn-feed-desc');
          row.style.cssText = (row.style.cssText || '') + ';overflow:hidden;max-width:100%;min-width:0;box-sizing:border-box';
          const val = document.createElement('strong');
          val.className = anchorRow.querySelector('strong')?.className || '';
          val.style.cssText = 'opacity:0.55;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 0;display:block';
          val.textContent = info.description;
          row.appendChild(val);
          anchorRow.insertAdjacentElement('afterend', row);
        }
      }
      } catch (_) {}
    }

    function applyAll() {
      document.querySelectorAll('a[href^="/order/"]').forEach(applyToLink);
    }

    // On every DOM mutation: collect visible UUIDs, fetch any we don't have,
    // then immediately apply whatever is already cached (synchronous — survives re-renders).
    let timer = null;
    const feedObs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const links = document.querySelectorAll('a[href^="/order/"]');
        const uuids = [...new Set(Array.from(links).map(l => l.pathname.split('/')[2]).filter(Boolean))];
        fetchMissing(uuids);
        applyAll();
      }, 50);
    });
    feedObs.observe(document.body, { childList: true, subtree: true });
  })();

  // ── Utilities ─────────────────────────────────────────────────────────────
  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function showError(message) {
    document.getElementById('wn-error-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'wn-error-toast';
    toast.setAttribute('role', 'alert');
    toast.textContent = `Video Receipt: ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }
})();
