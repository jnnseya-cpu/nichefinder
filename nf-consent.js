/* Niche Finder — cookie consent (30-day, category-aware).
   Appears on first visit; the choice is stored for 30 days, after which the
   banner returns. Analytics/marketing tags must check NFConsent.allowed('analytics')
   before loading — nothing non-essential loads without an explicit yes. */
(function () {
  'use strict';
  var KEY = 'nf_consent';
  var DAYS = 30;

  function read() {
    try {
      var c = JSON.parse(localStorage.getItem(KEY));
      if (c && c.ts && (Date.now() - c.ts) < DAYS * 864e5) return c;
    } catch (e) {}
    return null;
  }
  function save(categories) {
    try { localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), version: 1, categories: categories })); } catch (e) {}
  }

  window.NFConsent = {
    allowed: function (cat) {
      var c = read();
      if (cat === 'necessary') return true;
      return !!(c && c.categories && c.categories[cat]);
    }
  };

  if (read()) return; // valid consent on file — stay silent

  var bar = document.createElement('div');
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', 'Cookie consent');
  bar.style.cssText =
    'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:960;width:min(680px,calc(100vw - 32px));' +
    'background:#0E1626;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:18px 20px;color:#E8ECF4;' +
    'box-shadow:0 18px 60px rgba(0,0,0,.55);font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;font-size:.85rem';
  bar.innerHTML =
    '<b style="font-size:.92rem">Cookies &amp; local storage</b>' +
    '<p style="color:#8B93A5;margin:6px 0 12px;line-height:1.5">Essential storage runs the product (your wallet, projects, and ledger live in this browser). ' +
    'Analytics and marketing tags load only if you allow them. Your choice is kept for 30 days. ' +
    '<a href="cookies.html" style="color:#F1C97E">Cookie Policy</a></p>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<button data-c="all" style="background:#D9A441;border:none;border-radius:8px;color:#070B14;font-weight:700;padding:9px 18px;cursor:pointer;font-size:.82rem">Accept all</button>' +
      '<button data-c="essential" style="background:none;border:1px solid rgba(255,255,255,.2);border-radius:8px;color:#E8ECF4;padding:9px 18px;cursor:pointer;font-size:.82rem">Reject non-essential</button>' +
      '<button data-c="analytics" style="background:none;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#8B93A5;padding:9px 14px;cursor:pointer;font-size:.78rem">Essential + analytics only</button>' +
    '</div>';

  bar.addEventListener('click', function (e) {
    var b = e.target.closest('[data-c]');
    if (!b) return;
    var mode = b.getAttribute('data-c');
    save({
      necessary: true,
      analytics: mode === 'all' || mode === 'analytics',
      marketing: mode === 'all'
    });
    bar.remove(); // disappears immediately — no reload
  });

  if (document.body) document.body.appendChild(bar);
  else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(bar); });
})();
