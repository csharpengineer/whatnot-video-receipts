# Whatnot Video Receipts — Copilot Instructions

## Project Overview
Chrome MV3 extension for `whatnot.com`. Two main features:
1. **Video Receipt player** — on order detail pages (`/order/*`), adds a button to watch the livestream recording of the sale moment, with clip download and full-video download.
2. **Activity feed enhancement** — on any Whatnot page, augments the Activity sidebar (Purchases tab) with: seller avatar + wings, timestamps with time, description, shipping service + ETA, and CSS-reordered layout.

---

## File Structure

| File | World | Run At | Purpose |
|---|---|---|---|
| `early_content.js` | MAIN | document_start | Patches `window.fetch` before Apollo; injects extra fields into `GetMyPurchases` GQL query; stores results in `window.__wn_ext_orders_map` |
| `injected.js` | MAIN (injected `<script>`) | — | Reads Apollo cache; handles all MAIN-world logic: video receipt fetch, HLS playback, clip download, activity data lookup, order page metadata dispatch |
| `content.js` | Isolated | document_idle | DOM manipulation: adds video receipt button, overlay player, order page enhancements (date, shipping, seller avatar/stats/bio, tracking, sales channel pill), activity feed row injection |
| `content.css` | Isolated | document_idle | Styles for overlay, buttons, and CSS `order`-based activity feed layout |
| `background.js` | Service worker | — | Handles `chrome.downloads.download()` for full-video download |
| `hls.min.js` | MAIN (injected) | — | HLS.js library for video playback |
| `manifest.json` | — | — | MV3 manifest; two content_script entries |

### manifest.json content_scripts
- Entry 1: `early_content.js`, `world: "MAIN"`, `run_at: "document_start"`, matches `/order/*`
- Entry 2: `content.js` + `content.css`, isolated world, `run_at: "document_idle"`, matches `/order/*`

Note: `injected.js` is NOT in content_scripts — it is injected as a `<script>` tag by `content.js` at runtime so it runs in the MAIN world.

---

## IPC (Cross-World Communication)
All communication uses `window.dispatchEvent(new CustomEvent(name, { detail }))` and `window.addEventListener(name, ...)`.

| Event Name | Direction | Payload |
|---|---|---|
| `__whatnot_ext_request__` | content.js → injected.js | `{ requestId, uuid }` — trigger video receipt fetch |
| `__whatnot_ext_response__` | injected.js → content.js | `{ requestId, indexUrl, timeOffset, countdown, mp4BaseUrl, ... }` or `{ requestId, error }` |
| `__whatnot_ext_play__` | content.js → injected.js | `{ indexUrl, timeOffset }` |
| `__whatnot_ext_seek__` | content.js → injected.js | `{ time }` |
| `__whatnot_ext_destroy__` | content.js → injected.js | — |
| `__whatnot_ext_download_clip__` | content.js → injected.js | — |
| `__whatnot_ext_download_resp__` | injected.js → content.js | `{ url, filename }` or `{ error }` |
| `__whatnot_ext_meta__` | injected.js → content.js | Full order page metadata (see below) |
| `__whatnot_ext_activity_req__` | content.js → injected.js | `{ uuids: string[] }` |
| `__whatnot_ext_activity_resp__` | injected.js → content.js | `{ [uuid]: { createdAt, sellerUsername, profileImageUrl, isPremierShop, shippingServiceName, courierLogoSmallUrl, trackingEta, description } }` |

### `__whatnot_ext_meta__` payload (order page)
```
createdAt, expiresAt, shippingServiceName, courierLogoSmallUrl,
itemTitle, description, listingAttributes,
sellerRatingOverall, sellerRatingCount, soldCount, averageShipDays,
profileImageUrl, isPremierShop, isVerifiedSeller, sellerBio,
salesChannel, trackingTitle, trackingEta, trackingIsDelayed, trackingArrivesToday
```

---

## Apollo Cache Reading (injected.js)
Whatnot uses Apollo Client v3. Cache is at `window.__APOLLO_CLIENT__.cache.extract()` — a normalized flat object with `__ref` pointers.

