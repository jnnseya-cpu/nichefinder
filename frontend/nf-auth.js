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

  var NS = {
    token: token,
    account: account,
    isLoggedIn: function () { return !!token() && !!account(); },
    authHeader: function () { var t = token(); return t ? { authorization: 'Bearer ' + t } : {}; },
    set: function (session) {
      localStorage.setItem(TOKEN_KEY, session.token);
      localStorage.setItem(ACCT_KEY, JSON.stringify(session.user));
      window.NF_WALLET_USER = session.user.userId;
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
  });
})();
