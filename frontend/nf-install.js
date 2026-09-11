/* Niche Finder — PWA layer: service-worker registration + a quiet, dismissible
   "Install app" prompt. Loaded on every page via the managed head block
   (scripts/inject-tags.mjs), so the app installs and updates everywhere, not
   just from the landing page.

   Behaviour:
   - Registers sw.js (same-origin, skipped on file://). Idempotent.
   - Chromium/Android: captures beforeinstallprompt and shows a subtle bottom
     banner; the button triggers the real native install dialog.
   - iOS Safari (no beforeinstallprompt): shows a one-time "Add to Home Screen"
     hint, since iOS has no programmatic install.
   - Never shows when already installed (standalone), on internal/admin pages,
     or if the visitor dismissed it in the last 45 days. No nagging. */
(function () {
  'use strict';

  // 1) Service worker — register on every page so a direct landing (e.g. /search)
  //    still gets offline shell + instant updates. Harmless if already registered.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // 2) Install prompt — kept off internal surfaces and off already-installed app.
  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var SKIP = { 'admin.html': 1, 'admin-console.html': 1, 'comms.html': 1, 'reset.html': 1 };
  if (SKIP[page]) return;

  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  if (standalone) return;

  var DISMISS_KEY = 'nf_install_dismissed';
  var DISMISS_MS = 45 * 24 * 60 * 60 * 1000;
  function dismissedRecently() {
    try { var t = Number(localStorage.getItem(DISMISS_KEY) || 0); return t && (Date.now() - t) < DISMISS_MS; }
    catch (e) { return false; }
  }
  function rememberDismiss() { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {} }
  if (dismissedRecently()) return;

  var deferred = null; // stashed beforeinstallprompt event (Chromium/Android)

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function showBanner(mode) { // mode: 'native' | 'ios'
    if (document.getElementById('nf-install')) return;
    var wrap = el('div', 'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483000;' +
      'max-width:440px;width:calc(100% - 24px);box-sizing:border-box;display:flex;align-items:center;gap:12px;' +
      'padding:12px 14px;border-radius:12px;border:1px solid rgba(232,166,26,.4);' +
      'background:linear-gradient(180deg,#141F33,#0E1626);color:#E8ECF4;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.5);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;' +
      'font-size:13.5px;line-height:1.4');
    wrap.id = 'nf-install';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Install Niche Finder');

    var mark = el('div', 'flex:0 0 auto;width:34px;height:34px;border-radius:9px;border:1px solid rgba(232,166,26,.5);' +
      'display:flex;align-items:center;justify-content:center');
    var dot = el('div', 'width:15px;height:15px;border-radius:3px;background:linear-gradient(135deg,#E8A61A,#FFC53D)');
    mark.appendChild(dot);

    var txt = el('div', 'flex:1 1 auto;min-width:0');
    var b = el('div', 'font-weight:600;color:#F3F5FA');
    b.textContent = mode === 'ios' ? 'Add Niche Finder to your home screen' : 'Install Niche Finder';
    var sub = el('div', 'color:#AEB6C6;font-size:12px;margin-top:1px');
    sub.textContent = mode === 'ios'
      ? 'Tap the Share icon, then “Add to Home Screen”.'
      : 'Get the full-screen app — one tap from your home screen.';
    txt.appendChild(b); txt.appendChild(sub);

    var close = el('button', 'flex:0 0 auto;background:none;border:none;color:#8B93A5;font-size:20px;line-height:1;' +
      'cursor:pointer;padding:4px 6px', '×');
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', function () { rememberDismiss(); remove(); });

    wrap.appendChild(mark);
    wrap.appendChild(txt);

    if (mode === 'native') {
      var install = el('button', 'flex:0 0 auto;background:linear-gradient(135deg,#E8A61A,#FFC53D);color:#0B1220;' +
        'font-weight:700;border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font-size:13px', 'Install');
      install.addEventListener('click', function () {
        remove();
        if (!deferred) return;
        deferred.prompt();
        deferred.userChoice.finally(function () { deferred = null; });
        rememberDismiss(); // don't re-show whatever they chose
      });
      wrap.appendChild(install);
    }
    wrap.appendChild(close);

    (document.body || document.documentElement).appendChild(wrap);
  }
  function remove() { var n = document.getElementById('nf-install'); if (n && n.parentNode) n.parentNode.removeChild(n); }

  // Chromium / Android: the browser offers install → show our banner instead of
  // its mini-infobar, and drive the real dialog from our button.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    showBanner('native');
  });
  window.addEventListener('appinstalled', function () { rememberDismiss(); remove(); });

  // iOS Safari has no beforeinstallprompt — offer the manual hint once, only in
  // a real iOS Safari tab (not an in-app webview, where A2HS is unavailable).
  var ua = navigator.userAgent || '';
  var isIOS = /iP(hone|ad|od)/.test(ua) && !window.MSStream;
  var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  if (isIOS && isSafari) {
    window.addEventListener('load', function () { setTimeout(function () { showBanner('ios'); }, 2500); });
  }
})();
