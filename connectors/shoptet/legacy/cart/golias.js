/**
 * GOLIÁŠ — adapter pro nativní Shoptet košík
 * POST /action/Cart/addCartItem/?simple_ajax_cart=1
 */
(function (global) {
  "use strict";

  var ENDPOINT = "/action/Cart/addCartItem/?simple_ajax_cart=1";
  var DELAY_MS = 350;

  function validateItem(item, index) {
    if (!item) throw new Error("GOLIÁŠ: prázdná položka");
    var amount = parseInt(item.amount, 10);
    if (!amount || amount < 1) {
      throw new Error("GOLIÁŠ: položka #" + (index + 1) + " má neplatné množství");
    }
    if (item.productId != null && item.priceId != null) {
      return {
        productId: String(item.productId),
        priceId: String(item.priceId),
        amount: String(amount),
      };
    }
    if (item.priceId != null) {
      return { priceId: String(item.priceId), amount: String(amount) };
    }
    if (item.productCode) {
      return { productCode: String(item.productCode), amount: String(amount) };
    }
    throw new Error("GOLIÁŠ: položka #" + (index + 1) + " vyžaduje priceId nebo productCode");
  }

  function addViaShoptetApi(item, silent) {
    if (!global.shoptet || !global.shoptet.cartShared || !global.shoptet.cartShared.addToCart) {
      return Promise.reject(new Error("shoptet.cartShared.addToCart není k dispozici"));
    }
    var payload = {};
    if (item.priceId != null) payload.priceId = parseInt(item.priceId, 10);
    else if (item.productCode) payload.productCode = item.productCode;
    else if (item.productId != null && item.priceId != null) {
      payload.productId = parseInt(item.productId, 10);
      payload.priceId = parseInt(item.priceId, 10);
    }
    payload.amount = parseInt(item.amount, 10);
    try {
      global.shoptet.cartShared.addToCart(payload, !!silent);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function addViaPost(item, language) {
    var validated = validateItem(item, 0);
    var body = new URLSearchParams({ language: language || "cs", amount: validated.amount });
    if (validated.priceId && validated.productId) {
      body.set("productId", validated.productId);
      body.set("priceId", validated.priceId);
    } else if (validated.priceId) {
      body.set("priceId", validated.priceId);
    } else {
      return Promise.reject(new Error("POST vyžaduje priceId"));
    }
    return fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body,
      credentials: "same-origin",
    }).then(function (res) {
      if (!res.ok) throw new Error("Shoptet HTTP " + res.status);
      return res;
    });
  }

  function addItem(item, options) {
    options = options || {};
    if (global.shoptet && global.shoptet.cartShared) {
      return addViaShoptetApi(item, options.silent);
    }
    return addViaPost(item, options.language);
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function addItems(items, options) {
    options = options || {};
    if (!items || !items.length) return Promise.reject(new Error("GOLIÁŠ: prázdný seznam"));
    var chain = Promise.resolve();
    items.forEach(function (item, index) {
      chain = chain.then(function () {
        if (options.onProgress) options.onProgress(index + 1, items.length);
        return addItem(item, options);
      }).then(function () {
        if (index < items.length - 1) return delay(DELAY_MS);
      });
    });
    return chain.then(function () {
      try { document.dispatchEvent(new Event("shoptet.cart-updated")); } catch (_) {}
    });
  }

  global.GOLIAS = { addItem: addItem, addItems: addItems, ENDPOINT: ENDPOINT };
})(window);