Key types:
- `OrderNode:<id>` — has `uuid`, `createdAt`, `expiresAt`
- `OrderItemNode:<id>` — has `order.__ref`, `listing.__ref`
- `ListingNode:<id>` — has `user.__ref`, `description`, `salesChannel`
- `PublicUserNode:<id>` (seller) — has `username`, `profileImage.__ref`, `premierShopStatus.isPremierShop`, `isVerifiedSeller`, `bio`, `sellerRating`, `soldCount`, `averageShipDays`
- `ShipmentNode:<id>` — has `orderItems: [{ __ref }]`, `shippingServiceName`, `courierLogoSmallUrl`, `trackingMetadata.{ title, eta, isDelayed, isArrivingToday }`

Shipment is found by reverse-lookup: find a `ShipmentNode` whose `orderItems` array contains a `__ref` to the target `OrderItemNode`.

---

## `early_content.js` — Fetch Patch
Intercepts `GetMyPurchases` GraphQL requests. Guard: `b.operationName === 'GetMyPurchases' && !b.query.includes('shipment{')`.

**Injects into query:**
- Into `listing{...}`: adds `description user{id username profileImage{id url __typename} premierShopStatus{isPremierShop __typename} __typename}`
- After listing's `__typename}}` (closing user+listing): adds `shipment{shippingServiceName courierLogoSmallUrl trackingMetadata{eta __typename} __typename}`

**Stores in `window.__wn_ext_orders_map[uuid]`:**
```js
{ sellerUsername, createdAt, profileImageUrl, isPremierShop,
  shippingServiceName, courierLogoSmallUrl, trackingEta, description }
```
This is the fallback for `injected.js` when Apollo cache doesn't have the data yet.

---

## Activity Feed Enhancement (content.js `watchActivityFeed` IIFE)

### Data flow
1. `MutationObserver` on `document.body` fires (debounced 50ms)
2. Collects all `a[href^="/order/"]` UUIDs visible
3. `fetchMissing(uuids)` dispatches `__whatnot_ext_activity_req__` for any not in `dataCache`
4. `injected.js` reads Apollo cache + `__wn_ext_orders_map` fallback, dispatches `__whatnot_ext_activity_resp__`
5. `dataCache` (Map) is populated; `applyAll()` calls `applyToLink(link)` for every link

### `applyToLink(link)` — what it does
Wrapped in `try { } catch (_) {}` for safety. All insertions are **afterend** of the last React-managed child (dateRow or shippingRowEl) — never between React siblings.

1. **Date+time** — finds `strong` with text `"Date:"`, updates `nextElementSibling.textContent` with full locale timestamp
2. **Seller top-right** — appends `<span>` with avatar img + optional wings SVG + username to `.flex.justify-between` (the status badge row). Uses class `wn-feed-seller-top` as guard.
3. **Shipping row** — clones dateRow (flex row), adds `wn-feed-shipping` class, inserts `afterend` dateRow. Contains courier logo + service name + `· ETA: date` inline if `trackingEta` present.
4. **Description row** — clones shippingRowEl (or dateRow), removes `wn-feed-shipping`, adds `wn-feed-desc`. Inserts `afterend` shippingRowEl. Single line, `text-overflow: ellipsis`.

Also stamps `min-width:0; overflow:hidden` on the flex column parent (`div.flex.w-full.flex-col.gap-1`) to prevent horizontal scroll.

### React DOM Safety Rule (CRITICAL)
**Never insert nodes between React-managed siblings.** The flex column has React children at indices 0–3 (status row, title, purchased row, date row). Inserting between them causes React error #418, component unmount, and all activity feed modifications stop working. Only safe: append as last child, or `insertAdjacentElement('afterend')` on the **last** React child or on our own previously-inserted nodes.

