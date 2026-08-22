/* Niche Finder — consent-gated analytics + marketing tags, with a unified
   conversion API. Nothing loads until the visitor allows it (NFConsent):
     • Google Tag Manager (GTM-WM23ZCZR) loads only with 'analytics' consent
     • Meta Pixel (1322395659736364) loads only with 'marketing' consent
   PageView fires on load (per tag). window.NF_TRACK.* fires conversion events
   to BOTH — GTM via dataLayer, Meta via fbq — queueing until consent + load.

   Load this AFTER nf-consent.js so NFConsent exists; it also re-checks on the
   'nf:consent' event (banner choice) and on DOMContentLoaded, so it works for
   fresh and returning visitors regardless of script order. */
(function () {
  'use strict';
  var GTM_ID = 'GTM-WM23ZCZR';
  var PIXEL_ID = '1322395659736364';
  var loaded = { gtm: false, fb: false };
  var pixelQueue = []; // fbq arg-arrays held until the pixel is live

  function consent(cat) {
    try { return !!(window.NFConsent && window.NFConsent.allowed && window.NFConsent.allowed(cat)); }
    catch (e) { return false; }
  }

  // dataLayer is safe to populate before GTM loads (pushes replay on load).
  window.dataLayer = window.dataLayer || [];
  function dl(obj) { try { window.dataLayer.push(obj); } catch (e) {} }

  function loadGTM() {
    if (loaded.gtm) return; loaded.gtm = true;
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var f = document.getElementsByTagName('script')[0];
    var j = document.createElement('script');
    j.async = true; j.src = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
    f.parentNode.insertBefore(j, f);
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
    // Replay any conversion events captured before consent/load.
    pixelQueue.forEach(function (args) { try { window.fbq.apply(null, args); } catch (e) {} });
    pixelQueue = [];
  }

  // Fire a Meta standard (track) or custom (trackCustom) event, respecting
  // consent + load state. `eventId` (when present) is passed as fbq's eventID so
  // the server-side Conversions API can deduplicate the same action.
  function fbTrack(event, params, custom, eventId) {
    var method = custom ? 'trackCustom' : 'track';
    var args = [method, event];
    if (params || eventId) args.push(params || {});
    if (eventId) args.push({ eventID: eventId });
    if (loaded.fb && window.fbq) { try { window.fbq.apply(null, args); } catch (e) {} return; }
    pixelQueue.push(args);
    if (consent('marketing')) loadPixel(); // flushes the queue
  }

  // Unified helper: GTM dataLayer event + optional Meta event (standard or,
  // when `custom` is true, a Meta custom event). A params.eventId is lifted out
  // as the Meta dedup key (kept out of the reported params).
  function track(gtmEvent, params, fbEvent, custom) {
    var p = params, eventId;
    if (p && p.eventId) { eventId = p.eventId; p = assign({}, p); delete p.eventId; }
    dl(assign({ event: gtmEvent }, p || {}));
    if (fbEvent) fbTrack(fbEvent, p || undefined, custom, eventId);
  }
  function assign(a, b) { if (b) for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; return a; }

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
    // commerce
    startCheckout: function (p) { track('begin_checkout', p, 'InitiateCheckout'); },
    purchase: function (p) { track('purchase', p, 'Purchase'); },       // {value, currency, ...}
    subscribe: function (p) { track('subscribe', p, 'Subscribe'); },    // {value, currency, ...}
    // escape hatch: NF_TRACK.event('name', {..}, 'MetaEvent', /*custom*/ true)
    event: function (name, p, fbEvent, custom) { track(name, p, fbEvent, custom); },
    // Dedup + match-quality helpers for pairing with the server Conversions API.
    newId: function () { return 'nfx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); },
    fbp: function () { return cookie('_fbp'); },
    fbc: function () { return cookie('_fbc'); }
  };
  function cookie(name) {
    try { var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : ''; }
    catch (e) { return ''; }
  }

  function evaluate() {
    if (consent('analytics')) loadGTM();
    if (consent('marketing')) loadPixel();
  }
  // NFConsent may not exist yet if this runs before nf-consent.js (script order
  // / defer). evaluate() is idempotent (loaders guard on `loaded`), so fire it on
  // every signal by which NFConsent could have become available — plus live on
  // the banner choice. This works for fresh and returning visitors either order.
  evaluate();
  document.addEventListener('nf:consent', evaluate);
  document.addEventListener('DOMContentLoaded', evaluate);
  window.addEventListener('load', evaluate);
})();
