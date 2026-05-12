// advanced.js — Activity drawer "Advanced Orders" button + full-page overlay
// Runs on all Whatnot pages via manifest content_scripts
(() => {
  'use strict';

  const ADV_BTN_ID        = 'wn-advanced-btn';
  const ADV_OVERLAY_ID    = 'wn-advanced-overlay';
  const ADV_FAKE_PATH     = '/wn-advanced-orders';
  const ADV_STYLE_ID      = 'wn-advanced-styles';
  const CACHE_KEY_PREFIX  = 'wn_adv_gql_';
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
          user { username premierShopStatus { isPremierShop __typename } isVerifiedSeller __typename }
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
      'Item', 'Description', 'Category', 'Seller', 'Premier Seller', 'Verified Seller',
      'Qty', 'Item Price',
      'Subtotal', 'Shipping', 'Tax', 'Auth Fee', 'Credits', 'Total',
      'Shipping Service', 'ETA', 'Tracking',
    ];
    const fmtMoney  = (m) => m?.amount != null ? (m.amount / 100).toFixed(2) : '';
    const fmtDate   = (s) => s ? new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
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

  function formatCacheAge(timestamp) {
    const ageMins = Math.floor((Date.now() - timestamp) / 60000);
    if (ageMins < 1) return 'just now';
    if (ageMins === 1) return '1 min ago';
    return `${ageMins} min ago`;
  }

  // ── Export currently loaded rows as a CSV file download ───────────────────
  function exportCurrentGrid() {
    if (!currentRows || currentRows.length < 1) return;
    const csvContent = currentRows.map(row =>
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
  overflow: auto;
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
  padding: 7px 12px;
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

/* ── Order link column ───────────────────────────────────────────────────── */
.wn-adv-link-cell { width: 28px; min-width: 28px; max-width: 28px; text-align: center; padding: 0 2px !important; }
.wn-adv-link-btn {
  background: none; border: none; cursor: pointer; padding: 2px 5px;
  font-size: 0.85rem; line-height: 1; border-radius: 4px;
  color: #6c5ce7; transition: background 0.15s;
}
.wn-adv-link-btn:hover { background: rgba(108,92,231,0.15); }
html.dark .wn-adv-link-btn { color: #a29bfe; }
html.dark .wn-adv-link-btn:hover { background: rgba(162,155,254,0.15); }
tfoot .wn-adv-link-cell { font-size: 0.72rem; opacity: 0.65; text-align: left; white-space: nowrap; }

/* ── Advanced button in Activity header ─────────────────────────────────── */
#${ADV_BTN_ID} {
  margin-left: auto;
  margin-right: 8px;
}
    `.trim();
    (document.head || document.documentElement).appendChild(style);
  }

  // ── Persistent state ─────────────────────────────────────────────────────
  let sortState   = { col: -1, dir: 'asc' };
  let currentRows = null; // last loaded [headers, ...data]; used by export
  // Columns hidden by default (matched by lowercase header name)
  const DEFAULT_HIDDEN = new Set(['uuid', 'description', 'premier seller', 'verified seller', 'auth fee']);
  let hiddenCols = new Set(DEFAULT_HIDDEN); // indices updated each time headers are known
  let savedOverlayState = null; // { scrollTop } — set by goToOrder, consumed on back-navigate restore

  // ── Render the parsed CSV rows into the overlay body ──────────────────────
  function renderGrid(rows, container) {
    if (rows.length < 2) {
      container.innerHTML = '<div id="wn-adv-status"><p>No orders found.</p></div>';
      return;
    }
    const headers = rows[0];
    let dataRows = rows.slice(1);

    // Build index-based hidden set from header names.
    // Only initialise from DEFAULT_HIDDEN on first render (hiddenCols has strings).
    // On subsequent renders (Reload) keep user-modified index state intact.
    const currentHiddenIsIndexed = [...hiddenCols].every(v => typeof v === 'number');
    if (!currentHiddenIsIndexed) {
      hiddenCols = new Set(
        headers.map((h, i) => DEFAULT_HIDDEN.has(h.trim().toLowerCase()) ? i : -1).filter(i => i >= 0)
      );
    }

    // Detect numeric columns (currency or plain number)
    const isNumeric = headers.map((_, ci) =>
      dataRows.every(r => {
        const v = String(r[ci] ?? '').trim().replace(/^\$/, '');
        return v === '' || !isNaN(Number(v));
      })
    );

    // Detect date columns — at least one non-empty value that parses as a date,
    // and all non-empty values parse as dates. Excludes already-numeric columns.
    const isDate = headers.map((_, ci) => {
      if (isNumeric[ci]) return false;
      const nonEmpty = dataRows.map(r => String(r[ci] ?? '').trim()).filter(v => v !== '');
      return nonEmpty.length > 0 && nonEmpty.every(v => !isNaN(Date.parse(v)));
    });

    function sortedRows() {
      if (sortState.col < 0) return dataRows;
      const ci = sortState.col;
      const numeric = isNumeric[ci];
      const date    = isDate[ci];
      return [...dataRows].sort((a, b) => {
        const av = String(a[ci] ?? '').trim().replace(/^\$/, '');
        const bv = String(b[ci] ?? '').trim().replace(/^\$/, '');
        let cmp;
        if (numeric)    { cmp = (parseFloat(av) || 0) - (parseFloat(bv) || 0); }
        else if (date)  { cmp = (Date.parse(av) || 0) - (Date.parse(bv) || 0); }
        else            { cmp = av.localeCompare(bv, undefined, { sensitivity: 'base' }); }
        return sortState.dir === 'asc' ? cmp : -cmp;
      });
    }

    // Numeric columns that are IDs or counts — don't sum in footer
    const NON_ADDITIVE = new Set(['order #', 'qty']);

    function computeTotals(rowset) {
      return headers.map((h, ci) => {
        if (!isNumeric[ci] || NON_ADDITIVE.has(h.toLowerCase())) return '';
        const sum = rowset.reduce((acc, r) => acc + (parseFloat(String(r[ci] ?? '').replace(/^\$/, '')) || 0), 0);
        const hasDollar = rowset.some(r => String(r[ci] ?? '').trim().startsWith('$'));
        return hasDollar ? `$${sum.toFixed(2)}` : (Number.isInteger(sum) ? String(sum) : sum.toFixed(2));
      });
    }

    const wrap = document.createElement('div');
    wrap.id = 'wn-adv-table-wrap';

    const table = document.createElement('table');
    table.id = 'wn-adv-table';

    // ── thead ──
    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    // Non-sortable link column header
    const linkTh = document.createElement('th');
    linkTh.className = 'wn-adv-link-cell';
    headerTr.appendChild(linkTh);
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

    function applyColumnVisibility() {
      table.querySelectorAll('tr').forEach(tr => {
        tr.querySelectorAll('th[data-ci], td[data-ci]').forEach(cell => {
          const ci = Number(cell.dataset.ci);
          cell.style.display = hiddenCols.has(ci) ? 'none' : '';
        });
      });
    }

    function rebuildBody() {
      // Update header sort indicators (skip link column — select by data-ci)
      headerTr.querySelectorAll('th[data-ci]').forEach((th) => {
        const ci = Number(th.dataset.ci);
        th.classList.toggle('wn-sort-active', ci === sortState.col);
        const arrow = th.querySelector('.wn-sort-arrow');
        if (ci === sortState.col) {
          arrow.textContent = sortState.dir === 'asc' ? '▲' : '▼';
        } else {
          arrow.textContent = '⬍';
        }
      });
      const sorted = sortedRows();
      tbody.innerHTML = '';
      sorted.forEach(row => {
        const tr = document.createElement('tr');
        // Link icon cell (always visible)
        const linkTd = document.createElement('td');
        linkTd.className = 'wn-adv-link-cell';
        const linkBtn = document.createElement('button');
        linkBtn.className = 'wn-adv-link-btn';
        linkBtn.type = 'button';
        linkBtn.title = 'Open order';
        linkBtn.textContent = '↗';
        const orderId = row[0]; // order id is always column 0
        linkBtn.addEventListener('click', (e) => { e.stopPropagation(); goToOrder(orderId); });
        linkTd.appendChild(linkBtn);
        tr.appendChild(linkTd);
        headers.forEach((_, ci) => {
          const td = document.createElement('td');
          td.dataset.ci = ci;
          td.textContent = row[ci] ?? '';
          td.title = row[ci] ?? '';
          if (isNumeric[ci]) td.style.textAlign = 'right';
          if (hiddenCols.has(ci)) td.style.display = 'none';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      // Update footer totals
      const totals = computeTotals(sorted);
      footTr.innerHTML = '';
      // Link column footer: row count
      const linkFootTd = document.createElement('td');
      linkFootTd.className = 'wn-adv-link-cell';
      linkFootTd.textContent = `${sorted.length} orders`;
      footTr.appendChild(linkFootTd);
      totals.forEach((v, ci) => {
        const td = document.createElement('td');
        td.dataset.ci = ci;
        td.textContent = v;
        if (isNumeric[ci]) td.style.textAlign = 'right';
        if (hiddenCols.has(ci)) td.style.display = 'none';
        footTr.appendChild(td);
      });
    }

    rebuildBody();
    wrap.appendChild(table);

    // Expose column toggle API for Columns popover
    wrap._toggleColumn = (ci) => {
      if (hiddenCols.has(ci)) hiddenCols.delete(ci); else hiddenCols.add(ci);
      applyColumnVisibility();
    };
    wrap._headers    = headers;
    wrap._hiddenCols = () => hiddenCols;

    container.innerHTML = '';
    container.appendChild(wrap);
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
        currentRows = rows;
        const count = Math.max(0, currentRows.length - 1);
        meta.textContent = `${count.toLocaleString()} order${count !== 1 ? 's' : ''} · Updated ${formatCacheAge(timestamp)}`;
        renderGrid(currentRows, body);
        exportBtn.disabled = false;
        colsBtn.disabled   = false;
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

    if (preloadedRows) {
      currentRows = preloadedRows;
      const count = Math.max(0, currentRows.length - 1);
      meta.textContent = `${count.toLocaleString()} order${count !== 1 ? 's' : ''} · (restored)`;
      body.innerHTML = '';
      renderGrid(currentRows, body);
      exportBtn.disabled = false;
      colsBtn.disabled   = false;
      if (restoreScrollTop > 0) requestAnimationFrame(() => { body.scrollTop = restoreScrollTop; });
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
    // Reset column state so next open re-initialises from defaults
    hiddenCols = new Set(DEFAULT_HIDDEN);
    sortState  = { col: -1, dir: 'asc' };
    currentRows = null;
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
    const bodyEl = document.getElementById('wn-adv-body');
    savedOverlayState = { scrollTop: bodyEl ? bodyEl.scrollTop : 0 };
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
