/* Niche Finder — analytics + marketing tags with Google Consent Mode v2 and a
   unified conversion API.

   Google (GTM-WM23ZCZR): loads on every page with Consent Mode defaults set to
   DENIED before the container loads, then updated to granted on the visitor's
   choice. This is Google's sanctioned privacy model — no cookies/identifiers are
   written until granted, but Ads/GA4 still send cookieless pings for modelling.
   Meta Pixel (1322395659736364): has no consent mode, so it is HARD-GATED — it
   does not load at all until 'marketing' consent.

   window.NF_TRACK.* fires conversion events to BOTH: GTM via dataLayer (GA4
   ecommerce items[] on purchase/subscribe) and Meta via fbq (queued until the
   pixel is allowed to load). Load AFTER nf-consent.js; re-checks on the
   'nf:consent' banner event and on load, so it works for fresh + returning
   visitors regardless of script order. */
(function () {
  'use strict';
  var GTM_ID = 'GTM-WM23ZCZR';
  var PIXEL_ID = '1322395659736364';
  var loaded = { gtm: false, fb: false };
  var pixelQueue = []; // fbq arg-arrays held until the pixel is allowed to load

  function consent(cat) {
    try { return !!(window.NFConsent && window.NFConsent.allowed && window.NFConsent.allowed(cat)); }
    catch (e) { return false; }
  }

  window.dataLayer = window.dataLayer || [];
  function dl(obj) { try { window.dataLayer.push(obj); } catch (e) {} }
  // Consent Mode uses the arguments object, so gtag must be a real function.
  function gtag() { window.dataLayer.push(arguments); }

  // 1) Consent Mode v2 DEFAULTS — pushed BEFORE the container loads. Everything
  //    non-essential denied until the visitor opts in.
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500
  });
  gtag('set', 'url_passthrough', true);   // carry gclid/utm when cookies are denied
  gtag('set', 'ads_data_redaction', true); // redact ad identifiers while ad_storage denied

  function loadGTM() {
    if (loaded.gtm) return; loaded.gtm = true;
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var f = document.getElementsByTagName('script')[0];
    var j = document.createElement('script');
    j.async = true; j.src = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
    f.parentNode.insertBefore(j, f);
  }

  // 2) Update Consent Mode from the stored/current choice (idempotent — safe to
  //    call repeatedly).
  function updateConsent() {
    if (!window.NFConsent) return;
    var a = consent('analytics'), m = consent('marketing');
    gtag('consent', 'update', {
      analytics_storage: a ? 'granted' : 'denied',
      ad_storage: m ? 'granted' : 'denied',
      ad_user_data: m ? 'granted' : 'denied',
      ad_personalization: m ? 'granted' : 'denied'
    });
  }

  function loadPixel() {
    if (loaded.fb) return; loaded.fb = true;
    /* eslint-disable */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', PIXEL_ID);
    window.fbq('track', 'PageView');
    pixelQueue.forEach(function (args) { try { window.fbq.apply(null, args); } catch (e) {} });
    pixelQueue = [];
  }

  // Meta event (standard `track` / custom `trackCustom`). `eventId` → fbq eventID
  // so the server Conversions API deduplicates the same action.
  function fbTrack(event, params, custom, eventId) {
    var method = custom ? 'trackCustom' : 'track';
    var args = [method, event];
    if (params || eventId) args.push(params || {});
    if (eventId) args.push({ eventID: eventId });
    if (loaded.fb && window.fbq) { try { window.fbq.apply(null, args); } catch (e) {} return; }
    pixelQueue.push(args);
    if (consent('marketing')) loadPixel(); // flushes the queue
  }

  // GTM dataLayer event + optional Meta event. params.eventId is lifted out as
  // the Meta dedup key (kept out of the reported params).
  function track(gtmEvent, params, fbEvent, custom) {
    var p = params, eventId;
    if (p && p.eventId) { eventId = p.eventId; p = assign({}, p); delete p.eventId; }
    dl(assign({ event: gtmEvent }, p || {}));
    if (fbEvent) fbTrack(fbEvent, p || undefined, custom, eventId);
  }
  function assign(a, b) { if (b) for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; return a; }

  // Ecommerce event: GA4 items[] array + Meta content params, deduped.
  function commerce(gtmEvent, fbEvent, p) {
    p = p || {};
    var value = p.value, currency = p.currency || 'GBP', eventId = p.eventId;
    var item = {
      item_id: p.item_id || (gtmEvent === 'subscribe' ? 'subscription' : 'acu_topup'),
      item_name: p.item_name || (gtmEvent === 'subscribe' ? 'Niche Finder subscription' : 'ACU package'),
      item_category: gtmEvent === 'subscribe' ? 'subscription' : 'credits',
      price: value, quantity: 1
    };
    dl({ ecommerce: null }); // clear the previous object so items don't bleed across events
    dl({
      event: gtmEvent,
      ecommerce: { currency: currency, value: value, transaction_id: p.transaction_id || eventId, items: [item] }
    });
    fbTrack(fbEvent, {
      value: value, currency: currency,
      content_type: 'product', content_ids: [item.item_id], content_name: item.item_name
    }, false, eventId);
  }

  // p is passed to BOTH GTM (event params) and Meta (event params).
  window.NF_TRACK = {
    // account
    signup: function (p) { track('sign_up', p, 'CompleteRegistration'); },
    login: function (p) { track('login', p, 'Login', true); },
    lead: function (p) { track('lead', p, 'Lead'); },
    contact: function (p) { track('contact', p, 'Contact'); },
    // discovery + build
    freeScore: function (p) { track('free_score', p, 'Search'); },
    search: function (p) { track('search', p, 'Search'); },
    unlock: function (p) { track('unlock', p, 'ViewContent'); },
    generateDoc: function (p) { track('generate_document', p, 'ViewContent'); },
    download: function (p) { track('download', p, 'Download', true); },
    growthTool: function (p) { track('growth_tool', p, 'GrowthTool', true); },
    // commerce (GA4 ecommerce items[] + Meta content params)
    startCheckout: function (p) { track('begin_checkout', p, 'InitiateCheckout'); },
    purchase: function (p) { commerce('purchase', 'Purchase', p); },
    subscribe: function (p) { commerce('subscribe', 'Subscribe', p); },
    // escape hatch: NF_TRACK.event('name', {..}, 'MetaEvent', /*custom*/ true)
    event: function (name, p, fbEvent, custom) { track(name, p, fbEvent, custom); },
    // dedup + match-quality helpers for the server Conversions API
    newId: function () { return 'nfx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); },
    fbp: function () { return cookie('_fbp'); },
    fbc: function () { return cookie('_fbc'); }
  };
  function cookie(name) {
    try { var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : ''; }
    catch (e) { return ''; }
  }

  // 3) Google tag loads on every page (Consent Mode governs behaviour). The Meta
  //    pixel loads only once marketing consent exists. Consent updates flow from
  //    the stored choice + the live banner event.
  loadGTM();
  function evaluate() { updateConsent(); if (consent('marketing')) loadPixel(); }
  evaluate();
  document.addEventListener('nf:consent', evaluate);
  document.addEventListener('DOMContentLoaded', evaluate);
  window.addEventListener('load', evaluate);
})();
