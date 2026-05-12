// advanced.js — Activity drawer "Advanced Orders" button + full-page overlay
// Runs on all Whatnot pages via manifest content_scripts
(() => {
  'use strict';

  const ADV_BTN_ID        = 'wn-advanced-btn';
  const ADV_OVERLAY_ID    = 'wn-advanced-overlay';
  const ADV_FAKE_PATH     = '/wn-advanced-orders';
  const ADV_STYLE_ID      = 'wn-advanced-styles';
  const CACHE_KEY_PREFIX  = 'wn_adv_gql2_';
  const CACHE_TTL_MS      = 15 * 60 * 1000; // 15 minutes

  // ── Build auth headers (same pattern as injected.js) ─────────────────────
  function buildHeaders() {
    const usidMatch = document.cookie.match(/(?:^|;\s*)usid=([^;]+)/);
    const usid = usidMatch ? usidMatch[1] : '';
    const sessionIdMatch = document.cookie.match(/(?:^|;\s*)stable-id=([^;]+)/);
    const sessionId = sessionIdMatch ? sessionIdMatch[1] : crypto.randomUUID();
    const appVersion = (() => {
      const meta = document.querySelector('meta[name="x-whatnot-app-version"]');
      if (meta) return meta.content;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-0000`;
    })();
    return {
      accept: '*/*',
      'content-type': 'application/json',
      authorization: 'Cookie',
      'accept-language': navigator.language || 'en-US',
      'apollographql-client-name': 'web',
      'apollographql-client-version': appVersion,
      'x-whatnot-app': 'whatnot-web',
      'x-whatnot-app-context': 'express/browser',
      'x-whatnot-app-pathname': '/account/orders/download',
      'x-whatnot-app-screen': '/account/orders/download',
      'x-whatnot-app-session-id': sessionId,
      'x-whatnot-app-version': appVersion,
      'x-whatnot-app-user-session-id': usid,
      'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      'x-whatnot-usgmt': ',A,',
    };
  }

  // ── GQL query for all purchases ─────────────────────────────────────────
  const GQL_QUERY = `query GetMyPurchases($first: Int, $after: String) {
  myOrders(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor __typename }
    edges { node {
      id uuid displayId createdAt status salesChannel
      total { amount __typename }
      subtotal { amount __typename }
      shippingPrice { amount __typename }
      taxes { amount __typename }
      credit { amount __typename }
      authenticationFee { amount __typename }
      items { edges { node {
        quantity
        price { amount __typename }
        listing { title description
          category { label __typename }
          user { username profileImage { url __typename } premierShopStatus { isPremierShop __typename } isVerifiedSeller __typename }
          __typename
        }
        shipment { shippingServiceName trackingMetadata { title eta isDelayed isArrivingToday __typename } __typename }
        __typename
      } } }
      __typename
    } }
    __typename
  }
}`;

  // ── Fetch all orders via GQL, paginating if needed ───────────────────────
  async function fetchAllOrders(onProgress) {
    const GQL_URL = 'https://www.whatnot.com/services/graphql/?operationName=GetMyPurchases';
    let allEdges = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'WN_FETCH',
          url: GQL_URL,
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({
            operationName: 'GetMyPurchases',
            variables: { first: 2000, after: cursor },
            query: GQL_QUERY,
          }),
        }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (resp?.error) return reject(new Error(resp.error));
          resolve(resp.data);
        });
      });

      const page = data?.data?.myOrders;
      if (!page) throw new Error(data?.errors?.[0]?.message || 'No order data in response');
      const edges = page.edges || [];
      allEdges = allEdges.concat(edges);
      hasNextPage = page.pageInfo?.hasNextPage || false;
      cursor = page.pageInfo?.endCursor || null;
      if (onProgress) onProgress(allEdges.length);
    }

    return allEdges;
  }

  // ── Convert GQL edges to rows array [headers, ...dataRows] ───────────────
  function gqlEdgesToRows(edges) {
    const headers = [
      'uuid', 'Order #', 'Date', 'Status', 'Sales Channel',
      'Item', 'Description', 'Category', 'Seller', 'Seller Avatar', 'Premier Seller', 'Verified Seller',
      'Qty', 'Item Price',
      'Subtotal', 'Shipping', 'Tax', 'Auth Fee', 'Credits', 'Total',
      'Shipping Service', 'ETA', 'Tracking',
    ];
    const fmtMoney  = (m) => m?.amount != null ? (m.amount / 100).toFixed(2) : '';
    const fmtDate   = (s) => s ? new Date(s).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
    const fmtEta    = (n) => n ? new Date(n * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const fmtChan   = (s) => ({ LIVESTREAM: 'Live Auction', FIXED_PRICE: 'Fixed Price', AUCTION: 'Auction' })[s] || s || '';
    const fmtStatus = (s) => s ? s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';

    const rows = [headers];
    for (const { node } of edges) {
      const item     = node.items?.edges?.[0]?.node;
      const listing  = item?.listing;
      const seller   = listing?.user;
      const shipment = item?.shipment;
      const tracking = shipment?.trackingMetadata;
      rows.push([
        node.uuid                  || '',
        node.displayId             || '',
        fmtDate(node.createdAt),
        fmtStatus(node.status),
        fmtChan(node.salesChannel),
        listing?.title             || '',
        listing?.description       || '',
        listing?.category?.label   || '',
        seller?.username           || '',
        seller?.profileImage?.url  || '',
        seller?.premierShopStatus?.isPremierShop ? 'Yes' : '',
        seller?.isVerifiedSeller                 ? 'Yes' : '',
        item?.quantity             ?? '',
        fmtMoney(item?.price),
        fmtMoney(node.subtotal),
        fmtMoney(node.shippingPrice),
        fmtMoney(node.taxes),
        fmtMoney(node.authenticationFee),
        fmtMoney(node.credit),
        fmtMoney(node.total),
        shipment?.shippingServiceName || '',
        fmtEta(tracking?.eta),
        tracking?.title            || '',
      ]);
    }
    return rows;
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────
  function getCacheKey() {
    const usidMatch = document.cookie.match(/(?:^|;\s*)usid=([^;]+)/);
    return CACHE_KEY_PREFIX + (usidMatch ? usidMatch[1] : 'default');
  }

  function loadFromCache() {
    return new Promise((resolve) => {
      const key = getCacheKey();
      chrome.storage.local.get(key, (result) => {
        const entry = result[key];
        if (!entry || (Date.now() - entry.timestamp > CACHE_TTL_MS)) return resolve(null);
        resolve(entry);
      });
    });
  }

  function saveToCache(rows) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [getCacheKey()]: { rows, timestamp: Date.now() } }, resolve);
    });
  }

  // ── Filter rows by active sidebar filter selections ──────────────────────
  function applyFilters(rows) {
    if (!rows || rows.length < 2) return rows || [];
    const headers = rows[0];
    const chanCi   = headers.indexOf('Sales Channel');
    const statusCi = headers.indexOf('Status');
    const catCi    = headers.indexOf('Category');
    const sellerCi = headers.indexOf('Seller');
    const q = searchQuery.trim().toLowerCase();
    const data = rows.slice(1).filter(row => {
      if (activeFilters.channel.size  > 0 && !activeFilters.channel.has(String(row[chanCi]   ?? ''))) return false;
      if (activeFilters.status.size   > 0 && !activeFilters.status.has(String(row[statusCi]  ?? ''))) return false;
      if (activeFilters.category.size > 0 && !activeFilters.category.has(String(row[catCi]   ?? ''))) return false;
      if (activeFilters.seller.size   > 0 && !activeFilters.seller.has(String(row[sellerCi]  ?? ''))) return false;
      if (q) {
        // Check all columns that are not hidden for a match
        const anyMatch = row.some((val, ci) => {
          if (hiddenCols.has(ci)) return false;
          return String(val ?? '').toLowerCase().includes(q);
        });
        if (!anyMatch) return false;
      }
      return true;
    });
    return [headers, ...data];
  }

  // ── Build left sidebar filter panel ──────────────────────────────────────
  function buildSidebar(allRows, sidebarEl, onRefresh) {
    sidebarEl.innerHTML = '';
    if (!allRows || allRows.length < 2) return;
    const headers = allRows[0];
    const data    = allRows.slice(1);
    const chanCi   = headers.indexOf('Sales Channel');
    const statusCi = headers.indexOf('Status');
    const catCi    = headers.indexOf('Category');
    const sellerCi = headers.indexOf('Seller');

    function getUnique(ci) {
      const map = new Map();
      for (const row of data) {
        const v = String(row[ci] ?? '').trim();
        if (v) map.set(v, (map.get(v) || 0) + 1);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
    }

    function makeSection(title, filterKey, ci, { searchable = false, scrollable = false } = {}) {
      const values = getUnique(ci);
      if (values.length === 0) return;
      const activeSet = activeFilters[filterKey];

      const section = document.createElement('div');
      section.className = 'wn-adv-filter-section';

      const hdr = document.createElement('div');
      hdr.className = 'wn-adv-filter-hdr';
      hdr.innerHTML = `<span>${title}</span><i class="wn-adv-filter-hdr-arrow">▼</i>`;
      section.appendChild(hdr);

      const fbody = document.createElement('div');
      fbody.className = 'wn-adv-filter-body';

      const clearBtn = document.createElement('button');
      clearBtn.className = 'wn-adv-filter-clear' + (activeSet.size > 0 ? ' visible' : '');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        activeSet.clear();
        buildSidebar(allRows, sidebarEl, onRefresh);
        onRefresh();
      });
      fbody.appendChild(clearBtn);

      if (searchable) {
        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'wn-adv-seller-search';
        search.placeholder = `Search…`;
        search.addEventListener('input', () => {
          const q = search.value.toLowerCase();
          listEl.querySelectorAll('.wn-adv-filter-item').forEach(item => {
            item.style.display = (item.dataset.val || '').toLowerCase().includes(q) ? '' : 'none';
          });
        });
        fbody.appendChild(search);
      }

      const listEl = document.createElement('div');
      if (scrollable) listEl.className = 'wn-adv-filter-scroll';

      values.forEach(([v, count]) => {
        const item = document.createElement('label');
        item.className = 'wn-adv-filter-item';
        item.dataset.val = v;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = activeSet.has(v);
        cb.addEventListener('change', () => {
          if (cb.checked) activeSet.add(v); else activeSet.delete(v);
          clearBtn.classList.toggle('visible', activeSet.size > 0);
          onRefresh();
        });
        const nameSpan = document.createElement('span');
        nameSpan.textContent = v;
        const countSpan = document.createElement('span');
        countSpan.className = 'wn-adv-filter-count';
        countSpan.textContent = count;
        item.appendChild(cb);
        item.appendChild(nameSpan);
        item.appendChild(countSpan);
        listEl.appendChild(item);
      });
      fbody.appendChild(listEl);
      section.appendChild(fbody);

      hdr.addEventListener('click', () => {
        const collapsed = fbody.classList.toggle('collapsed');
        hdr.querySelector('.wn-adv-filter-hdr-arrow').textContent = collapsed ? '▶' : '▼';
      });
      sidebarEl.appendChild(section);
    }

    makeSection('Sales Channel', 'channel',  chanCi);
    makeSection('Status',        'status',   statusCi);
    makeSection('Category',      'category', catCi,    { scrollable: true });
    makeSection('Seller',        'seller',   sellerCi, { searchable: true, scrollable: true });
  }

  function formatCacheAge(timestamp) {
    const ageMins = Math.floor((Date.now() - timestamp) / 60000);
    if (ageMins < 1) return 'just now';
    if (ageMins === 1) return '1 min ago';
    return `${ageMins} min ago`;
  }

  // ── Export currently loaded rows as a CSV file download ───────────────────
  function exportCurrentGrid() {
    const rows = displayedRows || currentRows;
    if (!rows || rows.length < 1) return;
    const csvContent = rows.map(row =>
      row.map(field => {
        const s = String(field ?? '');
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      }).join(',')
    ).join('\r\n');
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
    const date = new Date().toISOString().split('T')[0];
    chrome.runtime.sendMessage({ type: 'download', url: dataUrl, filename: `whatnot-orders-${date}.csv` });
  }

  // ── Inject styles once ──────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(ADV_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = ADV_STYLE_ID;
    style.textContent = `
/* ── Advanced Orders overlay ───────────────────────────────────────────── */
#wn-advanced-overlay {
  position: fixed;
  inset: 0;
  z-index: 999998;
  background: #fff;
  color: #111;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
html.dark #wn-advanced-overlay { background: #111; color: #f0f0f0; }
#wn-adv-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(0,0,0,0.1);
  flex-shrink: 0;
}
html.dark #wn-adv-header { border-bottom-color: rgba(255,255,255,0.1); }
#wn-adv-back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  border-radius: 50%;
  cursor: pointer;
  color: inherit;
  flex-shrink: 0;
  transition: background 0.15s;
}
#wn-adv-back:hover { background: rgba(0,0,0,0.08); }
html.dark #wn-adv-back:hover { background: rgba(255,255,255,0.1); }
#wn-adv-title {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0;
  line-height: 1.3;
}
#wn-adv-meta {
  margin-left: auto;
  font-size: 0.8rem;
  opacity: 0.5;
  white-space: nowrap;
}
#wn-adv-body {
  flex: 1 1 auto;
  overflow: hidden;
  display: flex;
  flex-direction: row;
}
/* ── Sidebar ─────────────────────────────────────────────────────────────── */
#wn-adv-sidebar {
  width: 196px;
  min-width: 196px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid rgba(0,0,0,0.08);
  padding: 8px 0 20px;
}
html.dark #wn-adv-sidebar { border-right-color: rgba(255,255,255,0.08); }
.wn-adv-filter-section { border-bottom: 1px solid rgba(0,0,0,0.06); }
html.dark .wn-adv-filter-section { border-bottom-color: rgba(255,255,255,0.06); }
.wn-adv-filter-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 6px;
  cursor: pointer;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  opacity: 0.5;
  user-select: none;
}
.wn-adv-filter-hdr:hover { opacity: 0.8; }
.wn-adv-filter-hdr-arrow { font-style: normal; font-size: 0.6rem; flex-shrink: 0; }
.wn-adv-filter-body { display: flex; flex-direction: column; padding-bottom: 6px; }
.wn-adv-filter-body.collapsed { display: none; }
.wn-adv-filter-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 14px;
  font-size: 0.8rem;
  cursor: pointer;
  user-select: none;
}
.wn-adv-filter-item:hover { background: rgba(0,0,0,0.04); }
html.dark .wn-adv-filter-item:hover { background: rgba(255,255,255,0.05); }
.wn-adv-filter-item input[type="checkbox"] { accent-color: #6c5ce7; cursor: pointer; flex-shrink: 0; }
.wn-adv-filter-count { margin-left: auto; opacity: 0.38; font-size: 0.72rem; }
.wn-adv-filter-clear {
  align-self: flex-end;
  margin: 0 14px 2px;
  font-size: 0.7rem;
  color: #6c5ce7;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  visibility: hidden;
}
.wn-adv-filter-clear.visible { visibility: visible; }
html.dark .wn-adv-filter-clear { color: #a29bfe; }
.wn-adv-seller-search {
  margin: 2px 14px 5px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.15);
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
  font-family: inherit;
  box-sizing: border-box;
  width: calc(100% - 28px);
}
html.dark .wn-adv-seller-search { border-color: rgba(255,255,255,0.15); }
.wn-adv-seller-search:focus { outline: 1px solid #6c5ce7; border-color: #6c5ce7; }
.wn-adv-filter-scroll { max-height: 200px; overflow-y: auto; }
/* ── Main content area ───────────────────────────────────────────────────── */
#wn-adv-main {
  flex: 1 1 auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
/* ── Loading / error states ─────────────────────────────────────────────── */
#wn-adv-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 12px;
  padding: 40px;
  text-align: center;
}
#wn-adv-status p { margin: 0; font-size: 1rem; }
#wn-adv-status .wn-adv-sub { font-size: 0.85rem; opacity: 0.5; }
@keyframes wn-spin { to { transform: rotate(360deg); } }
.wn-adv-spinner {
  width: 32px; height: 32px;
  border: 3px solid rgba(0,0,0,0.12);
  border-top-color: #333;
  border-radius: 50%;
  animation: wn-spin 0.7s linear infinite;
}
html.dark .wn-adv-spinner { border-color: rgba(255,255,255,0.12); border-top-color: #ccc; }
/* ── Grid ───────────────────────────────────────────────────────────────── */
#wn-adv-table-wrap {
  flex: 1;
  overflow: auto;
}
#wn-adv-table {
  border-collapse: collapse;
  width: max-content;
  min-width: 100%;
  font-size: 0.82rem;
}
#wn-adv-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #f0f0f0;
}
html.dark #wn-adv-table thead { background: #1e1e1e; }
#wn-adv-table th {
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  border-bottom: 2px solid rgba(0,0,0,0.1);
}
html.dark #wn-adv-table th { border-bottom-color: rgba(255,255,255,0.1); }
#wn-adv-table th:hover { background: rgba(0,0,0,0.05); }
html.dark #wn-adv-table th:hover { background: rgba(255,255,255,0.05); }
#wn-adv-table th .wn-sort-arrow { margin-left: 4px; opacity: 0.35; font-style: normal; }
#wn-adv-table th.wn-sort-active .wn-sort-arrow { opacity: 1; }
#wn-adv-table td {
  padding: 0 12px;
  height: 36px;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(0,0,0,0.05);
  white-space: nowrap;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}