### CSS layout (content.css)
Uses `order` property on the flex column to visually move description (order:3) between title (order:2) and purchased (order:4), while keeping DOM order React-safe:
```css
a[href^="/order/"] .flex.w-full.flex-col.gap-1 > :nth-child(1) { order: 1; }
a[href^="/order/"] .flex.w-full.flex-col.gap-1 > :nth-child(2) { order: 2; }
a[href^="/order/"] .flex.w-full.flex-col.gap-1 > :nth-child(3) { order: 4; }
a[href^="/order/"] .flex.w-full.flex-col.gap-1 > :nth-child(4) { order: 5; }
a[href^="/order/"] .flex.w-full.flex-col.gap-1 > .wn-feed-desc     { order: 3; }
a[href^="/order/"] .flex.w-full.flex-col.gap-1 > .wn-feed-shipping { order: 6; }
```
Image thumbnail uses `align-self: flex-start` to prevent stretching when text rows are added.

### Wings SVG
`FEED_WINGS_SVG` uses gradient IDs `fwng0`/`fwng1` (avoid conflict with order page `WINGS_SVG` which uses different IDs). Rendered as `innerHTML` of an absolutely positioned overlay span inside the avatar wrapper.

---

## Order Page Enhancement (content.js `__whatnot_ext_meta__` listener)

Fires when `injected.js` dispatches order metadata. Inserts/modifies:
- **Order date** with full time (not just date)
- **Return By** deadline
- **Shipping service** name + courier logo under "Track your purchase" heading
- **Tracking status** title (bold) with colored badge: green "Arriving Today" or red "Delayed"
- **Sales channel pill** on item title (`Live Auction` / `Fixed Price` / `Auction`)
- **Seller avatar** (32px circle) + optional premier wings next to seller link (`#wn-seller-avatar`)
- **Verified badge** (blue circle checkmark) appended to seller link (`#wn-verified-badge`)
- **Seller bio** full text below seller wrap (`#wn-seller-bio`)
- **Seller stats** (rating · avg ship days · sold count) (`#wn-seller-stats`)
- `Sold By` label gets `white-space: nowrap`

All insertions use MutationObserver retry pattern: `if (!insertX()) { obs = new MutationObserver(() => { if (insertX()) obs.disconnect(); }); obs.observe(...) }`.

---

## Video Receipt Feature (injected.js)

On `__whatnot_ext_request__` with order UUID:
1. Fetches auth token from Apollo cache or meta tag
2. Calls `GetMyOrder` GQL for `videoReceipt { videoUrl, status, livestreamId }`
3. Fetches master m3u8 → parses VOD index URL
4. Fetches index m3u8 → extracts `TIME-OFFSET`, `countdown` param, `EXT-X-MAP` URI
5. Dispatches `__whatnot_ext_response__` with all data

Clip download (`__whatnot_ext_download_clip__`): fetches init segment + fragment segments for the sale window (timeOffset to timeOffset+countdown+5s), fixes moov duration metadata, remaps tfdt timestamps, combines into a single fMP4 blob, sends as object URL for download via background.js.

---

## Known Patterns & Gotchas

- **content.css must be UTF-8 without BOM** — Chrome rejects it otherwise. When writing via PowerShell use `[System.IO.File]::WriteAllText(path, content, [System.Text.UTF8Encoding]::new($false))`
- **`trackingEta` is a Unix epoch number** (seconds) when set — convert with `new Date(etaNum * 1000).toLocaleDateString(...)`
- **`listing` variable scoping** — in the activity handler, declare `let listing = null` before the `if (orderKey)` block; using `const` inside the block and referencing it outside causes a silent `ReferenceError` caught by `try/catch`, preventing the response event from firing
- **Description row class inheritance** — when cloning `shippingRowEl` for the description row, call `row.classList.remove('wn-feed-shipping')` before adding `wn-feed-desc`, otherwise both CSS `order` rules apply and the wrong one wins
- **`dataCache` is in-memory per page load** — survives React re-renders but is cleared on full navigation. The `MutationObserver` calls `fetchMissing` on every mutation so data is re-requested after SPA navigation.
- **`early_content.js` guard** uses `!b.query.includes('shipment{')` to avoid double-patching. If the query shape changes and no longer contains this string naturally, the guard may need updating.
