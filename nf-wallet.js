/* Niche Finder — shared ACU wallet + commercial engine
   Core rule: £1 = 100 ACU. New users receive 100 free welcome ACUs (read-only —
   preview/browse only). All generation, unlock, export, and build actions consume
   PAID ACUs from top-up packages. */
(function () {
  'use strict';

  var PACKAGES = [
    { id: 'starter_5',   name: 'Starter',  priceGBP: 5,  acus: 500,  bonus: 0,   total: 500,  desc: 'Enough for 4 niche searches.' },
    { id: 'builder_10',  name: 'Builder',  priceGBP: 10, acus: 1000, bonus: 100, total: 1100, desc: 'Deeper exploration and early project building.', recommended: true },
    { id: 'founder_20',  name: 'Founder',  priceGBP: 20, acus: 2000, bonus: 400, total: 2400, desc: 'Serious project building and financial outputs.' },
    { id: 'investor_50', name: 'Investor', priceGBP: 50, acus: 5000, bonus: 1500, total: 6500, desc: 'Full investor packages across multiple ventures.' }
  ];

  var COSTS = {
    niche_search: 125,
    unlock: 150,
    export_pdf: 100,
    validation: 250,        // market validation report
    forecast: 250,          // 3-year cashflow forecast
    pnl: 220,               // 3-year profit & loss
    riskmap: 250,
    excel_model: 350,
    cashflow_pnl_bundle: 400,
    financial_bundle: 500,  // full financial model bundle
    scenario: 300,          // scenario builder — single case
    scenario_bundle: 700,   // conservative + base + aggressive
    benchmark: 250,
    confidence_report: 200,
    bizplan: 500,
    bizplan_pdf: 150,
    pitch: 500,             // standard deck; premium 650 / elite 850 by template tier
    pitch_premium: 650,
    pitch_elite: 850,
    ppt_export: 200,
    investor_memo: 350,
    execution_roadmap: 300,
    market_entry: 350,
    full_investor_package: 1500,
    support_message: 1,     // support chat — 1 ACU per message, free ACUs allowed
    investor_multiplier: 1.4
  };

  var WELCOME_FREE = 100;

  function loadWallet() {
    try {
      var w = JSON.parse(localStorage.getItem('nf_wallet'));
      if (w && typeof w.paid === 'number' && typeof w.free === 'number') return w;
    } catch (e) {}
    // migrate legacy single-balance wallets: treat prior balance as paid ACU
    var legacy = localStorage.getItem('nf_acu_balance');
    var w2 = legacy !== null && Number.isFinite(Number(legacy))
      ? { paid: Number(legacy), free: 0 }
      : { paid: 0, free: WELCOME_FREE };
    saveWallet(w2);
    if (legacy === null) logLedger('WELCOME · 100 free read-only ACU', 0);
    return w2;
  }
  function saveWallet(w) {
    localStorage.setItem('nf_wallet', JSON.stringify(w));
    localStorage.setItem('nf_acu_balance', String(w.paid + w.free)); // keep legacy readers working
  }

  function logLedger(label, amt) {
    try {
      var l = JSON.parse(localStorage.getItem('nf_ledger') || '[]');
      l.unshift({ t: label, amt: amt, ts: Date.now() });
      localStorage.setItem('nf_ledger', JSON.stringify(l.slice(0, 200)));
    } catch (e) {}
  }

  /* Deduct a generation cost. Paid ACUs only — welcome ACUs are read-only.
     Returns true on success; on insufficient funds opens the top-up modal. */
  function charge(cost, label, onAfter) {
    var w = loadWallet();
    if (w.paid < cost) {
      openTopup(cost, label, onAfter);
      return false;
    }
    w.paid -= cost;
    saveWallet(w);
    logLedger('OPERATIONAL_TASK · ' + label, -cost);
    if (onAfter) onAfter();
    return true;
  }

  function credit(pkg) {
    var w = loadWallet();
    w.paid += pkg.total;
    saveWallet(w);
    logLedger('TOP-UP · ' + pkg.name + ' (£' + pkg.priceGBP + ' = ' + pkg.total.toLocaleString('en-US') + ' ACU)', pkg.total);
  }

  /* Support chat is the one action welcome ACUs may fund (1 ACU/message):
     deduct free first, then paid. Returns false only when both are empty. */
  function chargeSupport(label) {
    var w = loadWallet();
    var cost = COSTS.support_message;
    if (w.free >= cost) w.free -= cost;
    else if (w.paid >= cost) w.paid -= cost;
    else return false;
    saveWallet(w);
    logLedger('SUPPORT · ' + (label || 'chat message'), -cost);
    return true;
  }

  /* traffic-light helpers — 0-10 scale */
  function band(score10) {
    return score10 >= 8 ? '#3FA79B' : score10 >= 5 ? '#D9A441' : '#C4604F';
  }
  function decision(overall10) {
    return overall10 >= 7.5 ? 'STRONG GO' : overall10 >= 6 ? 'CONDITIONAL GO' : 'NO GO';
  }

  /* ---------- top-up modal ---------- */
  var overlay = null;
  function openTopup(neededCost, label, onAfter) {
    closeTopup();
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Buy ACU packages');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(4,7,14,.82);backdrop-filter:blur(6px);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto';
    var w = loadWallet();
    var note = neededCost
      ? '<p style="color:#C4604F;font-size:.85rem;margin:6px 0 0">' + (label ? label.replace(/&/g, '&amp;').replace(/</g, '&lt;') + ' requires ' : 'This action requires ') + neededCost + ' paid ACU — you have ' + w.paid.toLocaleString('en-US') + '. Welcome ACUs are read-only and cannot fund generation.</p>'
      : '';
    var cards = PACKAGES.map(function (p) {
      return '<button data-pkg="' + p.id + '" style="text-align:left;background:' + (p.recommended ? 'rgba(217,164,65,.08)' : 'rgba(255,255,255,.03)') + ';border:1px solid ' + (p.recommended ? 'rgba(217,164,65,.5)' : 'rgba(255,255,255,.1)') + ';border-radius:14px;padding:16px;cursor:pointer;color:#E8ECF4;display:block;width:100%">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
          '<b style="font-size:1rem">' + p.name + (p.recommended ? ' <span style="font-size:.6rem;letter-spacing:.14em;color:#D9A441">RECOMMENDED</span>' : '') + '</b>' +
          '<span style="font-family:ui-monospace,monospace;font-size:1.05rem;color:#F1C97E">£' + p.priceGBP + '</span>' +
        '</div>' +
        '<div style="font-family:ui-monospace,monospace;font-size:.8rem;color:#3FA79B;margin-top:6px">' + p.total.toLocaleString('en-US') + ' ACU' + (p.bonus ? ' <span style="color:#8B93A5">(' + p.acus.toLocaleString('en-US') + ' + ' + p.bonus.toLocaleString('en-US') + ' bonus)</span>' : '') + '</div>' +
        '<div style="font-size:.78rem;color:#8B93A5;margin-top:4px">' + p.desc + '</div>' +
      '</button>';
    }).join('');
    overlay.innerHTML =
      '<div style="max-width:520px;width:100%;background:#0E1626;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:26px">' +
        '<div style="display:flex;justify-content:space-between;align-items:start;gap:12px">' +
          '<div><div style="font-family:ui-monospace,monospace;font-size:.62rem;letter-spacing:.22em;color:#D9A441">ACU TOP-UP · £1 = 100 ACU</div>' +
          '<h3 style="margin:6px 0 0;font-size:1.25rem;color:#E8ECF4">Power your venture outputs</h3></div>' +
          '<button data-close style="background:none;border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#8B93A5;padding:4px 10px;cursor:pointer">✕</button>' +
        '</div>' + note +
        '<div style="display:grid;gap:10px;margin-top:18px">' + cards + '</div>' +
        '<p style="font-size:.7rem;color:#8B93A5;margin:14px 0 0">Prototype checkout — selecting a package credits your wallet instantly. Every action shows its ACU cost before you confirm.</p>' +
      '</div>';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-close]')) { closeTopup(); return; }
      var btn = e.target.closest('[data-pkg]');
      if (!btn) return;
      var pkg = PACKAGES.filter(function (p) { return p.id === btn.getAttribute('data-pkg'); })[0];
      credit(pkg);
      closeTopup();
      if (onAfter) onAfter();
    });
    document.body.appendChild(overlay);
  }
  function closeTopup() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  /* ---------- optional server sync (P0 wallet backend) ----------
     When nf-config.js sets NF_GATEWAY_URL, the gateway's /v1/wallet endpoints
     become the system of record: local mutations are mirrored to the server,
     and on page load the server balance hydrates the local cache. All calls
     are fire-and-forget with graceful fallback — offline demo keeps working. */
  function gatewayBase() { return (window.NF_GATEWAY_URL || '').replace(/\/$/, ''); }
  function serverSync(path, payload) {
    var base = gatewayBase();
    if (!base || typeof fetch !== 'function') return;
    try {
      fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ user: window.NF_WALLET_USER || 'op_anonymous' }, payload))
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
        if (data && data.wallet) saveWallet({ paid: data.wallet.paid, free: data.wallet.free });
      }).catch(function () {});
    } catch (e) {}
  }
  function hydrateFromServer() {
    var base = gatewayBase();
    if (!base || typeof fetch !== 'function') return;
    try {
      fetch(base + '/v1/wallet?user=' + encodeURIComponent(window.NF_WALLET_USER || 'op_anonymous'))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (w) { if (w && typeof w.paid === 'number') saveWallet({ paid: w.paid, free: w.free }); })
        .catch(function () {});
    } catch (e) {}
  }

  var _charge = charge, _credit = credit;
  charge = function (cost, label, onAfter) {
    var ok = _charge(cost, label, onAfter);
    if (ok) serverSync('/v1/wallet/charge', { amount: cost, label: label });
    return ok;
  };
  credit = function (pkg) {
    _credit(pkg);
    serverSync('/v1/wallet/credit', { packageId: pkg.id });
  };
  hydrateFromServer();

  window.NF = {
    PACKAGES: PACKAGES,
    COSTS: COSTS,
    wallet: loadWallet,
    total: function () { var w = loadWallet(); return w.paid + w.free; },
    charge: function (cost, label, onAfter) { return charge(cost, label, onAfter); },
    chargeSupport: chargeSupport,
    credit: function (pkg) { return credit(pkg); },
    logLedger: logLedger,
    band: band,
    decision: decision,
    openTopup: openTopup
  };
})();