html.dark #wn-adv-table td { border-bottom-color: rgba(255,255,255,0.05); }
#wn-adv-table tbody tr:hover { background: rgba(0,0,0,0.03); }
html.dark #wn-adv-table tbody tr:hover { background: rgba(255,255,255,0.04); }
#wn-adv-table tfoot td {
  padding: 8px 12px;
  font-weight: 700;
  border-top: 2px solid rgba(0,0,0,0.1);
  background: #f8f8f8;
  white-space: nowrap;
  position: sticky;
  bottom: 0;
  z-index: 2;
}
html.dark #wn-adv-table tfoot td { border-top-color: rgba(255,255,255,0.1); background: #1a1a1a; }

/* ── Toolbar ────────────────────────────────────────────────────────────── */
#wn-adv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  flex-shrink: 0;
  background: rgba(0,0,0,0.02);
}
html.dark #wn-adv-toolbar { border-bottom-color: rgba(255,255,255,0.08); background: rgba(255,255,255,0.02); }
#wn-adv-search {
  flex: 1;
  min-width: 120px;
  max-width: 380px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.15);
  background: transparent;
  color: inherit;
  font-size: 0.82rem;
  font-family: inherit;
  box-sizing: border-box;
}
html.dark #wn-adv-search { border-color: rgba(255,255,255,0.15); }
#wn-adv-search:focus { outline: none; border-color: #6c5ce7; box-shadow: 0 0 0 2px rgba(108,92,231,0.18); }
#wn-adv-search:disabled { opacity: 0.4; cursor: not-allowed; }
.wn-adv-highlight { background: #ffe066; color: #1a1a1a; border-radius: 2px; padding: 0 1px; }
html.dark .wn-adv-highlight { background: #b8860b; color: #fff; }
.wn-adv-tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.15);
  background: #fff;
  color: inherit;
  font-size: 0.8rem;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  white-space: nowrap;
}
html.dark .wn-adv-tb-btn { background: #1e1e1e; border-color: rgba(255,255,255,0.15); }
.wn-adv-tb-btn:hover:not(:disabled) { background: rgba(0,0,0,0.06); border-color: rgba(0,0,0,0.25); }
html.dark .wn-adv-tb-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.25); }
.wn-adv-tb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.wn-adv-tb-btn svg { flex-shrink: 0; }
#wn-adv-btn-reload.wn-loading svg { animation: wn-spin 0.7s linear infinite; }

