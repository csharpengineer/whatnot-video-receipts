// Runs in the page context (access to window.__APOLLO_CLIENT__, cookies, etc.)
// Communicates back to the content script via window.postMessage.

(function () {
  window.__wn_ext_loaded = true; // sentinel so we can verify this script ran
  window.addEventListener('__whatnot_ext_request__', async (evt) => {
    const { orderUuid, requestId } = evt.detail;

    try {
      // ── Build the same headers the app uses ──────────────────────────────
      const usidMatch = document.cookie.match(/(?:^|;\s*)usid=([^;]+)/);
      const usid = usidMatch ? usidMatch[1] : '';

      const sessionIdMatch = document.cookie.match(/(?:^|;\s*)stable-id=([^;]+)/);
      // Fall back to a generated ID for x-whatnot-app-session-id (for logging only)
      const sessionId = sessionIdMatch ? sessionIdMatch[1] : crypto.randomUUID();

      const appVersion = (() => {
        // Try to read from a meta tag or the Apollo client config
        const meta = document.querySelector('meta[name="x-whatnot-app-version"]');
        if (meta) return meta.content;
        // Derive from today's date as a fallback (format: YYYYMMDD-HHMM)
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-0000`;
      })();

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const pathname = window.location.pathname;

      const headers = {
        accept: '*/*',
        'content-type': 'application/json',
        'x-whatnot-app': 'whatnot-web',
        'x-whatnot-app-context': 'next-js/browser',
        'x-whatnot-app-pathname': pathname,
        'x-whatnot-app-screen': '/order/?',
        'x-whatnot-app-session-id': sessionId,
        'x-whatnot-app-version': appVersion,
        'x-whatnot-app-user-session-id': usid,
        authorization: 'Cookie',
        'accept-language': navigator.language || 'en-US',
        'x-client-timezone': timezone,
        'x-whatnot-usgmt': ',A,',
      };

      // ── Read order metadata from Apollo cache (already in-memory) ──────────
      // The app pre-fetches order data; we read it directly rather than adding
      // fields to GetVideoReceipt (server may hash-validate that operation body).
      let sellerUsername = '', itemTitle = '', displayId = '', orderCreatedAt = '';
      try {
        const cache = window.__APOLLO_CLIENT__?.cache?.extract?.() || {};
        const orderKey = Object.keys(cache).find(k => k.startsWith('OrderNode:'));
        const itemKey  = Object.keys(cache).find(k => k.startsWith('OrderItemNode:'));
        if (orderKey) {
          const o = cache[orderKey];
          displayId      = o?.displayId  || '';
          orderCreatedAt = o?.createdAt  || '';
        }
        if (itemKey) {
          const item    = cache[itemKey];
          const listing = cache[item?.listing?.__ref];
          const seller  = cache[listing?.user?.__ref];
          itemTitle      = listing?.title    || '';
          sellerUsername = seller?.username  || '';
        }
      } catch (_) { /* metadata is optional — don't let it break the main flow */ }

      // ── GraphQL: fetch videoReceipt.videoUrl ─────────────────────────────
      const gqlResp = await fetch(
        `/services/graphql/?operationName=GetVideoReceipt&ssr=0`,
        {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            operationName: 'GetVideoReceipt',
            variables: { id: orderUuid },
            query: `query GetVideoReceipt($id: ID!) @attribution(owner: "community") {
              myOrder(uuid: $id) {
                id
                videoReceipt {
                  videoUrl
                  status
                  livestreamId
                }
              }
            }`,
          }),
        }
      );

      const gqlData = await gqlResp.json();
      const videoReceipt = gqlData?.data?.myOrder?.videoReceipt;

      if (!videoReceipt || !videoReceipt.videoUrl) {
        window.dispatchEvent(
          new CustomEvent('__whatnot_ext_response__', {
            detail: {
              requestId,
              error:
                videoReceipt?.status === 'NO_VIDEO'
                  ? 'No video receipt is available for this order yet.'
                  : 'Could not retrieve the video receipt URL.',
            },
          })
        );
        return;
      }

      // ── Fetch master m3u8 to get the VOD index URL ───────────────────────
      const masterResp = await fetch(videoReceipt.videoUrl, {
        credentials: 'include',
      });
      const masterM3u8 = await masterResp.text();

      // ── Parse master playlist: find VOD index URL ────────────────────────
      // The master playlist lists one stream variant (/api/v2/video/presigned/index.m3u8?...)
      const indexUriMatch = masterM3u8.match(
        /^(\/api\/v2\/video\/presigned\/index\.m3u8\?[^\s]+)/m
      );
      if (!indexUriMatch) {
        window.dispatchEvent(
          new CustomEvent('__whatnot_ext_response__', {
            detail: { requestId, error: 'Could not parse master playlist.' },
          })
        );
        return;
      }

      const indexUrl = 'https://api.whatnot.com' + indexUriMatch[1];

      // ── Fetch the VOD index m3u8 to get the time offset ────────────────────
      const indexResp = await fetch(indexUrl, { credentials: 'include' });
      const indexM3u8 = await indexResp.text();

      // Extract TIME-OFFSET (position of sale moment minus countdown)
      const timeOffsetMatch = indexM3u8.match(/#EXT-X-START:TIME-OFFSET=([\d.]+)/);
      const timeOffset = timeOffsetMatch ? parseFloat(timeOffsetMatch[1]) : 0;

      // Extract countdown from the original videoUrl param
      const countdownMatch = videoReceipt.videoUrl.match(/[?&]countdown=(\d+)/);
      const countdown = countdownMatch ? parseInt(countdownMatch[1], 10) : 30;

      // Extract the base MP4 URL (EXT-X-MAP URI) for full-video download.
      // Only present for fMP4/byte-range playlists; absent for TS-segment playlists.
      const mapMatch = indexM3u8.match(/#EXT-X-MAP:URI="([^"]+)"/);
      const mp4BaseUrl = mapMatch ? mapMatch[1] : null;

      // Cache for download handlers
      _cachedIndexM3u8 = indexM3u8;
      _cachedTimeOffset = timeOffset;
      _cachedCountdown = countdown;
      _cachedMeta = { sellerUsername, itemTitle, displayId, orderCreatedAt };

      window.dispatchEvent(
        new CustomEvent('__whatnot_ext_response__', {
          detail: {
            requestId,
            indexUrl,
            timeOffset,
            countdown,
            mp4BaseUrl,
            livestreamId: videoReceipt.livestreamId,
            sellerUsername,
            itemTitle,
            displayId,
            orderCreatedAt,
          },
        })
      );
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent('__whatnot_ext_response__', {
          detail: { requestId, error: err.message },
        })
      );
    }
  });

  // ── Shared download cache (populated during request, used by clip handler) ──
  let _cachedIndexM3u8 = null;
  let _cachedTimeOffset = 0;
  let _cachedCountdown = 30;
  let _cachedMeta = {};

  // ── HLS playback lifecycle ─────────────────────────────────────────────────
  let _hlsInstance = null;

  window.addEventListener('__whatnot_ext_play__', ({ detail: { indexUrl, timeOffset } }) => {
    const video = document.getElementById('wn-video');
    if (!video) return;

    if (_hlsInstance) { _hlsInstance.destroy(); _hlsInstance = null; }

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        startPosition: timeOffset,
        enableWorker: false, // workers not available in extension context
        debug: false,
      });
      hls.loadSource(indexUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) console.warn('[WN-ext] hls fatal error', data.type, data.details);
      });
      _hlsInstance = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari: native HLS support
      video.src = indexUrl;
      video.currentTime = timeOffset;
      video.play().catch(() => {});
    }
  });

  window.addEventListener('__whatnot_ext_seek__', ({ detail: { time } }) => {
    const video = document.getElementById('wn-video');
    if (!video) return;
    video.currentTime = time;
    video.play().catch(() => {});
  });

  window.addEventListener('__whatnot_ext_destroy__', () => {
    if (_hlsInstance) { _hlsInstance.destroy(); _hlsInstance = null; }
    document.getElementById('wn-video')?.pause();
  });

  // ── Clip download ──────────────────────────────────────────────────────────

  // Shared ISO BMFF box walker. `view` and `bytes` must be views of the same
  // underlying ArrayBuffer (byteOffset-aware).
  function walkBoxes(view, bytes, start, end, cb) {
    let pos = start;
    while (pos + 8 <= end) {
      const sz = view.getUint32(pos);
      if (sz < 8) break;
      const ty = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);
      cb(pos, sz, ty);
      pos += sz;
    }
  }

  // Collect { trackId → mediaTimescale } from the moov in an init segment.
  function collectTimescales(arr) {
    const view = new DataView(arr.buffer); const bytes = arr;
    const ts = {};
    walkBoxes(view, bytes, 0, arr.byteLength, (mP, mSz, mTy) => {
      if (mTy !== 'moov') return;
      walkBoxes(view, bytes, mP + 8, mP + mSz, (tP, tSz, tTy) => {
        if (tTy !== 'trak') return;
        let id = null, scale = null;
        walkBoxes(view, bytes, tP + 8, tP + tSz, (cp, cs, ct) => {
          if (ct === 'tkhd') { const v = view.getUint8(cp+8); id = view.getUint32(v===1 ? cp+28 : cp+20); }
          if (ct === 'mdia') {
            walkBoxes(view, bytes, cp+8, cp+cs, (mp, ms, mt) => {
              if (mt === 'mdhd') { const v = view.getUint8(mp+8); scale = view.getUint32(v===1 ? mp+28 : mp+20); }
            });
          }
        });
        if (id != null && scale != null) ts[id] = scale;
      });
    });
    return ts;
  }

  // Remap tfdt boxes in fragment data (moof+mdat) using pre-collected timescales.
  function remapTfdt(arr, timeOffsetSeconds, timescales) {
    const view = new DataView(arr.buffer); const bytes = arr;
    walkBoxes(view, bytes, 0, arr.byteLength, (moofPos, moofSz, moofTy) => {
      if (moofTy !== 'moof') return;
      walkBoxes(view, bytes, moofPos+8, moofPos+moofSz, (trafPos, trafSz, trafTy) => {
        if (trafTy !== 'traf') return;
        let trackId = null;
        walkBoxes(view, bytes, trafPos+8, trafPos+trafSz, (p, s, t) => {
          if (t === 'tfhd') trackId = view.getUint32(p + 12);
        });
        if (trackId == null || timescales[trackId] == null) return;
        const shift = Math.round(timeOffsetSeconds * timescales[trackId]);
        walkBoxes(view, bytes, trafPos+8, trafPos+trafSz, (p, s, t) => {
          if (t !== 'tfdt') return;
          const ver = view.getUint8(p + 8);
          if (ver === 1) {
            const abs = view.getUint32(p+12) * 4294967296 + view.getUint32(p+16);
            const r = Math.max(0, abs - shift);
            view.setUint32(p+12, Math.floor(r / 4294967296));
            view.setUint32(p+16, r >>> 0);
          } else {
            view.setUint32(p+12, Math.max(0, view.getUint32(p+12) - shift) >>> 0);
          }
        });
      });
    });
  }

  // Fix moov duration metadata so players show the correct clip length and can
  // calculate seek byte-offsets accurately.
  function fixMoovDuration(arr, clipDurationSeconds) {
    const view = new DataView(arr.buffer); const bytes = arr;
    walkBoxes(view, bytes, 0, arr.byteLength, (moovPos, moovSz, moovTy) => {
      if (moovTy !== 'moov') return;

      // Movie timescale is in mvhd
      let movieTs = 1000;
      walkBoxes(view, bytes, moovPos+8, moovPos+moovSz, (p, s, t) => {
        if (t === 'mvhd') { const v = view.getUint8(p+8); movieTs = view.getUint32(v===1 ? p+28 : p+20); }
      });

      const setDur = (ver, p, off32, off64, ts) => {
        const d = Math.round(clipDurationSeconds * ts);
        if (ver === 1) { view.setUint32(off64, Math.floor(d/4294967296)); view.setUint32(off64+4, d>>>0); }
        else { view.setUint32(off32, d>>>0); }
      };

      walkBoxes(view, bytes, moovPos+8, moovPos+moovSz, (p, s, t) => {
        // mvhd.duration
        if (t === 'mvhd') { const v = view.getUint8(p+8); setDur(v, p, p+24, p+32, movieTs); }

        // tkhd.duration (movie ts) and mdhd.duration (media ts) inside each trak
        if (t === 'trak') {
          let mediaTs = movieTs;
          walkBoxes(view, bytes, p+8, p+s, (cp, cs, ct) => {
            if (ct === 'mdia') {
              walkBoxes(view, bytes, cp+8, cp+cs, (mp, ms, mt) => {
                if (mt === 'mdhd') { const v = view.getUint8(mp+8); mediaTs = view.getUint32(v===1 ? mp+28 : mp+20); }
              });
            }
          });
          walkBoxes(view, bytes, p+8, p+s, (cp, cs, ct) => {
            if (ct === 'tkhd') { const v = view.getUint8(cp+8); setDur(v, cp, cp+28, cp+36, movieTs); }
            if (ct === 'mdia') {
              walkBoxes(view, bytes, cp+8, cp+cs, (mp, ms, mt) => {
                if (mt === 'mdhd') { const v = view.getUint8(mp+8); setDur(v, mp, mp+24, mp+32, mediaTs); }
              });
            }
          });
        }

        // mehd.fragment_duration (movie ts) — present in fragmented MP4
        if (t === 'mvex') {
          walkBoxes(view, bytes, p+8, p+s, (ep, es, et) => {
            if (et === 'mehd') { const v = view.getUint8(ep+8); setDur(v, ep, ep+12, ep+12, movieTs); }
          });
        }
      });
    });
  }

  // Strip non-printable-ASCII, filesystem-unsafe chars, collapse whitespace.
  function sanitizeFilePart(str) {
    return (str || '')
      .replace(/[^\x20-\x7E]/g, '')        // remove non-ASCII (incl. emoji)
      .replace(/[\/\\:*?"<>|#%&]/g, '')   // remove filesystem-unsafe chars
      .trim()
      .replace(/\s+/g, '_')               // spaces → underscores
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

  function parseM3u8Segments(m3u8) {
    const lines = m3u8.split('\n');
    const mapMatch = m3u8.match(/#EXT-X-MAP:URI="([^"]+)"(?:,BYTERANGE="(\d+)@(\d+)")?/);
    let initSegment = null;
    if (mapMatch) {
      initSegment = {
        uri: mapMatch[1],
        length: mapMatch[2] != null ? parseInt(mapMatch[2]) : null,
        start: mapMatch[3] != null ? parseInt(mapMatch[3]) : 0,
      };
    }

    const segments = [];
    let cumTime = 0;
    let lastByteEnd = initSegment ? initSegment.start + (initSegment.length || 0) : 0;
    let lastUri = initSegment ? initSegment.uri : null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXTINF:')) continue;
      const duration = parseFloat(line.slice(8));
      let byteStart = null, byteLength = null, uri = lastUri;
      i++;
      while (i < lines.length && lines[i].trim().startsWith('#')) {
        const tag = lines[i].trim();
        if (tag.startsWith('#EXT-X-BYTERANGE:')) {
          const [len, off] = tag.slice(17).split('@');
          byteLength = parseInt(len);
          byteStart = off != null ? parseInt(off) : lastByteEnd;
        }
        i++;
      }
      if (i < lines.length && !lines[i].trim().startsWith('#') && lines[i].trim()) {
        uri = lines[i].trim();
        lastUri = uri;
      }
      if (byteStart != null) lastByteEnd = byteStart + byteLength;
      segments.push({ time: cumTime, duration, uri, byteStart, byteLength });
      cumTime += duration;
    }
    return { initSegment, segments };
  }

  window.addEventListener('__whatnot_ext_download_clip__', async () => {
    if (!_cachedIndexM3u8) {
      window.dispatchEvent(new CustomEvent('__whatnot_ext_download_resp__', {
        detail: { error: 'No video loaded yet — open the player first.' },
      }));
      return;
    }
    try {
      const { initSegment, segments } = parseM3u8Segments(_cachedIndexM3u8);
      const clipStart = _cachedTimeOffset;
      const clipEnd   = clipStart + _cachedCountdown + 5; // 30s countdown + 5s after sale

      const clipSegs = segments.filter(
        (s) => s.time < clipEnd && s.time + s.duration > clipStart
      );

      const fetchRange = async (uri, start, length) => {
        const headers = length != null ? { Range: `bytes=${start}-${start + length - 1}` } : {};
        const r = await fetch(uri, { headers });
        if (!r.ok && r.status !== 206) throw new Error(`Fetch failed: ${r.status}`);
        return r.arrayBuffer();
      };

      // Fetch init segment (moov) and fragment data (moof+mdat) separately
      const initBuf = initSegment
        ? await fetchRange(initSegment.uri, initSegment.start, initSegment.length)
        : null;
      const fragBufs = [];
      for (const seg of clipSegs) {
        fragBufs.push(await fetchRange(seg.uri, seg.byteStart, seg.byteLength));
      }

      const clipDuration = clipSegs.reduce((sum, s) => sum + s.duration, 0);

      // --- Fix init segment ---
      const initArr = initBuf ? new Uint8Array(initBuf) : new Uint8Array(0);
      if (initArr.byteLength) {
        fixMoovDuration(initArr, clipDuration);   // correct seek bar length + WMP duration
      }

      // Collect timescales once from moov, then remap each fragment
      const timescales = collectTimescales(initArr);
      const fragArrs = fragBufs.map(b => {
        const arr = new Uint8Array(b);
        remapTfdt(arr, _cachedTimeOffset, timescales);
        return arr;
      });

      // Combine: [moov] [moof+mdat] [moof+mdat] ...
      const totalSize = initArr.byteLength
        + fragArrs.reduce((s, a) => s + a.byteLength, 0);
      const combined = new Uint8Array(totalSize);
      let off = 0;
      combined.set(initArr, off); off += initArr.byteLength;
      for (const a of fragArrs) { combined.set(a, off); off += a.byteLength; }

      const blob = new Blob([combined.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      window.dispatchEvent(new CustomEvent('__whatnot_ext_download_resp__', {
        detail: { url, filename: buildFilename(_cachedMeta, 'clip') },
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent('__whatnot_ext_download_resp__', {
        detail: { error: err.message },
      }));
    }
  });

  // ── Activity feed enhancement: batch order data lookup ────────────────────
  window.addEventListener('__whatnot_ext_activity_req__', ({ detail: { uuids } }) => {
    try {
      const cache = window.__APOLLO_CLIENT__?.cache.extract() || {};
      const result = {};
      for (const uuid of uuids) {
        const orderKey = Object.keys(cache).find(k => k.startsWith('OrderNode:') && cache[k]?.uuid === uuid);
        let createdAt = null, sellerUsername = null, profileImageUrl = null, isPremierShop = false;
        let shippingServiceName = null, courierLogoSmallUrl = null, listing = null, trackingEta = null;
        if (orderKey) {
          const order = cache[orderKey];
          createdAt = order?.createdAt || null;
          const itemKey = Object.keys(cache).find(k =>
            k.startsWith('OrderItemNode:') && cache[k]?.order?.__ref === orderKey
          );
          const item = cache[itemKey];
          listing = cache[item?.listing?.__ref];
          const seller = cache[listing?.user?.__ref];
          sellerUsername = seller?.username || null;
          profileImageUrl = cache[seller?.profileImage?.__ref]?.url || null;
          isPremierShop = seller?.premierShopStatus?.isPremierShop ?? false;
          // Reverse-lookup ShipmentNode via its orderItems array
          const shipmentKey = itemKey ? Object.keys(cache).find(k =>
            k.startsWith('ShipmentNode:') && cache[k]?.orderItems?.some(r => r.__ref === itemKey)
          ) : null;
          const shipment = cache[shipmentKey];
          shippingServiceName = shipment?.shippingServiceName || null;
          courierLogoSmallUrl = shipment?.courierLogoSmallUrl || null;
          trackingEta = shipment?.trackingMetadata?.eta || null;
        }
        // Fallback: populated by early_content.js fetch patch
        const stored = window.__wn_ext_orders_map?.[uuid];
        if (!createdAt && stored?.createdAt) createdAt = stored.createdAt;
        if (!sellerUsername && stored?.sellerUsername) sellerUsername = stored.sellerUsername;
        if (!profileImageUrl && stored?.profileImageUrl) profileImageUrl = stored.profileImageUrl;
        if (!isPremierShop && stored?.isPremierShop) isPremierShop = stored.isPremierShop;
        if (!shippingServiceName && stored?.shippingServiceName) shippingServiceName = stored.shippingServiceName;
        if (!courierLogoSmallUrl && stored?.courierLogoSmallUrl) courierLogoSmallUrl = stored.courierLogoSmallUrl;
        if (!trackingEta && stored?.trackingEta) trackingEta = stored.trackingEta;
        const description = listing?.description || stored?.description || null;
        result[uuid] = { createdAt, sellerUsername, profileImageUrl, isPremierShop, shippingServiceName, courierLogoSmallUrl, description, trackingEta };
      }
      window.dispatchEvent(new CustomEvent('__whatnot_ext_activity_resp__', { detail: result }));
    } catch (_) {}
  });

  // ── Dispatch order metadata on load for page enhancement ─────────────────
  (function dispatchMetaOnLoad() {
    function getUuid() {
      const m = window.location.pathname.match(/^\/order\/([^/]+)/);
      return m ? m[1] : null;
    }

    function tryDispatch() {
      const uuid = getUuid();
      if (!uuid) return false;
      try {
        const cache = window.__APOLLO_CLIENT__?.cache?.extract?.() || {};
        // Match the specific OrderNode for the current URL
        const orderKey = Object.keys(cache).find(k =>
          k.startsWith('OrderNode:') && cache[k]?.uuid === uuid
        );
        if (!orderKey) return false;
        const order   = cache[orderKey];
        const itemKey = Object.keys(cache).find(k =>
          k.startsWith('OrderItemNode:') && cache[k]?.order?.__ref === orderKey
        );
        const item     = cache[itemKey];
        const listing  = cache[item?.listing?.__ref];
        const seller   = cache[listing?.user?.__ref];
        const shipment = cache[item?.shipment?.__ref];
        const createdAt           = order?.createdAt;
        const expiresAt           = order?.expiresAt;
        const shippingServiceName = shipment?.shippingServiceName || '';
        const courierLogoSmallUrl = shipment?.courierLogoSmallUrl || '';
        const itemTitle           = listing?.title || '';
        const description         = listing?.description || '';
        const listingAttributes   = (listing?.listingAttributeValues || []).map(ref => {
          const node = ref?.__ref ? cache[ref.__ref] : ref;
          if (!node) return null;
          if (typeof node === 'string') return node;
          return node.value || node.displayValue || node.name || node.label || null;
        }).filter(Boolean);
        const sellerRatingOverall = seller?.sellerRating?.overall ?? null;
        const sellerRatingCount   = seller?.sellerRating?.numReviews ?? null;
        const soldCount           = seller?.soldCount ?? null;
        const averageShipDays     = seller?.averageShipDays ?? null;
        const profileImageUrl     = cache[seller?.profileImage?.__ref]?.url || '';
        const isPremierShop       = seller?.premierShopStatus?.isPremierShop ?? false;
        const isVerifiedSeller    = seller?.isVerifiedSeller ?? false;
        const sellerBio           = seller?.bio || '';
        const salesChannel        = order?.salesChannel || '';
        const trackingMeta        = shipment?.trackingMetadata;
        const trackingTitle       = trackingMeta?.title || '';
        const trackingEta         = trackingMeta?.eta || '';
        const trackingIsDelayed   = trackingMeta?.isDelayed ?? false;
        const trackingArrivesToday = trackingMeta?.isArrivingToday ?? false;
        if (createdAt) {
          window.dispatchEvent(new CustomEvent('__whatnot_ext_meta__', {
            detail: {
              createdAt, expiresAt, shippingServiceName, courierLogoSmallUrl,
              itemTitle, description, listingAttributes,
              sellerRatingOverall, sellerRatingCount, soldCount, averageShipDays,
              profileImageUrl, isPremierShop, isVerifiedSeller, sellerBio,
              salesChannel,
              trackingTitle, trackingEta, trackingIsDelayed, trackingArrivesToday,
            },
          }));
          return true;
        }
      } catch (_) {}
      return false;
    }

    function onNavigate() {
      if (!getUuid()) return;
      // Poll until Apollo has fetched the new order (up to ~6 s)
      let attempts = 0;
      const iv = setInterval(() => {
        attempts++;
        if (tryDispatch() || attempts > 20) clearInterval(iv);
      }, 300);
    }

    // Initial page load
    if (!tryDispatch()) setTimeout(tryDispatch, 1000);

    // SPA navigation — patch history methods and listen for popstate
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = function(...a) { origPush(...a);    setTimeout(onNavigate, 0); };
    history.replaceState = function(...a) { origReplace(...a); setTimeout(onNavigate, 0); };
    window.addEventListener('popstate', onNavigate);
  })();

})();
