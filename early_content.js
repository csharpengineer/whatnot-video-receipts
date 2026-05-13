// Runs at document_start in MAIN world — direct page context, no chrome APIs needed.
// Patches window.fetch before React/Apollo makes any calls, intercepts GetMyPurchases
// to add user{id username} to listing selections, and stores results in
// window.__wn_ext_orders_map for injected.js to read from Apollo cache fallback.
(function () {
  window.__wn_ext_orders_map = window.__wn_ext_orders_map || {};
  var _origFetch = window.fetch;
  window.fetch = async function (input, init) {
    var isTarget = false;
    var modInit = init;
    if (init && typeof init.body === 'string') {
      try {
        var b = JSON.parse(init.body);
        if (b.operationName === 'GetMyOrder' && b.query &&
            !b.query.includes(' description')) {
          // Inject description into inline listing{} selections and ListingNode fragment definitions
          b.query = b.query
            .replace(/(fragment\s+\w+\s+on\s+ListingNode\s*\{)/g, '$1 description ')
            .replace(/\blisting\s*\{(?![^}]*description)/g, 'listing{ description ');
          modInit = Object.assign({}, init, { body: JSON.stringify(b) });
        } else if (b.operationName === 'GetMyPurchases' && b.query &&
            !b.query.includes('shipment{')) {
          isTarget = true;
          // Add user{...} + profileImage + premierShopStatus to every listing selection
          b.query = b.query.replace(
            /listing\{((?:[^{}]|\{[^{}]*\})*)\}/g,
            function (m, inner) {
              return 'listing{' + inner + ' description user{id username profileImage{id url __typename} premierShopStatus{isPremierShop __typename} __typename}}';
            }
          );
          // Add shipment{...} to every item node (after listing closes, before item node's __typename)
          // Pattern: __typename}} closes user+listing; \s*__typename} closes the item node
          b.query = b.query.replace(
            /__typename}}(\s*)__typename}/,
            '__typename}} $1shipment{shippingServiceName courierLogoSmallUrl trackingMetadata{eta __typename} __typename} $1__typename}'
          );
          modInit = Object.assign({}, init, { body: JSON.stringify(b) });
        }
      } catch (e) {}
    }
    var resp = await _origFetch.apply(this, [input, modInit]);
    if (isTarget) {
      try {
        resp.clone().json().then(function (data) {
          var edges = (data && data.data && data.data.myOrders &&
                       data.data.myOrders.edges) || [];
          edges.forEach(function (edge) {
            var node = edge && edge.node;
            if (!node || !node.uuid) return;
            var username = null, profileImageUrl = null, isPremierShop = false;
            var shippingServiceName = null, courierLogoSmallUrl = null, description = null, trackingEta = null;
            var itemEdges = (node.items && node.items.edges) || [];
            for (var i = 0; i < itemEdges.length; i++) {
              var itemNode = itemEdges[i] && itemEdges[i].node;
              if (!itemNode) continue;
              var listing = itemNode.listing;
              var u = listing && listing.user && listing.user.username;
              if (u && !username) {
                username = u;
                profileImageUrl = (listing.user.profileImage && listing.user.profileImage.url) || null;
                isPremierShop = !!(listing.user.premierShopStatus && listing.user.premierShopStatus.isPremierShop);
                description = listing.description || null;
              }
              if (!shippingServiceName && itemNode.shipment && itemNode.shipment.shippingServiceName) {
                shippingServiceName = itemNode.shipment.shippingServiceName;
                courierLogoSmallUrl = (itemNode.shipment.courierLogoSmallUrl) || null;
                trackingEta = (itemNode.shipment.trackingMetadata && itemNode.shipment.trackingMetadata.eta) || null;
              }
              if (username && shippingServiceName) break;
            }
            window.__wn_ext_orders_map[node.uuid] = {
              sellerUsername: username,
              createdAt: node.createdAt || null,
              profileImageUrl: profileImageUrl,
              isPremierShop: isPremierShop,
              shippingServiceName: shippingServiceName,
              courierLogoSmallUrl: courierLogoSmallUrl,
              description: description,
              trackingEta: trackingEta,
            };
          });
        }).catch(function () {});
      } catch (e) {}
    }
    return resp;
  };
})();
