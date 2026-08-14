/* ============================================================================
   Niche Finder — PUBLIC article catalogue (SEO acquisition engine).
   One feature-selling article per feature/function/functionality. Rendered
   for EVERY visitor by blog.html + article.html — no localStorage, no admin
   dependency, no gateway needed. The SEO Autopilot appends more on top of this.

   Each article body is woven with DYNAMIC HYPERLINKS at render time: the first
   occurrence of every mapped phrase links into the product page that delivers
   it (LINKS), every article cross-links a rotating set of others (backlink
   mesh), and two external authority citations per article. article.html also
   emits JSON-LD + canonical for each.
   ============================================================================ */
(function () {
  'use strict';

  // phrase -> internal destination. First hit per article becomes a link.
  var LINKS = [
    [/free niche score|score your (business )?idea/i, 'index.html#top'],
    [/search canvas|discovery|niche search/i, 'search.html'],
    [/deterministic scor\w+|confidence score|three pillars?|PRS|CS|PSS/i, 'how-it-works.html'],
    [/breakthrough (discovery|potential)/i, 'search.html'],
    [/capital[- ]bracket|£10k|10k ceiling/i, 'how-it-works.html'],
    [/ACU|credits?|top[- ]?up|welcome credits?/i, 'how-it-works.html'],
    [/deep[- ]dive|build hub|project workspace/i, 'project.html'],
    [/market validation|validation report/i, 'project.html'],
    [/financial (model|forecast)|cashflow|3-year|profit (and|&) loss|P&L/i, 'project.html'],
    [/pitch deck|business plan|investor pack(age)?|investor memo/i, 'project.html'],
    [/risk (heatmap|map)/i, 'project.html'],
    [/growth engine|social media post|advert|email campaign|landing page|hashtag|video script/i, 'growth.html'],
    [/government mode|venture[- ]demand|observatory|policy brief/i, 'government.html'],
    [/incubator|accelerator|cohort/i, 'about.html'],
    [/command center|wallet|ledger/i, 'dashboard.html'],
    [/end[- ]to[- ]end encryption|human[- ]only|security/i, 'privacy.html'],
    [/support concierge|support/i, 'contact.html']
  ];
  var EXT = [
    ['CB Insights — top reasons startups fail', 'https://www.cbinsights.com/research/report/startup-failure-reasons-top/'],
    ['World Bank Enterprise Surveys', 'https://www.worldbank.org/en/programs/enterprise-surveys']
  ];

  // p([heading, paragraph]) — paragraph strings get autolinked at render.
  var A = [
    { slug: 'free-niche-score-any-country', cat: 'GET STARTED',
      title: 'Score Any Business Idea Free — In Any Country, in Seconds',
      meta: 'Get an instant, scored preview of any business idea for your country — free, no signup, no card.',
      lead: 'The fastest way to know if an idea is worth your year is to score it before you build it — and now that first check is free.',
      s: [['The problem with picking by gut', 'Most ventures fail on market choice, not effort. The single cheapest way to avoid that is to score your idea against real demand before spending a penny.'],
          ['One box, one country, one number', 'Type your idea and your country into the free niche score on the homepage and you get an instant preview across three pillars — market readiness, competitive gap, prospect of success — with a clear verdict.'],
          ['From free preview to full breakdown', 'Like what you see? The full country-grounded analysis runs in the search canvas with your 100 welcome credits — real evidence, competitors, and numbers.'],
          ['Why this beats a brainstorm', 'A brainstorm gives you ten ideas and no way to choose. A score gives you a ranked decision you can defend.']] },

    { slug: 'search-canvas-ranked-opportunities', cat: 'DISCOVERY',
      title: 'How the Search Canvas Turns a Country + Budget into Ranked Business Opportunities',
      meta: 'One search returns ranked, scored, fundable niche opportunities grounded in your exact market.',
      lead: 'Stop searching for ideas and start selecting them. The search canvas is the front door of the operating system.',
      s: [['Country is mandatory — for a reason', 'Every opportunity is grounded in the market you choose, because a business that works in London may not work in Lagos. The niche search reads local demand signals, comparable operators, and cost structures.'],
          ['Ranked, not random', 'Results arrive ranked by a deterministic scoring engine, each capped at the £10k capital class so everything on the list is realistically fundable.'],
          ['Six starting points', 'From “I have no idea” to “validate the idea I already have”, the canvas meets every founder where they are.'],
          ['Then go deep', 'Unlock the winner and open its deep-dive workspace to build the full pack.']] },

    { slug: 'deterministic-scoring-no-black-box', cat: 'METHOD',
      title: 'Why Deterministic Scoring Beats Gut Feel — and AI Hype',
      meta: 'Market readiness, competitive gap, and prospect of success — scored out of 10, reproducibly, with hard GO/NO-GO bands.',
      lead: 'An idea you cannot measure is an idea you cannot compare. Deterministic scoring makes venture selection an engineering decision.',
      s: [['Three pillars, three failure modes', 'The deterministic scoring engine weighs market readiness (35%), competitive gap (30%), and prospect of success (35%) — each measures a different way ventures die.'],
          ['The same inputs give the same score', 'AI gathers the evidence; a pure function does the arithmetic. Identical inputs produce identical scores, every time — no black box.'],
          ['It says NO GO when it means it', 'STRONG GO, CONDITIONAL GO, NO GO. A tool that only ever says yes is a tool you cannot trust.'],
          ['Honesty is the feature', 'Per CB Insights, most startups die from no market need — a score you can interrogate is how you avoid being one.']] },

    { slug: 'breakthrough-discovery-mode', cat: 'DISCOVERY',
      title: 'Breakthrough Discovery: Finding the Outlier, Not the Obvious',
      meta: 'A fourth scoring pillar hunts structural timing advantages — and admits when nothing genuinely qualifies.',
      lead: 'The best opportunities are not the loudest. Breakthrough discovery looks for unmet demand meeting a market that just became reachable.',
      s: [['Beyond the obvious niche', 'Breakthrough potential adds a fourth pillar to the deterministic scoring, weighting structural timing advantages the standard search would rank as merely solid.'],
          ['A high bar, honestly enforced', 'An opportunity is only labelled a breakthrough when both breakthrough potential and prospect of success clear 7.5 out of 10.'],
          ['No invented hype', 'When nothing qualifies, the search canvas says so plainly and shows the strongest realistic opportunities instead.']] },

    { slug: 'ten-thousand-capital-class', cat: 'STRATEGY',
      title: 'The £10k Ceiling Is a Feature: Why Capital Constraints Build Better Businesses',
      meta: 'Every opportunity is buildable under £10k / $10k / €10k — a constraint that forces durable wedge thinking.',
      lead: 'Unlimited budgets hide bad ideas. A hard capital ceiling exposes them.',
      s: [['Constraint as strategy', 'Every result sits inside the £10k capital class, with intelligent currency parity for dollarized and local-currency economies.'],
          ['Wedge, then replicate', 'A capped budget forces one corridor, one depot, one paying segment — the way durable businesses actually start.'],
          ['Fundable by design', 'Because the ceiling is built in, every opportunity on your list is one a small investor or your own savings can actually reach.']] },

    { slug: 'capital-bracket-pricing-fair', cat: 'PRICING',
      title: 'Capital-Bracket Pricing: Prices That Scale With Ambition, Not With Seats',
      meta: 'Build under £10k and pay the base rate; larger ventures pay proportionally more — shown live before you commit.',
      lead: 'A £5k side hustle and a £90k venture should not pay the same for the same tool. They do not here.',
      s: [['Pay for the scale you are at', 'Ventures in the standard £10k capital class pay base prices; higher brackets pay proportionally more, doubling per £10k band.'],
          ['Always visible, never a surprise', 'Move the capital slider in the search canvas and every price updates live before you commit.'],
          ['Fair at both ends', 'The smallest founders pay the least; the biggest pay for the value they extract. Unique in the market.']] },

    { slug: 'acu-economy-pay-per-outcome', cat: 'PRICING',
      title: 'The ACU Economy: Pay for Outcomes, Not a Monthly Seat You Forget',
      meta: '£1 = 100 ACU, every price shown before you confirm, 100 free welcome credits to start.',
      lead: 'Subscriptions charge you whether you ship or not. The ACU economy charges you only when you generate value.',
      s: [['One transparent anchor', 'ACU credits run the platform at a fixed £1 = 100 ACU, and every action shows its exact cost before you confirm it.'],
          ['Start free', 'Every account opens with 100 welcome credits to browse and preview — no card required.'],
          ['Top up from £5', 'Buy only what you use; packages from £5 carry bonus credits. No lock-in, no wasted seat.']] },

    { slug: 'deep-dive-build-hub', cat: 'BUILD',
      title: 'Inside the Deep-Dive Workspace: From Score to Investor-Ready',
      meta: 'Unlock an opportunity and open a living project — operating brief, status pipeline, versioned document repository.',
      lead: 'A score tells you what to build. The deep-dive workspace helps you build it.',
      s: [['A living project, not a PDF dump', 'The deep-dive build hub gives every unlocked opportunity an operating brief, a status pipeline from unlocked to investor-ready, and a versioned repository.'],
          ['Engines on tap', 'Run market validation, the financial forecast, the risk heatmap, the business plan, and the pitch deck — each from the same evidence base.'],
          ['Autosaved, always', 'Every decision is recorded in project memory; nothing is lost between sessions.']] },

    { slug: 'market-validation-report', cat: 'BUILD',
      title: 'Market Validation in Minutes: Proof Before You Spend',
      meta: 'An investor-grade validation report — demand evidence, sizing, competitor scan, timing — for your exact niche.',
      lead: 'The research a consultancy bills thousands for, generated for the price of a coffee and versioned in your repository.',
      s: [['Evidence, not enthusiasm', 'The market validation report assembles demand evidence, market sizing, a competitor scan, and timing analysis for your exact niche in your exact country.'],
          ['Priced like software, not consulting', 'A professional research study costs thousands and weeks; this is 250 credits and minutes.'],
          ['Diligence-ready', 'The evidence base feeds every downstream document, so the numbers reconcile.']] },

    { slug: 'ai-financial-model-forecast', cat: 'BUILD',
      title: 'CFO-Grade Financials Without a CFO: 3-Year Forecasts on Demand',
      meta: 'A 3-year cashflow forecast, structured P&L, and downloadable Excel model — built from your market’s real numbers.',
      lead: 'The six-week wait for a financial model is the reason many founders never reach the investor conversation. Not anymore.',
      s: [['The numbers investors ask for', 'The financial model produces a 3-year cashflow forecast, a structured profit and loss with margins and break-even, and a downloadable Excel model.'],
          ['Assumption-driven, market-grounded', 'Built from your market’s real cost structures, not a generic template.'],
          ['Minutes, not weeks', 'What used to block fundraising for a month now ships in one sitting.']] },

    { slug: 'risk-heatmap-know-what-kills-it', cat: 'BUILD',
      title: 'Risk Heatmap: Know What Kills It Before Your Investor Does',
      meta: 'Regulatory, operational, and market exposures mapped by probability and impact.',
      lead: 'The first time you hear the hard questions should not be in the investor meeting.',
      s: [['Every exposure, mapped', 'The risk heatmap plots regulatory, operational, and market exposures by probability and impact for your specific venture and market.'],
          ['Prepared, not surprised', 'Walk into the room already knowing your top three risks and your answer to each.']] },

    { slug: 'business-plan-pitch-deck-engines', cat: 'BUILD',
      title: 'The Fundraising Pack, Done: Business Plan + Investor Pitch Deck',
      meta: 'A professional business plan and a 12-slide pitch deck, grounded in your validated data and export-ready.',
      lead: 'A plan and a deck whose numbers actually agree — because they come from the same evidence.',
      s: [['Grounded, branded, ready', 'The business plan and pitch deck engines produce investor-ready documents built on your validated data, with premium template tiers when the room demands polish.'],
          ['They reconcile', 'Unlike a separate plan tool and deck tool, these draw from one evidence base — the deck’s numbers are the forecast’s numbers.'],
          ['The full pack', 'Add the investor memo, execution roadmap, and market-entry plan for the complete picture.']] },

    { slug: 'full-investor-package-investor-mode', cat: 'BUILD',
      title: 'Walk In Fundable: The Full Investor Package and Investor Mode',
      meta: 'One command assembles the complete investor package; Investor Mode restructures every output for funding conversations.',
      lead: 'Everything an investor asks for, assembled into one pack, in an afternoon.',
      s: [['One command, complete pack', 'The full investor package assembles validation, financials, plan, deck, memo, and roadmap into a single investor-ready bundle.'],
          ['Turn it up', 'Flip on Investor Mode and every output is restructured for real funding conversations.']] },

    { slug: 'ai-growth-engine-marketing', cat: 'GROWTH',
      title: 'The AI Growth Engine: A Week of Marketing in Minutes',
      meta: 'Social posts, adverts, email campaigns, landing pages, hashtags, and video scripts — plus audience and timing intelligence.',
      lead: 'Building the venture is half the job. The growth engine handles the other half.',
      s: [['Ten tools, one dashboard', 'The growth engine generates platform-native social posts, adverts, email campaigns, landing pages, hashtag sets, and video scripts.'],
          ['Intelligence, not just output', 'Best-posting-time, audience optimisation, campaign analytics, and performance recommendations tell you where, when, and to whom.'],
          ['For you and your partners', 'Every partner can produce co-branded promotion from inside the operating system.']] },

    { slug: 'government-mode-observatory', cat: 'INSTITUTIONS',
      title: 'Government Mode: A Venture-Demand Observatory for Policymakers',
      meta: 'Aggregated, k-anonymised venture-demand analytics — sector demand, adoption velocity, geographic heatmaps, policy briefs.',
      lead: 'Where entrepreneurial demand is heading in your country, with zero personal data.',
      s: [['Demand, aggregated', 'Government mode gives governments and development-finance institutions a venture-demand observatory: sector demand, adoption velocity, and geographic heatmaps.'],
          ['Privacy by construction', 'Every figure is k-anonymised — no personal data, no small-cell disclosure.'],
          ['Actionable per country', 'Each region gets a policy brief, not just a dashboard.']] },

    { slug: 'incubator-cohort-portal', cat: 'INSTITUTIONS',
      title: 'Run an Entire Cohort on One Venture Intelligence OS',
      meta: 'Pooled credit allocation, comparative scoring across the portfolio, and cohort intelligence reports for incubators.',
      lead: 'Systematic opportunity evaluation for every founder in your programme.',
      s: [['One pool, many founders', 'Incubators and accelerators manage member cohorts with pooled credit allocation and comparative scoring across the portfolio.'],
          ['See the whole portfolio', 'Cohort intelligence reports rank ventures and flag the ones that need help.']] },

    { slug: 'end-to-end-encryption-human-only', cat: 'TRUST',
      title: 'Your Next Business Is Yours: End-to-End Encryption and Human-Only Access',
      meta: 'Encrypted in transit and at rest, per-user document keys, and bots blocked at signup and login.',
      lead: 'The idea you are about to build is exactly the kind of thing worth protecting.',
      s: [['Encrypted, by construction', 'The platform uses end-to-end encryption: TLS in transit, AES-256 at rest, and venture documents under per-user keys.'],
          ['Humans only', 'Human-only access blocks bots and scripted clients at signup and login; machines get one door — the keyed partner API.'],
          ['Honest by default', 'Every output is labelled probabilistic. You are the final decision-maker.']] },

    { slug: 'support-concierge-instant-help', cat: 'SUPPORT',
      title: 'Instant Answers: The Support Concierge on Every Page',
      meta: 'Pricing, scoring, and build questions answered instantly, escalating to a human the moment it should.',
      lead: 'No ticket portals, no waiting rooms — help where you are, when you need it.',
      s: [['Always one click away', 'A quiet support concierge sits on every page and answers pricing, scoring, and build questions instantly.'],
          ['Human when it matters', 'It escalates to the team the moment a question needs a person.']] },

    { slug: 'command-center-cockpit', cat: 'PRODUCT',
      title: 'Your Command Center: The Whole Venture Pipeline at a Glance',
      meta: 'Wallet, saved niches, generated assets, engine runs, and a predictive next-action report in one live view.',
      lead: 'Every founder gets a cockpit, not a dashboard.',
      s: [['One live view', 'The command center shows your wallet, saved niches, generated assets, and engine runs at a glance.'],
          ['A ledger you can trust', 'Every credit and charge is timestamped and auditable, with low-balance alerts before you hit a wall.'],
          ['The next move, surfaced', 'A predictive intelligence report reads your activity and names the single action that moves your venture forward.']] }
  ];

  function esc(s){ var d = document.createElement('i'); d.textContent = s; return d.innerHTML; }
  function autolink(par, state){
    var html = esc(par);
    for (var i = 0; i < LINKS.length; i++){
      if (state.used[i]) continue;
      var m = html.match(LINKS[i][0]);
      if (m){ state.used[i] = true; html = html.replace(m[0], '<a href="' + LINKS[i][1] + '">' + m[0] + '</a>'); }
    }
    return html;
  }

  globalThis.NF_ARTICLES = {
    list: A,
    LINKS: LINKS,
    EXT: EXT,
    bySlug: function (slug) { for (var i = 0; i < A.length; i++) if (A[i].slug === slug) return A[i]; return null; },
    autolink: autolink
  };
})();
