/* Niche Finder — client auth session helper.
   Stores the bearer session issued by the gateway and makes the logged-in
   account drive the wallet identity: once signed in, window.NF_WALLET_USER is
   the account's server userId (not the anonymous per-browser id), so balances
   and history follow the user across devices. Load AFTER nf-config.js. */
(function () {
  'use strict';
  var TOKEN_KEY = 'nf_session';
  var ACCT_KEY = 'nf_account';

  function account() { try { return JSON.parse(localStorage.getItem(ACCT_KEY) || 'null'); } catch (e) { return null; } }
  function token() { return localStorage.getItem(TOKEN_KEY) || null; }

  var acct = account();
  if (acct && acct.userId) window.NF_WALLET_USER = acct.userId;

  /* On first sign-in, move any ACU bought as a guest in THIS browser into the
     account, so a pre-login purchase isn't stranded on the anonymous wallet.
     Requires the account's bearer token; the server move is idempotent and only
     ever credits the authenticated account. Fire-and-forget. */
  function migrateGuestWallet(fromId, token, accountId) {
    try {
      var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
      if (!base || !token || !fromId || fromId === accountId) return;
      if (!/^op_[a-z0-9]{10,}$/.test(fromId)) return;
      fetch(base + '/v1/wallet/migrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ from: fromId })
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (d && d.wallet && window.NF && typeof NF.syncWallet === 'function') NF.syncWallet(d.wallet);
      }).catch(function () {});
    } catch (e) {}
  }

  var NS = {
    token: token,
    account: account,
    isLoggedIn: function () { return !!token() && !!account(); },
    authHeader: function () { var t = token(); return t ? { authorization: 'Bearer ' + t } : {}; },
    set: function (session) {
      var prev = window.NF_WALLET_USER; // the guest wallet id active before sign-in
      localStorage.setItem(TOKEN_KEY, session.token);
      localStorage.setItem(ACCT_KEY, JSON.stringify(session.user));
      window.NF_WALLET_USER = session.user.userId;
      migrateGuestWallet(prev, session.token, session.user.userId);
    },
    updateAccount: function (user) { if (user) { localStorage.setItem(ACCT_KEY, JSON.stringify(user)); acct = user; } },
    clear: function () { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ACCT_KEY); },
    logout: function () {
      var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
      var t = token();
      NS.clear();
      if (base && t) { try { fetch(base + '/v1/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + t } }); } catch (e) {} }
    }
  };
  window.NF_AUTH = NS;

  /* Declarative nav wiring: elements marked [data-auth="in"] show only when
     signed in, [data-auth="out"] only when signed out; [data-auth-email] gets
     the address; [data-auth-logout] becomes a sign-out control. */
  document.addEventListener('DOMContentLoaded', function () {
    var on = NS.isLoggedIn();
    document.querySelectorAll('[data-auth="in"]').forEach(function (el) { el.style.display = on ? '' : 'none'; });
    document.querySelectorAll('[data-auth="out"]').forEach(function (el) { el.style.display = on ? 'none' : ''; });
    if (acct) {
      document.querySelectorAll('[data-auth-email]').forEach(function (el) { el.textContent = acct.email; });
      document.querySelectorAll('[data-auth-name]').forEach(function (el) { el.textContent = acct.name || acct.email; });
      var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
      document.querySelectorAll('[data-auth-avatar]').forEach(function (el) {
        if (acct.avatar) { el.style.backgroundImage = 'url("' + base + '/v1/media?f=' + encodeURIComponent(acct.avatar) + '")'; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center'; el.textContent = ''; }
        else { el.textContent = (acct.name || acct.email || '?').trim().charAt(0).toUpperCase(); }
      });
    }
    document.querySelectorAll('[data-auth-logout]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); NS.logout(); location.href = 'account.html'; });
    });
    injectAccountMenu();
  });

  /* A consistent account menu on every page that loads this script — so every
     user AND the admin always have a visible way into their account. Mounts into
     the site header when present, otherwise pins to the top-right. Suppressed on
     the auth pages themselves (sign-in / reset) where it would be redundant. */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function injectAccountMenu() {
    if (document.getElementById('nf-acct-menu')) return;
    if (/account\.html|reset\.html/.test(location.pathname)) return;
    if (document.querySelector('[data-auth-nomenu]')) return; // opt-out hook

    if (!document.getElementById('nf-acct-style')) {
      var st = document.createElement('style');
      st.id = 'nf-acct-style';
      st.textContent = '#nf-acct-drop a:hover{background:rgba(232,166,26,.12)}#nf-acct-btn:hover{border-color:rgba(232,166,26,.5)}';
      document.head.appendChild(st);
    }

    var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
    /* Installed-PWA / standalone: there is no browser chrome, and the page
       header is a single flex row that clips its overflow (body{overflow-x:hidden}),
       so a header-mounted menu gets pushed off-screen on phones. Pin it instead,
       clear of the status-bar / notch via the safe-area insets, so the account
       menu is always present and tappable in the installed app. */
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
    // In standalone the page header is a space-between flex row with the CTA
    // pinned to the right corner, so a full pill would overlap it. Use a COMPACT
    // circular control pinned top-right and reserve a little space in the page's
    // own header so the control clears the CTA.
    var compact = standalone;
    var host = standalone ? null : (document.querySelector('header.site .wrap') || document.querySelector('header .wrap'));
    var PERSON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-3.6 3.6-6 8-6s8 2.4 8 6"></path></svg>';
    function reserveHeaderSpace() {
      var bar = document.querySelector('header.site .wrap') || document.querySelector('header .nav-inner') || document.querySelector('header .wrap');
      if (bar && bar.getAttribute('data-nf-reserved') !== '1') {
        bar.style.paddingRight = 'calc(env(safe-area-inset-right, 0px) + 58px)';
        bar.setAttribute('data-nf-reserved', '1');
      }
    }
    var wrap = document.createElement('div');
    wrap.id = 'nf-acct-menu';
    wrap.style.cssText = 'display:inline-flex;align-items:center;font-family:inherit;z-index:1200;' +
      (host ? 'position:relative;margin-left:14px'
            : 'position:fixed;top:calc(env(safe-area-inset-top, 0px) + 12px);right:calc(env(safe-area-inset-right, 0px) + 14px)');

    function item(label, href) {
      return '<a href="' + href + '" role="menuitem" style="display:block;padding:9px 12px;border-radius:8px;color:var(--text,#E8ECF4);text-decoration:none;font-size:.82rem">' + label + '</a>';
    }

    if (!NS.isLoggedIn()) {
      wrap.innerHTML = compact
        ? '<a href="account.html" aria-label="Sign in" style="display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;border:1px solid var(--line,rgba(255,255,255,.3));background:var(--panel-2,rgba(255,255,255,.06));color:var(--text,#E8ECF4);text-decoration:none">' + PERSON + '</a>'
        : '<a href="account.html" style="display:inline-flex;align-items:center;padding:7px 15px;border:1px solid var(--line,rgba(255,255,255,.18));border-radius:99px;color:var(--text,#E8ECF4);text-decoration:none;font-size:.8rem">Sign in</a>';
      if (host) host.appendChild(wrap); else { document.body.appendChild(wrap); reserveHeaderSpace(); }
      return;
    }

    var name = (acct && (acct.name || acct.email)) || 'Account';
    var email = (acct && acct.email) || '';
    var isAdmin = acct && acct.role === 'admin';
    var avSize = compact ? 36 : 30;
    var av = 'width:' + avSize + 'px;height:' + avSize + 'px;border-radius:50%;background:var(--gold,#E8A61A);color:#0b0f18;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;overflow:hidden;background-size:cover;background-position:center;flex:0 0 auto;';
    var avInner = (name || '?').trim().charAt(0).toUpperCase();
    if (acct && acct.avatar) { av += "background-image:url('" + base + '/v1/media?f=' + encodeURIComponent(acct.avatar) + "');"; avInner = ''; }

    wrap.innerHTML =
      '<button id="nf-acct-btn" aria-haspopup="true" aria-expanded="false" aria-label="Account menu" style="display:inline-flex;align-items:center;gap:9px;background:' + (compact ? 'transparent' : 'var(--panel-2,rgba(255,255,255,.05))') + ';border:1px solid ' + (compact ? 'transparent' : 'var(--line,rgba(255,255,255,.16))') + ';border-radius:99px;padding:' + (compact ? '0' : '4px 12px 4px 4px') + ';cursor:pointer;color:var(--text,#E8ECF4);font-family:inherit;font-size:.82rem">' +
        '<span style="' + av + '">' + avInner + '</span>' +
        (compact ? '' :
          '<span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(name) + '</span>' +
          '<span style="opacity:.6;font-size:.7rem">▾</span>') +
      '</button>' +
      '<div id="nf-acct-drop" role="menu" style="display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:210px;background:var(--panel,#0E1626);border:1px solid var(--line,rgba(255,255,255,.16));border-radius:12px;padding:6px;box-shadow:0 14px 44px rgba(0,0,0,.45)">' +
        '<div style="padding:8px 12px 6px">' +
          '<div style="font-size:.82rem;font-weight:600;color:var(--text,#E8ECF4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(name) + '</div>' +
          '<div style="font-size:.66rem;letter-spacing:.04em;color:var(--muted,#8B93A5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(email) + (isAdmin ? ' · ADMIN' : '') + '</div>' +
        '</div>' +
        '<div style="height:1px;background:var(--line,rgba(255,255,255,.1));margin:4px 0"></div>' +
        item('Command Center', 'dashboard.html') +
        item('Search Canvas', 'search.html') +
        item('Growth Engine', 'growth.html') +
        item('My Account', 'settings.html') +
        (isAdmin ? item('Admin Console', 'admin-console.html') : '') +
        '<div style="height:1px;background:var(--line,rgba(255,255,255,.1));margin:4px 0"></div>' +
        '<a href="#" id="nf-acct-out" role="menuitem" style="display:block;padding:9px 12px;border-radius:8px;color:#E0806F;text-decoration:none;font-size:.82rem">Sign out</a>' +
      '</div>';
    if (host) host.appendChild(wrap); else { document.body.appendChild(wrap); reserveHeaderSpace(); }

    var btn = wrap.querySelector('#nf-acct-btn');
    var drop = wrap.querySelector('#nf-acct-drop');
    function close() { drop.style.display = 'none'; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = drop.style.display === 'block';
      drop.style.display = open ? 'none' : 'block';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    wrap.querySelector('#nf-acct-out').addEventListener('click', function (e) {
      e.preventDefault(); NS.logout(); location.href = 'account.html';
    });
  }
})();
