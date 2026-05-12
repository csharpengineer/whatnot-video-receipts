# Advanced Orders Dashboard — Task List

Work through these one prompt at a time. Each task is self-contained.

---

## TASK 1 — CSV Caching + Reload Button
- Store fetched CSV text + timestamp in `chrome.storage.local` keyed by user (derive key from the `usid` cookie)
- On open, if cached data exists and age < 15 min, use it immediately (no spinner)
- Show "Last updated X min ago" in the header meta area
- Add a **Reload Orders** toolbar button that forces a fresh fetch, updates the cache, and re-renders
- Mark button as loading (spinner) during fetch; restore on completion or error

---

## TASK 2 — Toolbar
Add a fixed toolbar row between the header and the content area. Buttons:
- **Reload Orders** (from Task 1)
- **Export CSV** — triggers download of the *currently filtered* rows as a CSV file (not the raw one), using `chrome.downloads`
- Toolbar should be light/dark aware and visually separated from the header

---

## TASK 3 — Column Visibility + Hidden Defaults
- Hide by default: `order id`, `order numeric id`, `buyer`, `order currency`, `taxes currency`
- Add a **Columns** toggle button in the toolbar that opens a small popover/panel with a checkbox per column to show/hide
- Persist column visibility to `chrome.storage.local`

---

## TASK 4 — Order Link Icon Per Row
- Add a non-data first column with a small external-link icon (↗)
- Clicking it: closes the Advanced Orders overlay (preserving full UI state — filters, sort, scroll, active tab), navigates to `https://www.whatnot.com/order/<order_id>`
- When the user navigates back (popstate or back button), re-open the overlay in its preserved state
- State to preserve: active tab, sort col/dir, all filter values, scroll position

---

## TASK 5 — Left Sidebar: Checkbox Filters
Left sidebar (~200px), collapsible. Sections:
- **Order Style** — checkboxes: `giveaway`, `direct_order`, others found in data (dynamic)
- **Order Status** — checkboxes: `completed`, `processing`, others (dynamic)
- **Product Category** — scrollable checkbox list of all unique values, sorted alpha, with counts
- **Seller** — scrollable checkbox list with counts, search-within
- All filters are AND'd together; update footer counts + totals live
- Persist filter state to `chrome.storage.session`

---

## TASK 6 — Top Search Bar
- Single free-text input that filters across: product name, product description, seller, product category
- Debounced 150ms
- "X" clear button
- Match highlight in rendered cells (bold/yellow the matched substring)
- Show filtered row count ("Showing 42 of 1,441 orders") in the header meta area

---

## TASK 7 — Date Range Filter
In the toolbar or sidebar:
- **From / To** date inputs (defaulting to all-time)
- Filter is applied against `processed_date` column
- Quick-select chips: **Last 30 days**, **Last 90 days**, **This year**, **All time**

---

## TASK 8 — Summary Stat Cards
A row of KPI cards just below the toolbar, showing totals for the *currently filtered* rows:
- Orders (count)
- Total Spent (subtotal + shipping + taxes)
- Avg Order Value
- Unique Sellers
- Giveaway vs Paid split (small pill)
Cards update live as filters change.

---

## TASK 9 — Charts Tab
Add two tabs below the toolbar: **Orders** (the grid) and **Charts**.

Charts tab contains (all filtered-data-aware):
1. **Spending over time** — line chart, x = month, y = total spent. Toggleable: subtotal / shipping / taxes / total
2. **Orders by Category** — pie/donut chart (top 10 categories + "Other")
3. **Orders by Seller** — horizontal bar chart, top 15 sellers by order count
4. **Order Style breakdown** — simple donut: giveaway vs direct_order

Use a lightweight chart library loaded from the extension bundle (no CDN). Candidate: **Chart.js** (UMD build, ~200 KB) injected as a web-accessible resource.

---

## TASK 10 — Performance: Virtual Scrolling
1,441 rows renders fine today, but may grow. Replace the `<tbody>` with a virtual scroller:
- Render only the ~30 visible rows at a time
- Recalculate on scroll (requestAnimationFrame-throttled)
- Keep sticky header and footer totals working
- Alternative: paginate (50 rows/page with prev/next) — simpler, decide at implementation time

---

## TASK 11 — Visual Polish
- Alternating row stripe (subtle)
- Column resize handles (drag to widen/narrow)
- "No results" empty state illustration when all filters combine to zero rows
- Tooltip on truncated cells (already have `title`; ensure it works)
- Smooth fade-in transition when overlay opens
- Loading skeleton rows instead of spinner (matches table column widths)
- Mobile/narrow viewport: collapse sidebar into a filter drawer triggered by a filter icon button

---

## TASK 12 — Seller Quick-View Popover
- Hovering/clicking a seller name in the grid shows a small popover:
  - Seller avatar (from activity feed data cache if available)
  - Premier wings if applicable
  - Total orders from this seller (in current dataset)
  - Total spent with this seller
  - Link to seller's Whatnot page
- Dismiss on click-outside or Escape

---

## Ideas Backlog (not yet scoped)
- **Duplicate detection**: flag orders with same product name + seller within N days
- **Wishlist / notes**: allow adding a private note to any order row, stored in `chrome.storage.local`
- **Price history**: if same product appears multiple times, show a sparkline of price over time in a tooltip
- **Tag system**: user-defined color tags on orders, filterable
- **Share/screenshot**: button to copy a PNG of the current chart to clipboard
- **Keyboard shortcuts**: `r` = reload, `e` = export, `f` = focus search, `Esc` = close
- **Multi-sort**: hold Shift + click column header to add secondary sort