/* ── Columns popover ─────────────────────────────────────────────────────── */
#wn-adv-col-popover {
  background: #fff;
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 8px;
  padding: 12px 14px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  color: #111;
  min-width: 160px;
  max-height: 360px;
  overflow-y: auto;
}
html.dark #wn-adv-col-popover {
  background: #1e1e24;
  border-color: rgba(255,255,255,0.12);
  color: #e8e8ee;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
}
#wn-adv-col-popover input[type="checkbox"] { accent-color: #6c5ce7; cursor: pointer; }

/* ── Seller cell ────────────────────────────────────────────────────────── */
.wn-adv-seller-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: inherit;
  text-decoration: none;
}
.wn-adv-seller-link:hover { text-decoration: underline; }
.wn-adv-seller-av-wrap {
  position: relative;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  /* margin expanded by wings overlay (30% of 20px ≈ 6px each side) */
  margin-left: 7px;
  margin-right: 7px;
}
.wn-adv-seller-av-wrap.wn-premier { margin-left: 7px; margin-right: 7px; }
.wn-adv-seller-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.wn-adv-seller-wings {
  position: absolute;
  inset: -6px;
  pointer-events: none;
  width: calc(100% + 12px);
  height: calc(100% + 12px);
}
/* ── Order # link cell ────────────────────────────────────────────────── */
.wn-adv-order-link-btn {
  background: none; border: none; cursor: pointer; padding: 0;
  font-size: inherit; font-family: inherit; font-weight: inherit;
  color: #6c5ce7; text-decoration: underline; text-underline-offset: 2px;
  white-space: nowrap;
}
.wn-adv-order-link-btn:hover { color: #4834d4; }
html.dark .wn-adv-order-link-btn { color: #a29bfe; }
html.dark .wn-adv-order-link-btn:hover { color: #c8c0ff; }

/* ── Advanced button in Activity header ─────────────────────────────────── */
#${ADV_BTN_ID} {
  margin-left: auto;
  margin-right: 8px;
}
    `.trim();
    (document.head || document.documentElement).appendChild(style);
  }

  // ── Persistent state ─────────────────────────────────────────────────────
  let sortState         = { col: -1, dir: 'asc' };
  let currentRows       = null;  // all loaded rows [headers, ...data]
  let displayedRows     = null;  // post-filter rows currently shown in grid
  let lastCacheTimestamp = null; // timestamp of last successful load
  // Columns hidden by default (matched by lowercase header name)
  const DEFAULT_HIDDEN = new Set(['uuid', 'description', 'seller avatar', 'premier seller', 'verified seller', 'auth fee']);
  let hiddenCols        = new Set(DEFAULT_HIDDEN);
  let savedOverlayState = null; // { scrollTop } — set by goToOrder, consumed on back-navigate restore
  let activeFilters     = { channel: new Set(), status: new Set(), category: new Set(), seller: new Set() };
  let searchQuery       = ''; // free-text search across all visible columns

  // ── Render the parsed CSV rows into the overlay body ──────────────────────
  function renderGrid(rows, container) {
    if (rows.length < 2) {
      container.innerHTML = '<div id="wn-adv-status"><p>No orders found.</p></div>';
      return;
    }
    const headers  = rows[0];
    let   dataRows = rows.slice(1);

    // ── Virtual scroll constants ──────────────────────────────────────────────
    const ROW_H   = 36; // px — must match td height set in CSS
    const OVERSCAN = 10;

    // Build index-based hidden set from header names.
    // Only initialise from DEFAULT_HIDDEN on first render (hiddenCols has strings).
    const currentHiddenIsIndexed = [...hiddenCols].every(v => typeof v === 'number');
    if (!currentHiddenIsIndexed) {
      hiddenCols = new Set(
        headers.map((h, i) => DEFAULT_HIDDEN.has(h.trim().toLowerCase()) ? i : -1).filter(i => i >= 0)
      );
    }

    // Detect numeric columns (currency or plain number) — use full dataset once
    const isNumeric = headers.map((_, ci) =>
      dataRows.every(r => {
        const v = String(r[ci] ?? '').trim().replace(/^\$/, '');
        return v === '' || !isNaN(Number(v));
      })
    );

    // Detect date columns
    const isDate = headers.map((_, ci) => {
      if (isNumeric[ci]) return false;
      const nonEmpty = dataRows.map(r => String(r[ci] ?? '').trim()).filter(v => v !== '');
      return nonEmpty.length > 0 && nonEmpty.every(v => !isNaN(Date.parse(v)));
    });

    function sortedRows() {
      if (sortState.col < 0) return dataRows;
      const ci      = sortState.col;
      const numeric = isNumeric[ci];
      const date    = isDate[ci];
      return [...dataRows].sort((a, b) => {
        const av = String(a[ci] ?? '').trim().replace(/^\$/, '');
        const bv = String(b[ci] ?? '').trim().replace(/^\$/, '');
        let cmp;
        if (numeric)   { cmp = (parseFloat(av) || 0) - (parseFloat(bv) || 0); }
        else if (date) { cmp = (Date.parse(av) || 0) - (Date.parse(bv) || 0); }
        else           { cmp = av.localeCompare(bv, undefined, { sensitivity: 'base' }); }
        return sortState.dir === 'asc' ? cmp : -cmp;
      });
    }

    const NON_ADDITIVE = new Set(['order #', 'qty']);
    function computeTotals(rowset) {
      return headers.map((h, ci) => {
        if (!isNumeric[ci] || NON_ADDITIVE.has(h.toLowerCase())) return '';
        const sum = rowset.reduce((acc, r) => acc + (parseFloat(String(r[ci] ?? '').replace(/^\$/, '')) || 0), 0);
        const hasDollar = rowset.some(r => String(r[ci] ?? '').trim().startsWith('$'));
        return hasDollar ? `$${sum.toFixed(2)}` : (Number.isInteger(sum) ? String(sum) : sum.toFixed(2));
      });
    }

    // Precompute special column indices (stable across filter/sort)
    const orderNumCi = headers.indexOf('Order #');
    const sellerCi   = headers.indexOf('Seller');
    const avatarCi   = headers.indexOf('Seller Avatar');
    const premierCi  = headers.indexOf('Premier Seller');
    const colCount   = headers.length;
    const WINGS_SVG  = `<svg fill="none" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%"><path d="M32.3776 12.1644C31.1032 13.437 31.0795 14.6153 31.4769 16.2019C31.6705 17.0997 31.7725 18.0316 31.7725 18.9872C31.7725 19.7721 31.7037 20.541 31.572 21.2881C31.4939 21.7292 31.3942 22.162 31.2738 22.586C30.3229 25.9369 28.0778 28.744 25.1106 30.4356C24.7941 30.6159 24.6841 31.0184 24.8647 31.3342C24.9694 31.517 25.1482 31.6309 25.342 31.6594C25.483 31.6801 25.6317 31.6557 25.7649 31.5796C26.6107 31.0973 27.4034 30.5326 28.1317 29.8962C29.1625 30.6969 30.7017 31.4334 32.1067 31.0127C33.4494 30.6534 34.2498 29.6602 34.874 28.4751C35.0252 28.188 34.9348 27.8316 34.6681 27.6635C33.5414 26.9535 32.4039 26.4592 31.0569 26.8196C30.9412 26.8504 30.8296 26.8861 30.7218 26.9261C31.2702 26.0917 31.7346 25.1972 32.1031 24.2547C33.3321 24.2784 34.4668 24.0942 35.3868 23.1759C36.3697 22.1944 36.5655 20.9348 36.5125 19.5968C36.4998 19.2726 36.2429 19.0091 35.9277 18.9967C34.8974 18.9561 33.9259 19.0307 33.0822 19.523C33.0886 19.3452 33.0919 19.1666 33.0919 18.9872C33.0919 18.081 33.0087 17.1943 32.8492 16.3341C33.7903 16.2673 34.6562 16.001 35.3868 15.2717C36.3697 14.2903 36.5655 13.0307 36.5125 11.6926C36.4998 11.3684 36.2429 11.105 35.9277 11.0926C34.5964 11.0401 33.3638 11.1798 32.3776 12.1644Z" fill="url(#advwng0)"/><path d="M5.62045 12.1644C6.8948 13.437 6.91851 14.6153 6.52113 16.2019C6.32759 17.0997 6.22554 18.0316 6.22554 18.9872C6.22554 19.7721 6.29435 20.541 6.42604 21.2881C6.50412 21.7292 6.60385 22.162 6.7242 22.586C7.67513 25.9369 9.92025 28.744 12.8874 30.4356C13.2039 30.6159 13.3139 31.0184 13.1333 31.3342C13.0287 31.517 12.8498 31.6309 12.656 31.6594C12.515 31.6801 12.3664 31.6557 12.2331 31.5796C11.3874 31.0973 10.5947 30.5326 9.86639 29.8962C8.83557 30.6969 7.2963 31.4334 5.8913 31.0127C4.54866 30.6534 3.74823 29.6602 3.12408 28.4751C2.9728 28.188 3.06326 27.8316 3.32998 27.6635C4.45666 26.9535 5.59417 26.4592 6.94119 26.8196C7.0569 26.8504 7.16848 26.8861 7.2762 26.9261C6.72781 26.0917 6.26343 25.1972 5.89491 24.2547C4.66592 24.2784 3.53125 24.0942 2.61125 23.1759C1.62836 22.1944 1.43251 20.9348 1.48559 19.5968C1.49822 19.2726 1.75515 19.0091 2.07032 18.9967C3.10063 18.9561 4.07217 19.0307 4.91589 19.523C4.90945 19.3452 4.9061 19.1666 4.9061 18.9872C4.9061 18.081 4.98934 17.1943 5.14886 16.3341C4.20772 16.2673 3.34184 16.001 2.61125 15.2717C1.62836 14.2903 1.43251 13.0307 1.48559 11.6926C1.49822 11.3684 1.75515 11.105 2.07032 11.0926C3.40162 11.0401 4.63422 11.1798 5.62045 12.1644Z" fill="url(#advwng1)"/><defs><linearGradient id="advwng0" x1="30.7666" x2="30.7666" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient><linearGradient id="advwng1" x1="7.231" x2="7.231" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient></defs></svg>`;

    const wrap = document.createElement('div');
    wrap.id = 'wn-adv-table-wrap';

    const table = document.createElement('table');
    table.id = 'wn-adv-table';

    // ── thead ──
    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    headers.forEach((h, ci) => {
      const th = document.createElement('th');
      th.dataset.ci = ci;
      th.title = h;
      th.innerHTML = `${h}<i class="wn-sort-arrow">⬍</i>`;
      if (hiddenCols.has(ci)) th.style.display = 'none';
      th.addEventListener('click', () => {
        if (sortState.col === ci) {
          sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          sortState = { col: ci, dir: 'asc' };
        }
        rebuildBody();
      });
      headerTr.appendChild(th);
    });
    thead.appendChild(headerTr);
    table.appendChild(thead);

    // ── tbody ──
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    // ── tfoot ──
    const tfoot = document.createElement('tfoot');
    const footTr = document.createElement('tr');
    tfoot.appendChild(footTr);
    table.appendChild(tfoot);

    // Build a single data row element
    function makeRow(row) {
      const q = searchQuery.trim().toLowerCase();
      // Helper: wrap matched substring in a highlight span
      function highlighted(text) {
        const s = String(text ?? '');
        if (!q) return document.createTextNode(s);
        const idx = s.toLowerCase().indexOf(q);
        if (idx < 0) return document.createTextNode(s);
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(s.slice(0, idx)));
        const mark = document.createElement('mark');
        mark.className = 'wn-adv-highlight';
        mark.textContent = s.slice(idx, idx + q.length);
        frag.appendChild(mark);
        frag.appendChild(document.createTextNode(s.slice(idx + q.length)));
        return frag;
      }
      const tr = document.createElement('tr');
      const orderId = row[0]; // uuid always col 0
      headers.forEach((h, ci) => {
        const td = document.createElement('td');
        td.dataset.ci = ci;
        if (ci === orderNumCi) {
          const btn = document.createElement('button');
          btn.className = 'wn-adv-order-link-btn';
          btn.type = 'button';
          btn.title = 'Open order';
          btn.textContent = row[ci] ?? '';
          btn.addEventListener('click', (e) => { e.stopPropagation(); goToOrder(orderId); });
          td.appendChild(btn);
          td.title = String(row[ci] ?? '');
        } else if (ci === sellerCi) {
          const username  = row[ci] || '';
          const avatarUrl = avatarCi  >= 0 ? (row[avatarCi]  || '') : '';
          const isPremier = premierCi >= 0 ? (row[premierCi] === 'Yes') : false;
          const a = document.createElement('a');
          a.href = `https://www.whatnot.com/user/${username}`;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.className = 'wn-adv-seller-link';
          if (avatarUrl) {
            const avWrap = document.createElement('span');
            avWrap.className = 'wn-adv-seller-av-wrap' + (isPremier ? ' wn-premier' : '');
            const img = document.createElement('img');
            img.src = avatarUrl;
            img.className = 'wn-adv-seller-avatar';
            img.alt = '';
            avWrap.appendChild(img);
            if (isPremier) {
              const wings = document.createElement('span');
              wings.className = 'wn-adv-seller-wings';
              wings.innerHTML = WINGS_SVG;
              avWrap.appendChild(wings);
            }
            a.appendChild(avWrap);
          }
          a.appendChild(document.createTextNode(username));
          td.appendChild(a);
          td.title = username;
        } else {
          td.appendChild(highlighted(row[ci]));
          td.title = String(row[ci] ?? '');
        }
        if (isNumeric[ci]) td.style.textAlign = 'right';
        if (hiddenCols.has(ci)) td.style.display = 'none';
        tr.appendChild(td);
      });
      return tr;
    }

    // ── Virtual scroll state ──────────────────────────────────────────────────
    let sorted      = [];
    let renderStart = -1;
    let renderEnd   = -1;

    function renderWindow() {
      const scrollTop = wrap.scrollTop;
      const viewH     = wrap.clientHeight;
      const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
      const end   = Math.min(sorted.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
      if (start === renderStart && end === renderEnd) return;
      renderStart = start;
      renderEnd   = end;

      const frag = document.createDocumentFragment();
      if (start > 0) {
        const sp = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = colCount;
        td.style.cssText = `height:${start * ROW_H}px;padding:0;border:none;pointer-events:none;`;
        sp.appendChild(td);
        frag.appendChild(sp);
      }
      for (let i = start; i < end; i++) frag.appendChild(makeRow(sorted[i]));
      if (end < sorted.length) {
        const sp = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = colCount;
        td.style.cssText = `height:${(sorted.length - end) * ROW_H}px;padding:0;border:none;pointer-events:none;`;
        sp.appendChild(td);
        frag.appendChild(sp);
      }
      tbody.replaceChildren(frag);
    }

    // rAF-throttled scroll listener
    let rafId = null;
    wrap.addEventListener('scroll', () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = null; renderWindow(); });
    }, { passive: true });

    function updateFooter(rowset) {
      const totals = computeTotals(rowset);
      footTr.innerHTML = '';
      totals.forEach((v, ci) => {
        const td = document.createElement('td');
        td.dataset.ci = ci;
        if (ci === orderNumCi) {
          td.textContent = `${rowset.length} orders`;
          td.style.cssText = 'font-size:0.72rem;opacity:0.65;white-space:nowrap';
        } else {
          td.textContent = v;
          if (isNumeric[ci]) td.style.textAlign = 'right';
        }
        if (hiddenCols.has(ci)) td.style.display = 'none';
        footTr.appendChild(td);
      });
    }

    function rebuildBody() {
      // Update header sort indicators
      headerTr.querySelectorAll('th[data-ci]').forEach((th) => {
        const ci = Number(th.dataset.ci);
        th.classList.toggle('wn-sort-active', ci === sortState.col);
        const arrow = th.querySelector('.wn-sort-arrow');
        arrow.textContent = ci === sortState.col ? (sortState.dir === 'asc' ? '▲' : '▼') : '⬍';
      });
      sorted = sortedRows();
      updateFooter(sorted);
      // Reset virtual window and scroll to top
      wrap.scrollTop = 0;
      renderStart = -1;
      renderEnd   = -1;
      renderWindow();
    }

    // Build DOM structure first so wrap.clientHeight is valid when rebuildBody runs
    wrap.appendChild(table);
    container.innerHTML = '';
    container.appendChild(wrap);
    rebuildBody();

    // ── Expose APIs ───────────────────────────────────────────────────────────
    wrap._toggleColumn = (ci) => {
      if (hiddenCols.has(ci)) hiddenCols.delete(ci); else hiddenCols.add(ci);
      // Update thead + tfoot immediately
      headerTr.querySelectorAll('th[data-ci]').forEach(th => {
        th.style.display = hiddenCols.has(Number(th.dataset.ci)) ? 'none' : '';
      });
      footTr.querySelectorAll('td[data-ci]').forEach(td => {
        td.style.display = hiddenCols.has(Number(td.dataset.ci)) ? 'none' : '';
      });
      // Force re-render visible rows with new column visibility
      renderStart = -1; renderEnd = -1;
      renderWindow();
    };
    wrap._headers    = headers;
    wrap._hiddenCols = () => hiddenCols;
    wrap._updateRows = (newDataRows) => {
      dataRows = newDataRows;
      rebuildBody();
    };
    wrap._getScrollTop = () => wrap.scrollTop;
    wrap._setScrollTop = (t) => { wrap.scrollTop = t; };
  }

  // ── Columns popover ────────────────────────────────────────────────────────
  function openColumnsPopover(anchorBtn) {
    document.getElementById('wn-adv-col-popover')?.remove();
    const wrap = document.querySelector('#wn-adv-table-wrap');
    if (!wrap) return;
    const headers   = wrap._headers;
    const hidden    = wrap._hiddenCols();
    const toggle    = wrap._toggleColumn;

    const pop = document.createElement('div');
    pop.id = 'wn-adv-col-popover';
    pop.innerHTML = `<div style="font-size:0.75rem;font-weight:700;opacity:0.5;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em">Columns</div>`;
    headers.forEach((h, ci) => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:7px;padding:3px 0;cursor:pointer;font-size:0.82rem;white-space:nowrap';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden.has(ci);
      cb.addEventListener('change', () => { toggle(ci); cb.checked = !hidden.has(ci); });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(h));
      pop.appendChild(label);
    });

    const rect = anchorBtn.getBoundingClientRect();
    pop.style.cssText = `position:fixed;top:${rect.bottom + 6}px;left:${rect.left}px;z-index:1000000;`;
    document.getElementById('wn-advanced-overlay').appendChild(pop);

    const dismiss = (e) => { if (!pop.contains(e.target) && e.target !== anchorBtn) { pop.remove(); document.removeEventListener('mousedown', dismiss); } };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // ── Open the Advanced Orders overlay page ───────────────────────────────────
  function openAdvancedOrders({ skipPush = false, preloadedRows = null, restoreScrollTop = 0 } = {}) {
    if (document.getElementById(ADV_OVERLAY_ID)) return;
    ensureStyles();
    if (!skipPush) {
      sortState = { col: -1, dir: 'asc' };
      history.pushState({ wnAdvanced: true }, '', ADV_FAKE_PATH);
    }

    const overlay = document.createElement('div');
    overlay.id = ADV_OVERLAY_ID;

    const backSvg   = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" role="presentation"><path fill-rule="evenodd" d="M14.707 6.293a1 1 0 0 1 0 1.414L10.414 12l4.293 4.293a1 1 0 0 1-1.414 1.414L8.586 13a2 2 0 0 1 0-2.828l4.707-4.707a1 1 0 0 1 1.414 0" clip-rule="evenodd" fill="currentColor"/></svg>`;
    const reloadSvg  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" role="presentation"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/></svg>`;
    const exportSvg  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" role="presentation"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>`;
    const columnsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" role="presentation"><path d="M10 18h5v-6h-5v6zm-6 0h5V5H4v13zm12 0h5v-6h-5v6zM16 5v6h5V5h-5z" fill="currentColor"/></svg>`;

    overlay.innerHTML = `
      <div id="wn-adv-header">
        <button id="wn-adv-back" type="button" aria-label="Go back">${backSvg}</button>
        <h1 id="wn-adv-title">Advanced Orders</h1>
        <span id="wn-adv-meta"></span>
      </div>
      <div id="wn-adv-toolbar">
        <button id="wn-adv-btn-reload" class="wn-adv-tb-btn" type="button">${reloadSvg} Reload Orders</button>
        <input id="wn-adv-search" type="search" placeholder="Search orders…" autocomplete="off" spellcheck="false" disabled />
        <button id="wn-adv-btn-export" class="wn-adv-tb-btn" type="button" disabled>${exportSvg} Export CSV</button>
        <button id="wn-adv-btn-cols"   class="wn-adv-tb-btn" type="button" disabled>${columnsSvg} Columns</button>
      </div>
      <div id="wn-adv-body">
        <div id="wn-adv-status">
          <div class="wn-adv-spinner"></div>
          <p>Loading order history&hellip;</p>
          <p class="wn-adv-sub">Checking cache&hellip;</p>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const body      = overlay.querySelector('#wn-adv-body');
    const meta      = overlay.querySelector('#wn-adv-meta');
    const reloadBtn = overlay.querySelector('#wn-adv-btn-reload');
    const exportBtn = overlay.querySelector('#wn-adv-btn-export');
    const colsBtn   = overlay.querySelector('#wn-adv-btn-cols');
    const searchEl  = overlay.querySelector('#wn-adv-search');

    // Debounced search
    let searchDebounce = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchQuery = searchEl.value;
        const wrapEl = document.getElementById('wn-adv-table-wrap');
        if (wrapEl && wrapEl._updateRows && currentRows) {
          displayedRows = applyFilters(currentRows);
          const total    = Math.max(0, currentRows.length - 1);
          const filtered = Math.max(0, displayedRows.length - 1);
          const countStr = filtered === total
            ? `${total.toLocaleString()} order${total !== 1 ? 's' : ''}`
            : `${filtered.toLocaleString()} of ${total.toLocaleString()} orders`;
          meta.textContent = countStr + (lastCacheTimestamp ? ` \u00b7 Updated ${formatCacheAge(lastCacheTimestamp)}` : ' \u00b7 (restored)');
          wrapEl._updateRows(displayedRows.slice(1));
        }
      }, 150);
    });
    searchEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchEl.value = ''; searchEl.dispatchEvent(new Event('input')); } });

    document.getElementById('wn-adv-back').addEventListener('click', closeAdvancedOrders);
    exportBtn.addEventListener('click', exportCurrentGrid);
    reloadBtn.addEventListener('click', () => loadOrders(true));
    colsBtn.addEventListener('click', () => openColumnsPopover(colsBtn));
    window.addEventListener('keydown', onAdvancedEsc);

    async function loadOrders(force) {
      reloadBtn.disabled = true;
      reloadBtn.classList.add('wn-loading');
      body.innerHTML = `
        <div id="wn-adv-status">
          <div class="wn-adv-spinner"></div>
          <p>${force ? 'Refreshing orders…' : 'Loading order history…'}</p>
          <p class="wn-adv-sub">${force ? 'Fetching from Whatnot…' : 'Checking cache…'}</p>
        </div>`;
      try {
        let rows, timestamp;
        if (!force) {
          const cached = await loadFromCache();
          if (cached) { rows = cached.rows; timestamp = cached.timestamp; }
        }
        if (!rows) {
          const sub = body.querySelector('.wn-adv-sub');
          const edges = await fetchAllOrders((count) => {
            if (sub) sub.textContent = `Fetching orders… (${count.toLocaleString()} so far)`;
          });
          rows = gqlEdgesToRows(edges);
          timestamp = Date.now();
          await saveToCache(rows);
        }
        currentRows        = rows;
        lastCacheTimestamp = timestamp;
        showGrid(rows);
        exportBtn.disabled = false;
        colsBtn.disabled   = false;
        searchEl.disabled  = false;
        searchEl.focus();
      } catch (err) {
        body.innerHTML = `
          <div id="wn-adv-status">
            <p>Failed to load orders</p>
            <p class="wn-adv-sub">${String(err.message || err)}</p>
          </div>`;
      } finally {
        reloadBtn.disabled = false;
        reloadBtn.classList.remove('wn-loading');
      }
    }

    // ── Render sidebar + grid ────────────────────────────────────────────────
    function showGrid(rows, scrollTop = 0) {
      body.innerHTML = '';
      const sidebar = document.createElement('div');
      sidebar.id = 'wn-adv-sidebar';
      const main = document.createElement('div');
      main.id = 'wn-adv-main';
      body.appendChild(sidebar);
      body.appendChild(main);

      function refresh() {
        displayedRows = applyFilters(rows);
        const total    = Math.max(0, rows.length - 1);
        const filtered = Math.max(0, displayedRows.length - 1);
        const countStr = filtered === total
          ? `${total.toLocaleString()} order${total !== 1 ? 's' : ''}`
          : `${filtered.toLocaleString()} of ${total.toLocaleString()} orders`;
        const ageStr = lastCacheTimestamp ? ` \u00b7 Updated ${formatCacheAge(lastCacheTimestamp)}` : ' \u00b7 (restored)';
        meta.textContent = countStr + ageStr;
        // If table already rendered, only swap data rows (skip thead rebuild + column analysis)
        const existingWrap = main.querySelector('#wn-adv-table-wrap');
        if (existingWrap && existingWrap._updateRows) {
          existingWrap._updateRows(displayedRows.slice(1));
        } else {
          renderGrid(displayedRows, main);
        }
      }

      buildSidebar(rows, sidebar, refresh);
      refresh();
      if (scrollTop > 0) requestAnimationFrame(() => {
        const wrapEl = document.getElementById('wn-adv-table-wrap');
        if (wrapEl) wrapEl.scrollTop = scrollTop;
      });
    }

    if (preloadedRows) {
      currentRows = preloadedRows;
      exportBtn.disabled = false;
      colsBtn.disabled   = false;
      searchEl.disabled  = false;
      showGrid(preloadedRows, restoreScrollTop);
    } else {
      loadOrders(false);
    }
  }

  function closeAdvancedOrders() {
    const overlay = document.getElementById(ADV_OVERLAY_ID);
    if (!overlay) return;
    document.getElementById('wn-adv-col-popover')?.remove();
    overlay.remove();
    window.removeEventListener('keydown', onAdvancedEsc);
    // Reset state so next open re-initialises from defaults
    hiddenCols    = new Set(DEFAULT_HIDDEN);
    sortState     = { col: -1, dir: 'asc' };
    currentRows   = null;
    displayedRows = null;
    activeFilters = { channel: new Set(), status: new Set(), category: new Set(), seller: new Set() };
    searchQuery   = '';
    // If URL is still the fake path, navigate back
    if (window.location.pathname === ADV_FAKE_PATH) {
      history.back();
    }
  }

  function onAdvancedEsc(e) {
    if (e.key === 'Escape') closeAdvancedOrders();
  }

  // ── Navigate to an order, preserving Advanced state for back-navigation ──
  function goToOrder(orderId) {
    const wrapEl = document.getElementById('wn-adv-table-wrap');
    savedOverlayState = { scrollTop: wrapEl ? wrapEl.scrollTop : 0 };
    // Remove overlay without resetting module state (currentRows/sortState/hiddenCols preserved)
    const overlay = document.getElementById(ADV_OVERLAY_ID);
    if (overlay) {
      document.getElementById('wn-adv-col-popover')?.remove();
      overlay.remove();
    }
    window.removeEventListener('keydown', onAdvancedEsc);
    // Navigate via anchor so React Router handles it as a SPA transition
    const a = document.createElement('a');
    a.href = 'https://www.whatnot.com/order/' + orderId;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Global popstate — handles navigate-away cleanup and restore-on-back
  window.addEventListener('popstate', () => {
    if (window.location.pathname === ADV_FAKE_PATH) {
      // Back-navigated to advanced view — restore overlay if state is available
      if (!document.getElementById(ADV_OVERLAY_ID) && savedOverlayState && currentRows) {
        const { scrollTop } = savedOverlayState;
        savedOverlayState = null;
        openAdvancedOrders({ skipPush: true, preloadedRows: currentRows, restoreScrollTop: scrollTop });
      }
    } else {
      // Left the fake path while overlay was open → dismiss it fully
      const overlay = document.getElementById(ADV_OVERLAY_ID);
      if (overlay) {
        document.getElementById('wn-adv-col-popover')?.remove();
        overlay.remove();
        window.removeEventListener('keydown', onAdvancedEsc);
        hiddenCols        = new Set(DEFAULT_HIDDEN);
        sortState         = { col: -1, dir: 'asc' };
        currentRows       = null;
        savedOverlayState = null;
      }
    }
  });

  // ── Inject "Advanced" button into Activity header ───────────────────────────
  function injectAdvancedButton() {
    const friendsBtns = document.querySelectorAll('button[aria-label="Friends"]');
    for (const friendsBtn of friendsBtns) {
      const headerRow = friendsBtn.parentElement;
      if (!headerRow) continue;

      // Confirm this is the Activity panel header: sibling <strong> says "Activity"
      const titleEl = headerRow.querySelector('strong');
      if (!titleEl || titleEl.textContent.trim() !== 'Activity') continue;

      // Already injected?
      if (headerRow.querySelector('#' + ADV_BTN_ID)) continue;

      ensureStyles();

      const btn = document.createElement('button');
      btn.id = ADV_BTN_ID;
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Advanced Orders');
      // Copy Friends button class list so it matches the native style exactly
      btn.className = friendsBtn.className;

      const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" role="presentation"><path fill-rule="evenodd" d="M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v4h6V5H4zm8 0v4h8V5h-8zM4 11v4h6v-4H4zm8 0v4h8v-4h-8zM4 17v2h6v-2H4zm8 0v2h8v-2h-8z" clip-rule="evenodd" fill="currentColor"/></svg>`;
      btn.innerHTML = `<div class="flex items-center gap-2"><div class="shrink-0">${iconSvg}</div>Advanced</div>`;

      btn.addEventListener('click', openAdvancedOrders);

      // Insert before Friends so layout is: [Activity title] ... [Advanced][Friends]
      // margin-left:auto (from CSS) causes both buttons to cluster on the right
      friendsBtn.insertAdjacentElement('beforebegin', btn);
    }
  }

  // ── MutationObserver watches for the Activity panel to open/render ──────────
  let debounceTimer = null;
  const obs = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(injectAdvancedButton, 50);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Attempt immediately in case panel is already rendered
  injectAdvancedButton();

  // ── Auto-open on direct navigation / reload to the fake path ─────────────
  // The server returns 404 for /wn-advanced-orders, but the content script
  // still runs. Do a real navigation to / (loads the live React app) and set
  // a sessionStorage flag so the overlay reopens once the real page loads.
  if (window.location.pathname === ADV_FAKE_PATH) {
    sessionStorage.setItem('wn_adv_reopen', '1');
    location.replace('/');
  } else if (sessionStorage.getItem('wn_adv_reopen')) {
    sessionStorage.removeItem('wn_adv_reopen');
    openAdvancedOrders();
  }
})();
