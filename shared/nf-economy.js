/* ============================================================================
   Niche Finder — SHARED canonical ACU economy.
   Single source of truth for the commercial constants enforced on BOTH sides:
   the browser wallet (frontend/nf-wallet.js) and the gateway meter
   (backend/gateway/src/wallet.js, router.js).

   This file is deliberately valid as BOTH a classic browser script and an ES
   module: it only declares locals and assigns to `globalThis.NF_ECONOMY`.
   - Browser: load ../shared/nf-economy.js via a script tag before nf-wallet.js
   - Node:    import '../../shared/nf-economy.js' then read globalThis.NF_ECONOMY

   GOVERNANCE: these values change only by versioned S-ADMIN decision recorded
   in docs/AIOS-TRANSFORMATION-SPEC.md — code, copy, and contract never disagree.
   ============================================================================ */
(function () {
  'use strict';

  var ANCHOR_GBP_PER_100_ACU = 1; // £1 = 100 ACU, fixed
  var WELCOME_FREE = 100;         // one-time, read-only — never funds generation

  var PACKAGES = [
    { id: 'starter_5',   name: 'Starter',  priceGBP: 5,  acus: 500,  bonus: 0,    total: 500,  desc: 'Enough for 4 niche searches.' },
    { id: 'builder_10',  name: 'Builder',  priceGBP: 10, acus: 1000, bonus: 100,  total: 1100, desc: 'Deeper exploration and early project building.', recommended: true },
    { id: 'founder_20',  name: 'Founder',  priceGBP: 20, acus: 2000, bonus: 400,  total: 2400, desc: 'Serious project building and financial outputs.' },
    { id: 'investor_50', name: 'Investor', priceGBP: 50, acus: 5000, bonus: 1500, total: 6500, desc: 'Full investor packages across multiple ventures.' }
  ];

  /* Recurring subscription PLANS. Each paid plan grants a monthly ACU allotment
     (credited to the spendable/paid balance on each Stripe billing cycle; the
     paid balance rolls over). Self-serve plans have a monthly GBP price; the
     Enterprise plan is contact-sales (no self-serve checkout). `free` is the
     default, non-purchasable state. Prices/allotments are the canonical source
     for both the dashboard cards and the gateway checkout. */
  var PLANS = [
    { id: 'free',    name: 'Free',         priceGBP: 0,   acusPerMonth: 0,    selfServe: false, desc: 'One-time welcome ACU · browse & preview' },
    { id: 'starter', name: 'Starter',      priceGBP: 19,  acusPerMonth: 200,  selfServe: true,  desc: 'Rollover · unlock + validation focus' },
    { id: 'pro',     name: 'Professional', priceGBP: 49,  acusPerMonth: 600,  selfServe: true,  recommended: true, desc: 'Rollover · all documents · priority generation' },
    { id: 'growth',  name: 'Growth',       priceGBP: 99,  acusPerMonth: 1500, selfServe: true,  desc: 'Bulk generation · API access · 3 team seats' },
    { id: 'ent',     name: 'Enterprise',   priceGBP: null, acusPerMonth: null, selfServe: false, desc: 'White-label · SSO · SLA · compliance reports' }
  ];

  /* Canonical action schedule — bracket-1 (≤ £10k) prices. */
  var COSTS = {
    niche_search: 125,
    quick_preview: 20,      // lightweight single-niche teaser — welcome (free) ACU may fund it
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
    gtm: 750,               // Go-To-Market Execution Blueprint (0–90 day launch plan)
    pitch: 500,             // standard deck; premium 650 / elite 850 by template tier
    pitch_premium: 650,
    pitch_elite: 850,
    ppt_export: 200,
    investor_memo: 350,
    execution_roadmap: 300,
    market_entry: 350,
    full_investor_package: 1500,
    growth_hashtags: 25,    // AI Growth Engine — floor-compliant marketing tools
    growth_insight: 25,     // intelligence tools — every AI action is metered, none free
    growth_post: 40,
    growth_advert: 60,
    growth_email: 80,
    growth_video_script: 90,
    growth_landing: 120,
    support_message: 1,     // support chat — 1 ACU per message, free ACUs allowed
    investor_multiplier: 1.4
  };

  /* Capital-bracket margin law: prices anchor 3–10× above provider cost in
     bracket 1 (≤ £10k); every further £10k bracket doubles the band and every
     price. Factor caps at ×1024 (bracket 11+). */
  function bracketFor(amount) {
    var a = Number(amount);
    if (!Number.isFinite(a) || a <= 10000) return { tier: 1, factor: 1, band: '3–10×' };
    var tier = Math.min(Math.ceil(a / 10000), 11);
    var f = Math.pow(2, tier - 1);
    return { tier: tier, factor: f, band: (3 * f) + '–' + (10 * f) + '×' };
  }

  function costFor(actionKey, capitalAmount) {
    var base = COSTS[actionKey];
    if (base == null) return null;
    return Math.round(base * bracketFor(capitalAmount).factor);
  }

  /* ---------- fully-loaded unit economics (the 100%-profit floor law) ----------
     Price is anchored to FULLY-LOADED cost, not just the AI provider bill:
       COGS per action = AI provider cost
                       + cloud/Firebase infra allocation
                       + payment processing (Stripe % of revenue + fixed fee,
                         allocated per action)
                       + operating overhead (allocated as % of revenue)
     LAW: every action's price must be at least MIN_PROFIT_MULTIPLE × its
     fully-loaded cost — i.e. ≥ 100% net profit at bracket 1, before the
     capital-bracket doubling widens it further. Solving
       price ≥ 2 × (ai + infra + fix + (stripePct + overheadPct) × price)
     gives  price ≥ 2 × (ai + infra + fix) / (1 − 2 × (stripePct + overheadPct)),
     ≈ 3.1 × direct cost with the defaults below — which is exactly why the
     bracket-1 band floors at 3×: the 3× floor is what funds Stripe, cloud,
     and overhead while still doubling the money. */
  var UNIT_ECONOMICS = {
    stripePct: 0.029,          // card fee % (intl card, worst common case)
    stripeFixedGBP: 0.20,      // fixed fee per charge, allocated across ~4 actions/purchase
    stripeFixedPerActionGBP: 0.05,
    infraPerActionGBP: 0.02,   // Cloud Run / Firebase / storage / egress per action
    overheadPctRevenue: 0.15,  // support, tooling, monitoring, misc. ops
    minProfitMultiple: 2       // 100% profit on fully-loaded cost, minimum
  };

  /* Fully-loaded cost of one action given the raw AI provider cost and price. */
  function loadedCostGBP(aiCostGBP, priceGBP) {
    return aiCostGBP +
      UNIT_ECONOMICS.infraPerActionGBP +
      UNIT_ECONOMICS.stripeFixedPerActionGBP +
      (UNIT_ECONOMICS.stripePct + UNIT_ECONOMICS.overheadPctRevenue) * priceGBP;
  }

  /* Minimum compliant price (GBP) for an action with this raw AI cost. */
  function minPriceGBP(aiCostGBP) {
    var m = UNIT_ECONOMICS.minProfitMultiple;
    var variable = UNIT_ECONOMICS.stripePct + UNIT_ECONOMICS.overheadPctRevenue;
    return (m * (aiCostGBP + UNIT_ECONOMICS.infraPerActionGBP + UNIT_ECONOMICS.stripeFixedPerActionGBP)) /
      (1 - m * variable);
  }

  /* Minimum compliant ACU charge for an action (bracket 1; multiply by the
     bracket factor after). £1 = 100 ACU. */
  function minAcuFor(aiCostGBP) {
    return Math.ceil(minPriceGBP(aiCostGBP) * 100);
  }

  /* True profit check: does this price clear ≥100% profit fully loaded? */
  function meetsProfitFloor(priceGBP, aiCostGBP) {
    return priceGBP >= UNIT_ECONOMICS.minProfitMultiple * loadedCostGBP(aiCostGBP, priceGBP);
  }

  globalThis.NF_ECONOMY = {
    ANCHOR_GBP_PER_100_ACU: ANCHOR_GBP_PER_100_ACU,
    WELCOME_FREE: WELCOME_FREE,
    PACKAGES: PACKAGES,
    PLANS: PLANS,
    COSTS: COSTS,
    bracketFor: bracketFor,
    costFor: costFor,
    UNIT_ECONOMICS: UNIT_ECONOMICS,
    loadedCostGBP: loadedCostGBP,
    minPriceGBP: minPriceGBP,
    minAcuFor: minAcuFor,
    meetsProfitFloor: meetsProfitFloor
  };
})();
