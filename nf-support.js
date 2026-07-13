/* Niche Finder — NicheBot support widget.
   Precision-first support chat: direct answer → actionable step, no filler.
   Costs 1 ACU per message (the one action welcome ACUs may fund). Escalates to
   a human by writing a structured case to nf_support_cases, which the Super
   Admin OS (Platform Ops → Support) reads. Degrades gracefully when the wallet
   module is absent: messages are free. */
(function () {
  'use strict';

  var KNOWLEDGE = [
    { rx: /price|pricing|cost|package|top.?up|buy|£|acu.*(buy|price)/i,
      a: 'ACU packages: Starter £5 = 500 · Builder £10 = 1,100 · Founder £20 = 2,400 · Investor £50 = 6,500. £1 = 100 ACU.',
      s: 'Open any "Buy ACU" button to top up — the package credits instantly in this prototype.' },
    { rx: /welcome|free (acu|credit)|read.?only/i,
      a: 'New accounts get 100 free welcome ACUs. They are read-only: previewing and browsing only — plus this support chat.',
      s: 'Generation, unlocks, and exports always use paid ACUs from a top-up package.' },
    { rx: /score|scoring|prs|pss|\bcs\b|traffic|verdict|go\b/i,
      a: 'Every niche gets a deterministic 0–10 score: Market Readiness (PRS) 35% + Competitive Gap (CS) 30% + Prospect of Success (PSS) 35%. Green 8–10, amber 5–7, red 0–4.',
      s: 'Decision labels: STRONG GO ≥ 7.5 · CONDITIONAL GO 6.0–7.4 · NO GO < 6.0.' },
    { rx: /breakthrough|bps/i,
      a: 'Breakthrough mode ranks by PSS·0.25 + BPS·0.30 + MarketSize·0.10 + Profitability·0.30 + Readiness·0.05. A niche only counts as a breakthrough when BPS and PSS are both ≥ 7.5.',
      s: 'If nothing clears that bar, the canvas falls back to the strongest realistic opportunities and tells you so.' },
    { rx: /unlock/i,
      a: 'Unlock Full Opportunity costs 150 ACU and opens the Deep-Dive workspace: operational brief, financial model, risk register, roadmap, and the Build Hub.',
      s: 'Run a search first, then press "Unlock Full Opportunity" on the niche you want.' },
    { rx: /search cost|how much.*search|125/i,
      a: 'A niche search costs 125 ACU (175 with Investor Mode). A £5 Starter pack covers 4 searches.',
      s: 'Country is the only mandatory input — everything else is optional.' },
    { rx: /investor mode|1\.4|40%/i,
      a: 'Investor Production Mode upgrades outputs for real funding conversations at ×1.4 ACU cost.',
      s: 'Toggle it in the Search Canvas advanced filters or in the Deep-Dive Build & Generate rail.' },
    { rx: /business plan|bizplan|pitch|deck|forecast|p&l|pnl|cashflow|excel|export|document/i,
      a: 'Build Hub costs: validation 250 · cashflow forecast 250 · P&L 220 · risk heatmap 250 · business plan 500 · pitch deck 500/650/850 by template tier · Excel + PDF pack 350. Regenerating any document costs half.',
      s: 'Unlock a niche, then run engines from the Build & Generate rail — every document is versioned in your repository.' },
    { rx: /country|capital|10k|10,?000|budget|cap\b/i,
      a: 'Country is mandatory and every opportunity respects the 10k capital class: flat £10k/€10k in GBP and EUR zones, US$10k in dollarized economies, and the US$10,000 local-currency equivalent everywhere else.',
      s: 'Set your market in the Search Canvas — results are grounded in that country\'s signals.' },
    { rx: /refund/i,
      a: 'Consumed ACUs are non-refundable once generation starts, except when a platform fault produces no output — those are refunded in full.',
      s: 'If a generation failed, tell me "escalate" and I\'ll open a case for the team with your ledger attached.' },
    { rx: /wallet|balance|ledger/i,
      a: 'Your wallet shows paid + free ACUs; every movement is recorded in the ledger on the Command Center.',
      s: 'Open dashboard.html → Wallet tile, or hover the ACU pill in any header for the paid/free split.' }
  ];

  var ESCALATE_RX = /human|agent|person|escalat|complain|manager|speak to|talk to someone|not working|broken|bug/i;

  var strikes = 0, transcript = [];

  function el(tag, css, html) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (html != null) e.innerHTML = html;
    return e;
  }

  var fab = el('button',
    'position:fixed;right:22px;bottom:22px;z-index:940;width:54px;height:54px;border-radius:50%;border:1px solid rgba(217,164,65,.55);' +
    'background:linear-gradient(170deg,#121C30,#0E1626);color:#F1C97E;font-size:1.25rem;cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.45)');
  fab.setAttribute('aria-label', 'Open support chat');
  fab.textContent = '✦';

  var panel = el('div',
    'position:fixed;right:22px;bottom:88px;z-index:941;width:min(360px,calc(100vw - 44px));max-height:min(540px,70vh);display:none;flex-direction:column;' +
    'background:#0E1626;border:1px solid rgba(255,255,255,.14);border-radius:16px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.55);color:#E8ECF4;' +
    'font-family:"Avenir Next","Segoe UI",system-ui,sans-serif');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'NicheBot support chat');
  panel.innerHTML =
    '<div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.09);display:flex;justify-content:space-between;align-items:center">' +
      '<div><b style="font-size:.95rem">NicheBot</b><div style="font-family:ui-monospace,monospace;font-size:.56rem;letter-spacing:.18em;color:#3FA79B">VENTURE OS SUPPORT · 1 ACU / MESSAGE</div></div>' +
      '<button data-close style="background:none;border:1px solid rgba(255,255,255,.15);border-radius:7px;color:#8B93A5;padding:3px 9px;cursor:pointer">✕</button>' +
    '</div>' +
    '<div data-log style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;font-size:.85rem"></div>' +
    '<form data-form style="display:flex;gap:8px;padding:12px;border-top:1px solid rgba(255,255,255,.09)">' +
      '<input data-in type="text" placeholder="Ask about pricing, scoring, unlocks…" style="flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px;color:#E8ECF4;font-size:.85rem;font-family:inherit">' +
      '<button type="submit" style="background:#D9A441;border:none;border-radius:8px;color:#070B14;font-weight:700;padding:0 16px;cursor:pointer">Send</button>' +
    '</form>';

  var log = panel.querySelector('[data-log]');

  function bubble(text, who) {
    var mine = who === 'user';
    var b = el('div',
      'max-width:86%;padding:9px 13px;border-radius:12px;line-height:1.45;white-space:pre-line;' +
      (mine ? 'align-self:flex-end;background:rgba(217,164,65,.14);border:1px solid rgba(217,164,65,.3)'
            : 'align-self:flex-start;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09)'));
    b.textContent = text;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    transcript.push({ who: who, t: text, ts: Date.now() });
  }

  function note(text) {
    var n = el('div', 'align-self:center;font-family:ui-monospace,monospace;font-size:.6rem;letter-spacing:.14em;color:#8B93A5;text-align:center');
    n.textContent = text;
    log.appendChild(n);
    log.scrollTop = log.scrollHeight;
  }

  function escalate(reason) {
    try {
      var cases = JSON.parse(localStorage.getItem('nf_support_cases') || '[]');
      cases.unshift({
        id: 'case_' + Date.now().toString(36),
        ts: Date.now(),
        reason: reason,
        priority: /refund|payment|charge/i.test(reason) ? 'high' : 'normal',
        status: 'open',
        transcript: transcript.slice(-12)
      });
      localStorage.setItem('nf_support_cases', JSON.stringify(cases.slice(0, 50)));
    } catch (e) {}
    bubble('Escalating to human support — your case is open with the full conversation attached. Expected response: within 24 hours. You can keep asking me questions meanwhile.', 'bot');
    note('CASE CREATED · VISIBLE IN SUPER ADMIN OS → PLATFORM OPS → SUPPORT');
    strikes = 0;
  }

  function answer(q) {
    if (ESCALATE_RX.test(q)) return escalate(q.slice(0, 140));
    for (var i = 0; i < KNOWLEDGE.length; i++) {
      if (KNOWLEDGE[i].rx.test(q)) {
        strikes = 0;
        return bubble(KNOWLEDGE[i].a + '\n\n→ ' + KNOWLEDGE[i].s, 'bot');
      }
    }
    strikes++;
    if (strikes >= 2) return escalate('Unresolved after 2 attempts: ' + q.slice(0, 120));
    bubble('One precise question so I get this right: is this about pricing & ACUs, scoring & verdicts, or building documents? (Or say "human" and I\'ll escalate.)', 'bot');
  }

  panel.querySelector('[data-form]').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = panel.querySelector('[data-in]');
    var q = input.value.trim();
    if (!q) return;
    if (window.NF && NF.chargeSupport && !NF.chargeSupport('NicheBot')) {
      bubble('Your ACU balance is empty — support chat costs 1 ACU per message. Top up from any "Buy ACU" button and I\'m here.', 'bot');
      return;
    }
    bubble(q, 'user');
    input.value = '';
    setTimeout(function () { answer(q); }, 350);
  });

  panel.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) { panel.style.display = 'none'; fab.style.display = ''; }
  });
  fab.addEventListener('click', function () {
    panel.style.display = 'flex';
    fab.style.display = 'none';
    if (!log.children.length) {
      bubble('NicheBot here. Direct answers on pricing, scoring, unlocks, and documents — 1 ACU per message (your free welcome ACUs cover it). What do you need?', 'bot');
      note('SAY "HUMAN" ANY TIME TO ESCALATE TO THE TEAM');
    }
    panel.querySelector('[data-in]').focus();
  });

  document.body.appendChild(fab);
  document.body.appendChild(panel);
})();
