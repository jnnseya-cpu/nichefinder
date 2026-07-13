# Niche Finder AI-OS — Production Architecture & Developer Document

**Version 1.0 · July 2026 · Status: Build-ready specification**

This document turns the Niche Finder prototype (static multi-page front-end + zero-framework AI gateway) into a production-grade **AI Infrastructure Operating System for venture creation**. Nothing in the existing concept is removed: the country-first search, the ≤ £10k/$10k/€10k capital cap, the deterministic PRS/CS/PSS/BPS scoring, the ACU prepaid economy (£1 = 100 ACU), the Build Hub asset factory, the Super Admin OS, and the multi-provider AI gateway are all preserved and are the foundation every section below builds on.

Every pattern referenced here is commercially proven: prepaid usage credits (OpenAI/Anthropic API billing), reserve-then-settle metering (Stripe/AWS), multi-agent orchestration behind a single gateway (Palantir AIP, Bloomberg Terminal function model), zero-trust identity (Google BeyondCorp), idempotent webhook ledgers (Stripe), and event-sourced audit trails (banking core systems).

---

## 1. Executive Product Vision

**What it is.** Niche Finder AI-OS is the operating system a founder runs a venture on — from first market signal to investor-ready pack. One deterministic scoring engine, one prepaid ACU wallet, one multi-agent AI layer, one auditable ledger.

**The problem.** First-time founders fail at *selection*, not execution: they commit capital to opportunities with no demand evidence, misjudge local competition, or pick ideas unbuildable at their budget. The research that would tell them costs more than the venture. Existing tools either generate generic ideas (no market grounding, no capital constraint) or serve funded startups (Crunchbase, PitchBook, CB Insights — priced and designed for investors, not £10k operators).

**Why it wins.**
1. **Hard constraints are the product.** Country is mandatory; capital is capped at the £10k class. Every output is executable by the person asking, in the place they asked about.
2. **Deterministic, explainable scoring.** PRS (35%) / CS (30%) / PSS (35%) on a 0–10 traffic-light scale with fixed decision labels (STRONG GO ≥ 7.5, CONDITIONAL GO 6.0–7.4, NO GO < 6.0). Same inputs → same verdict. The optional Breakthrough Potential Score (BPS) powers a distinct discovery mode with an honest fallback when no credible breakthrough exists.
3. **Internally consistent outputs.** The forecast in the pitch deck is the same model as the Excel export, anchored to the same assumptions — a property none of the "AI business plan generator" competitors have.
4. **A real economy, not a subscription.** ACU prepaid credits meter every action at value-based prices (search 125, unlock 150, business plan 500, full investor package 1,500) with a strict margin rule (user charge ≥ 3× provider cost). Revenue scales with usage, and the free tier (100 read-only welcome ACU) can never create negative-margin usage.
5. **Provider-agnostic AI.** The gateway routes claude → gemini → openai with failover; model churn never touches product surface area. Users buy ACUs, never tokens.

**Market position.** "Bloomberg Terminal for the £10k founder" — infrastructure pricing power, not SaaS-template pricing.

---

## 2. Market Gap Deep Review

| Segment | What they do well | Where they fail | How AI-OS fills it |
|---|---|---|---|
| Idea generators (ChatGPT prompts, IdeaBuddy, Dimeadozen) | Cheap, fast brainstorming | No country grounding, no capital cap, no deterministic scoring, hallucinated market sizes | Hard constraints + deterministic engine + anti-fantasy filters |
| Business-plan SaaS (LivePlan, Upmetrics) | Document templates, forecasting UI | User must already know the opportunity; numbers not AI-derived from market signals; no discovery loop | Discovery → score → unlock → build in one ledgered pipeline |
| Investor intelligence (Crunchbase, CB Insights, PitchBook) | Deep data on funded companies | Priced $10k–$50k/yr; zero coverage of pre-idea founders and frontier markets | £5 entry, frontier-market parity (local-currency $10k-equivalent cap), five-sector taxonomy incl. informal economy |
| Freelance analysts / consultants | Custom quality | £2k–£10k per deliverable; weeks of latency; not repeatable | 500-ACU (£5) business plan in minutes, versioned, regenerable at half price |
| No-code venture studios | Execution support | No selection intelligence; survivor-bias playbooks | Predictive scoring + risk heatmaps before capital is committed |

**Underserved users:** diaspora builders operating between two countries; frontier-market founders (DRC, Nigeria, Kenya) where dollarized/local-parity budgeting matters; "boring business" buyers who need cashflow evidence, not narratives; development-finance institutions and government SME programmes needing aggregated, anonymised demand heatmaps (Government Mode — an existing concept preserved and productised in §6).

**Money left on the table by competitors:** per-asset micro-transactions, investor-package bundles, white-label licensing to accelerators/DFIs, anonymised sector-demand data products, and payment-gateway revenue share (BitriPay, §7).

---

## 3. Complete User Ecosystem

| User type | Description | Primary surface | Monetisation touchpoint |
|---|---|---|---|
| **Operator (founder)** | Individual discovering and building ventures | Search Canvas, Deep-Dive, Command Center | ACU top-ups, action fees |
| **Pro Operator** | Serial builder / portfolio operator | Multi-project Command Center, Scenario Builder | Founder/Investor packages, Investor Mode ×1.4 |
| **Merchant / Partner** | Accelerators, incubators, agencies reselling access | Partner Portal, referral engine | Commission split, white-label licence |
| **Growth Partner (influencer/strategic)** | Referral-driven distribution | Partner dashboard (approve/suspend/commission — already in Super Admin OS) | Revenue share on referred top-ups |
| **Developer** | Integrates scoring/generation via API | Developer Centre, API keys, sandbox | API usage fees (ACU-metered) |
| **Enterprise / Government** | DFIs, ministries, banks' SME desks | Government Mode: aggregated heatmaps, sector demand, adoption metrics; no personal data | Enterprise licence, data products |
| **Support Admin** | Handles escalated cases | Platform Ops → Support | — |
| **Finance Admin** | Wallet grants/deducts, refunds, settlement | Platform Ops → Users/Ledger | — |
| **Super Admin** | Full platform governance | Super Admin OS (Command Overview, Platform Ops, SEO War Room, OS Governance) | — |
| **Third-party API partner** | BitriPay, KYC, comms providers | Connector registry | Gateway revenue share |

Role model: `user < partner < developer < support_admin < finance_admin < admin < super_admin`, enforced with custom claims + RBAC middleware (§9, §13).

---

## 4. AI Command Centres (per user type)

Every user type gets a Command Centre: same chassis (KPI strip → workspace → intelligence sidebar, as already built in `dashboard.html` and `admin.html`), different agents and data scope. All agent output follows the mandatory 8-point contract: **Situation, Insight, Risk, Recommendation, Next Action, Owner, Deadline, Confidence**.

| Command Centre | Sees | Can execute | Recommends |
|---|---|---|---|
| **Operator** | Own wallet, projects, ledger, search history, memory | Searches, unlocks, asset generation, exports (ACU-gated) | Next best action, regeneration, top-up timing, risk alerts |
| **Partner** | Referral funnel, commission ledger, cohort conversion | Invite issuance, campaign links | Highest-converting channels, payout forecasts |
| **Developer** | API usage, error rates, latency, ACU burn per endpoint | Key rotation, webhook replay, sandbox resets | Cost-optimal request shapes, cache hits |
| **Finance Admin** | All wallets, top-ups, refunds, margin per action | Grant/deduct ACU (reasoned, ledgered), refunds, package edits | Margin-floor breaches, pricing anomalies, fraud flags |
| **Super Admin** | Everything: revenue, provider costs, agent health, SEO pipeline | Kill-switches, policy edits, model routing overrides, release gates | Governance actions ("Execute margin optimisation on Discovery Core 04"), risk alerts, adoption plays |
| **Government/Enterprise** | Aggregated, anonymised only: heatmaps, sector demand, adoption velocity | Report exports, country filters | Sector-gap briefs, programme targeting |

Per-user agent roster (the "Personal AI Chief of Staff" pattern):

- **Chief of Staff Agent** — planning, prioritisation, project-pipeline management; owns the "Next Recommended Action" slot.
- **Analyst Agent** — runs the deterministic scoring engine, forecast maths, benchmark comparisons; never invents scores (model explains, backend computes).
- **Research Agent** — country/sector/competitor intelligence sweeps behind niche generation; feeds the anti-fantasy and quality filters.
- **Automation Agent** — detects repeated behaviour, proposes presets, executes approved auto-regeneration.
- **Growth Agent** — top-up propensity, upsell to bundles, churn-risk interventions.
- **Security Agent** — session anomalies, welcome-credit farming, device-cluster abuse (per-user slice of the platform SOC).
- **Knowledge Agent** — the four-tier memory (User / Workspace / Process / Intelligence) already specified; every event updates it.

---

## 5. Core AI Agents (platform workforce)

All agents run behind the AI Orchestrator (§9). Uniform definition schema:

```ts
interface AgentSpec {
  id: string;                     // e.g. "scoring"
  tier: "executive"|"product"|"engineering"|"quality"|"security"|"revenue"|"customer"|"compliance"|"platform";
  purpose: string;
  inputs: string[];               // data sources / event types
  outputs: string[];              // artifacts / events emitted
  permissions: string[];          // RBAC scopes; agents NEVER hold provider keys directly
  triggers: string[];             // events or cron
  escalation: { to: string; when: string };
  providers: ("claude"|"gemini"|"openai"|"deterministic")[];
  acuPolicy: { billedTo: "user"|"platform"; action?: string };
}
```

Key agents (the full registry lives in `services/orchestrator/agents.manifest.ts`):

| Agent | Purpose | Inputs | Outputs | Triggers | Escalates to |
|---|---|---|---|---|---|
| **Onboarding** | Initialise operator: wallet {paid:0, free:100}, welcome ledger entry, pathway selection | signup event, referral code | wallet doc, `WELCOME` ledger row, memory seed | `user.created` | Support on verification failure |
| **Niche Discovery** | Country-grounded opportunities under capital cap; five-sector taxonomy; discovery modes (no-idea / skills / around-me / boring / breakthrough) | SearchRequest, country macro signals, user memory | ranked NicheResult[] with score inputs | `search.created` (125 ACU, Investor Mode ×1.4) | Quality Agent if < N results pass filters |
| **Scoring** | Deterministic PRS/CS/PSS(/BPS); decision labels; breakthrough rank = PSS·0.25 + BPS·0.30 + MSP·0.10 + PPP·0.30 + PRS·0.05; fallback if BPS<7.5 OR PSS<7.5 with the exact user message | raw score inputs from Discovery | ScoreBundle, decision label, fallback flag | inline after Discovery | — (pure function; cannot escalate, cannot hallucinate) |
| **Risk** | Risk heatmaps, execution-gap alerts, sensitivity flags | project data, forecast, country signals | risk register, severity-coded alerts | `niche.unlocked`, `forecast.generated` | Compliance on regulatory flags |
| **Revenue / Pricing** | Margin-floor enforcement (charge ≥ 3× provider cost), package performance, dynamic multiplier within policy bounds | provider cost telemetry, ledger | pricing recommendations, auto multiplier bumps | nightly cron, margin-breach event | Finance Admin for price changes > ±10% |
| **Support** | 1-ACU chat, platform-knowledge prompt, structured escalation cases | chat turns, user memory | answers, `support_case` docs | user message | Human support when confidence low / repeat unresolved |
| **Marketing / SEO** | Content pipeline (pillar/comparison/GEO/FAQ/case-study), decay detection, amplification scripts | keyword intel, blog corpus | drafts, refresh tasks, social scripts | SEO War Room actions, weekly cron | Admin for publishing |
| **Fraud Detection** | Welcome-credit farming, device clustering, velocity anomalies, top-up abuse | auth events, ledger, device fingerprints | fraud scores, holds | every wallet mutation | Finance Admin ≥ threshold; auto-hold ≥ critical |
| **Payment** | Checkout sessions, webhook settlement, refunds, commission split | BitriPay/Stripe events | ledger credits, settlement records | webhook receipt | Finance Admin on reconciliation mismatch |
| **API Integration** | Connector health, key rotation schedules, contract-drift detection | connector telemetry | health board, rotation tasks | 5-min cron | Platform on hard failures |
| **Workflow Automation** | Executes approved automations (auto-regenerate stale assets, preset searches) | automation registry, user approval | jobs, notifications | event patterns | Owner user (approval-gated) |
| **Predictive Growth** | LTV, churn risk, top-up forecasting, cohort trends | ledger, engagement events | growth briefs, intervention tasks | daily cron | CMO-Agent brief |
| **Admin Control** | Governance: policy enforcement, agent permission audits, kill-switch state | agent logs, policies | governance report, blocked-action log | continuous | Super Admin (human) — the only agent whose escalation is mandatory-human |

**Self-managing platform layer** (SRE tier): System Health (SLO burn-rate alerts), Bug Detection (error-cluster triage from Sentry-class telemetry), Auto-Repair (restart/rollback runbooks — execute only pre-approved runbooks, never novel mutations), Infra Optimisation (cost per 1k ACU served), Release Management (canary → progressive rollout, auto-rollback on SLO breach), AI Governance (prompt/policy versioning, permission enforcement, model-router overrides).

**Hard rule:** agents act through the same ACU-gated, ledgered, permission-checked APIs as humans. No agent has a side door. High-impact actions (price changes, wallet mutations above limits, releases, policy edits) require human approval — the Admin Control Agent enforces this and its logs are immutable.

---

## 6. Full Platform Modules

Preserved from the prototype and productised:

1. **Landing + trust system** — index, How It Works, About, Blog, Contact, Terms, Privacy, Disclaimer, Cookies; cookie-consent gateway for GTM/Pixel.
2. **AI Search Canvas** — mandatory country; optional sectors (five-sector taxonomy, alphabetical), digital/non-digital/boring/hybrid, lifecycle, target customer, business model, income frequency, capital (≤ 10k class, currency parity: GBP/EUR/USD zones flat 10k; dollarized zones $10k; others local-currency $10k-equivalent), 260-char context; discovery modes; search priority incl. Breakthrough; Investor Mode toggle.
3. **Results layer** — ranked cards with PRS/CS/PSS/BPS chips, verdict badges, locked-insight indicators, unlock CTA (150 ACU), save-to-portfolio (free), breakthrough fallback banner.
4. **Deep-Dive workspace** (`project.html`) — AI Operational Brief (8-point contract), Decision Intelligence Matrix, thesis, market metrics, 3-year financial model + chart, risk register, roadmap, lifecycle tracker (shortlisted → unlocked → validated → financial_ready → pitch_ready → investor_ready), Build Hub, Memory tab.
5. **Build Hub / Asset Factory** — validation 250, cashflow 250, P&L 220, risk heatmap 250, Excel model 350, business plan 500 (+PDF 150), pitch deck 500/650/850 by template tier (+PPT 200), investor memo 350, execution roadmap 300, market entry 350, scenario builder 300/700, full investor package 1,500; regenerate at ⌈cost/2⌉; every asset versioned in `generated_assets`.
6. **Branded document renderer** (`asset.html`) — investor-grade templates, internally consistent numbers, methodology disclaimer, export pack.
7. **Command Center** (`dashboard.html`) — wallet (paid/free split), portfolio, engine runs, asset repository, ledger, predictive report, referral engine.
8. **Wallet & billing** — dual-balance wallet, GBP packages (Starter £5/500, Builder £10/1,100, Founder £20/2,400, Investor £50/6,500), top-up modal, display-currency localisation with GBP base.
9. **Super Admin OS** (`admin.html`) — Command Overview KPIs; Platform Ops (Support / Blog / Users / Partners / Ledger); SEO War Room (content generator, war map, strategic brief); OS Governance (revenue, intelligence-core costs abstracted as "Reasoning Cores", margin, adoption velocity).
10. **Government Mode** — aggregated analytics only; country filter; heatmaps, sector demand, adoption metrics; zero personal data.
11. **Support system** — 1-ACU chatbot + escalation cases into Platform Ops.
12. **Notification engine** — generation_complete, export_ready, acu_low, project_ready, recommended_next_action, refund_processed; email/push/in-app.
13. **Developer Centre** — keys, sandbox, docs, webhook console (§7, §11).
14. **Audit & ledger** — append-only ACU ledger + platform event ledger; every module writes to it.

---

## 7. BitriPay Payment Gateway API Door

BitriPay is the first-class payment layer (card, QR, wallet, mobile money) alongside Stripe as fallback. It is exposed both **inbound** (Niche Finder accepting payment) and **outbound** (a plug-and-play "API door" merchants and partner platforms install).

### 7.1 Merchant Integration Portal
- **API keys:** `bp_test_…` / `bp_live_…` pairs, scoped (payments:read, payments:write, refunds:write), rotatable, hashed at rest, last-used telemetry.
- **Environments:** sandbox (simulated settlement, magic amounts trigger failure paths) and production; promotion requires completed merchant KYB.
- **Webhook manager:** endpoint registration, HMAC-SHA256 signing secret per endpoint, replay console, delivery logs with response codes, automatic retries (exponential backoff, 24h), dead-letter queue.

### 7.2 Payment services
| Service | Endpoint | Notes |
|---|---|---|
| Checkout session | `POST /v1/bitripay/checkout` | package_id or amount; returns hosted URL + QR payload |
| Payment links | `POST /v1/bitripay/links` | reusable, expiring, metadata-tagged |
| QR payments | in checkout payload | EMVCo-compatible QR string |
| Wallet payments | `POST /v1/bitripay/wallet/charge` | BitriPay balance |
| Mobile money | provider rails via BitriPay | country-gated |
| Refunds | `POST /v1/bitripay/refunds` | full/partial; ledgered as `REFUND` |
| Disputes | webhook `dispute.opened` → case in Platform Ops | evidence upload API |
| Settlement | `GET /v1/bitripay/settlements` | T+n batches, commission split lines |

### 7.3 Settlement & commission engine
Every successful charge fans out ledger rows atomically: gross → platform fee → partner commission (if referral-attributed) → merchant net. Split rules are versioned config, not code. Reconciliation job compares BitriPay settlement files against internal ledger nightly; mismatches page Finance Admin.

### 7.4 Webhook contract (inbound to Niche Finder)
```
POST /api/webhooks/bitripay
Headers: BitriPay-Signature: t=<ts>,v1=<hmac_sha256(ts + "." + body, secret)>
Events: payment.succeeded | payment.failed | refund.settled | dispute.opened | settlement.posted
Idempotency: event.id recorded in webhook_events (unique index); duplicates ACK 200 and no-op.
On payment.succeeded: verify signature → check idempotency → load package from metadata.package_id
  → credit wallet.paid (+bonus) in one transaction with TOP_UP ledger row → emit payment.completed event.
```
Same handler shape serves Stripe (`checkout.session.completed`) — one settlement engine, two providers.

### 7.5 Developer Centre
SDKs (TypeScript first; REST reference for all), runnable examples, Postman collection, sandbox test cards/wallets, integration checklist, and a plugin-ready drop-in (`<script src="bitripay.js">` + `BitriPay.checkout({...})`) mirroring the pattern already used by `nf-wallet.js`.

---

## 8. Third-Party Connector Ecosystem

All connectors sit behind a **Connector Registry** (uniform interface: `init`, `healthcheck`, `execute`, `webhook`, typed errors, secret refs to the vault — never inline keys). Categories, purpose, and default providers:

| Category | Why needed | Connects to | Default / alternates |
|---|---|---|---|
| Payments | Top-ups, refunds | Wallet, settlement | **BitriPay**; Stripe, Adyen, PayPal |
| Banking-as-a-Service / Open Banking | Partner payouts, enterprise invoicing | Settlement engine | Griffin/ClearBank; TrueLayer |
| KYC/KYB | Merchant onboarding, partner payouts | Onboarding Agent | Sumsub; Persona, Veriff |
| AML screening | Payout compliance | Compliance Agent | ComplyAdvantage |
| Fraud/device intel | Welcome-credit farming, ATO | Fraud Agent | SEON/Fingerprint |
| Email | Receipts, notifications | Notification engine | SendGrid; Brevo |
| SMS / WhatsApp | Frontier-market UX, OTP | Notification engine, USSD/WA search entry | Twilio |
| Push | PWA notifications | Notification engine | FCM |
| Maps/Geo | "Around Me" mode, country enrichment | Discovery Agent | Google Maps |
| AI providers | Generation | AI Gateway | **Anthropic (claude, primary reasoning)** → Gemini (fast/multimodal) → OpenAI (fallback/structured); Vertex for enterprise grounding |
| Currency FX | Display currency + $10k parity | Wallet, Search Canvas | ECB/OpenExchangeRates, cached daily |
| Accounting/Tax | Revenue recognition, VAT MOSS | Finance exports | Xero; Stripe Tax |
| CRM | Partner/enterprise pipeline | Partner portal | HubSpot |
| Analytics | Product telemetry (consent-gated) | Event bus | GTM + self-hosted PostHog |
| Cloud storage | Generated assets, exports | Asset factory | Cloudflare R2 (S3-compatible) |
| Auth | Identity | Identity layer | Firebase Auth / Auth0 |
| Document generation | PDF/XLSX/PPTX | Export engine | Server-side render + pptxgenjs/exceljs |
| E-signature | Enterprise contracts | Enterprise module | Dropbox Sign |
| Support desk | Escalations beyond in-app | Support cases | Plain/Zendesk |
| Data enrichment | Market signals | Research Agent | World Bank/IMF public APIs, provider mix |

Rule: every connector call is wrapped with timeout, retry-with-jitter, circuit breaker, and cost/latency telemetry feeding the API Integration Agent.

---

## 9. Production-Grade Architecture

```
Clients (Web/PWA · Mobile wrapper · WhatsApp/USSD · Partner embeds)
        │
   API Gateway / BFF  ── auth (JWT + custom claims) · rate limits · tenant scoping · request shaping
        │
 ┌──────┴────────────────────────────────────────────────────────┐
 │  Core services (independently deployable; start as modular    │
 │  monolith, split on load):                                    │
 │   • identity-service      • wallet-service (ACU engine)       │
 │   • discovery-service     • scoring-engine (pure, deterministic)│
 │   • asset-service         • orchestrator (agents + routing)   │
 │   • payment-service (BitriPay/Stripe doors)                   │
 │   • notification-service  • seo-service    • admin-service    │
 └──────┬────────────────────────────────────────────────────────┘
        │
   Event bus (Pub/Sub) ── platform_events, wallet events, agent tasks
        │
 ┌──────┴───────────────┐        ┌──────────────────────────────┐
 │ Data layer           │        │ AI Gateway (backend/gateway) │
 │  Postgres (system of │        │  claude → gemini → openai     │
 │  record: wallets,    │        │  failover · structured output │
 │  ledger, users,      │        │  · reserve/settle ACU hooks   │
 │  projects, assets)   │        │  · prompt registry · caching  │
 │  Redis (locks, rate  │        └──────────────────────────────┘
 │  limits, idempotency)│
 │  R2/S3 (asset blobs) │   Observability: OpenTelemetry traces,
 │  Vector DB (memory,  │   structured logs, RED/USE dashboards,
 │  semantic clusters)  │   SLOs: 99.9% API, p95 search < 12s,
 │  Warehouse (BigQuery)│   p95 wallet op < 150ms.
 └──────────────────────┘
```

**Key decisions**

- **Wallet is the system of record and it is SQL.** ACU balances move only inside Postgres transactions (`SELECT … FOR UPDATE`), never in application memory or client storage. The prototype's `localStorage` wallet maps 1:1 onto this service — same `NF.charge/credit/wallet` semantics, server-side.
- **Reserve → execute → settle** for token-variable AI actions: reserve at policy cap, call provider through the gateway, settle at actual cost (never above reservation), refund the difference; on provider failure, cancel reservation fully. Fixed-price actions (the ACU price list) skip settlement variance but keep the same ledger shape.
- **Deterministic core stays deterministic.** `scoring-engine` is a pure package with 100% unit-test coverage; LLMs produce *score inputs* and explanations, the engine produces scores and labels. This is the platform's trust guarantee.
- **Event-driven intelligence.** Every meaningful action emits a typed `platform_event`; the memory layer, growth analytics, fraud scoring, and admin KPIs are all projections over this stream. No side-channel state.
- **Idempotency everywhere:** client-supplied `Idempotency-Key` on all mutating endpoints, unique-indexed; webhook event ids ledgered before processing.
- **Self-healing:** health probes per service; Auto-Repair Agent executes approved runbooks (restart, cache flush, provider re-route, rollback) and files an incident record; anything else pages a human.
- **DR/BCP:** Postgres PITR + cross-region replica (RPO ≤ 5 min, RTO ≤ 1 h); R2 versioned buckets; infra as code (Terraform) for full-region rebuild; quarterly restore drills; provider failover already native to the AI gateway.

---

## 10. Database Schema (Postgres, system of record)

```sql
-- Identity ---------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT,
  country       CHAR(2),
  roles         TEXT[] NOT NULL DEFAULT '{user}',
  status        TEXT NOT NULL DEFAULT 'active',          -- active|suspended|deleted
  fraud_score   NUMERIC(5,2) NOT NULL DEFAULT 0,
  device_hash   TEXT, phone_hash TEXT,                   -- hashed, never raw
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallet & economy --------------------------------------------------------
CREATE TABLE wallets (
  user_id       UUID PRIMARY KEY REFERENCES users(id),
  paid_acu      BIGINT NOT NULL DEFAULT 0 CHECK (paid_acu  >= 0),
  free_acu      BIGINT NOT NULL DEFAULT 0 CHECK (free_acu  >= 0),
  bonus_acu     BIGINT NOT NULL DEFAULT 0 CHECK (bonus_acu >= 0),
  reserved_acu  BIGINT NOT NULL DEFAULT 0 CHECK (reserved_acu >= 0),
  lifetime_purchased BIGINT NOT NULL DEFAULT 0,
  lifetime_spent     BIGINT NOT NULL DEFAULT 0,
  welcome_granted    BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE acu_ledger (                                -- append-only; no UPDATE/DELETE grants
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,        -- WELCOME|TOP_UP|BONUS|ACTION|REGENERATE|REFUND|ADMIN_GRANT|ADMIN_DEDUCT|EXPIRY
  action_key    TEXT,                 -- niche_search, unlock, bizplan, full_investor_package, ...
  delta_acu     BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  provider_cost_usd NUMERIC(10,4),    -- AI actions: real cost for margin telemetry
  multiplier    NUMERIC(5,2),
  reference_id  TEXT,                 -- payment id / asset id / admin action id
  idempotency_key TEXT UNIQUE,
  actor         TEXT NOT NULL,        -- 'user' | 'system' | admin uid | agent id
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON acu_ledger (user_id, created_at DESC);

CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,        -- bitripay|stripe
  package_id    TEXT NOT NULL,        -- starter_5|builder_10|founder_20|investor_50
  amount_gbp    NUMERIC(10,2) NOT NULL,
  display_currency CHAR(3), display_amount NUMERIC(12,2), fx_rate NUMERIC(12,6),
  acu_paid      BIGINT NOT NULL, acu_bonus BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,        -- pending|completed|refunded|disputed
  provider_ref  TEXT UNIQUE,          -- session/intent id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);

CREATE TABLE webhook_events (
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'processed',
  PRIMARY KEY (provider, event_id)                        -- idempotency
);

-- Venture domain ----------------------------------------------------------
CREATE TABLE search_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  country CHAR(2) NOT NULL,
  request JSONB NOT NULL,             -- full SearchRequest incl. priority, investor_mode, discovery_mode
  live BOOLEAN NOT NULL,              -- live AI vs demo
  fallback_used BOOLEAN NOT NULL DEFAULT false,           -- breakthrough fallback fired
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE niche_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES search_sessions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, sector TEXT NOT NULL, country CHAR(2) NOT NULL,
  payload JSONB NOT NULL,             -- description, model, costs, plan, raw score inputs
  prs SMALLINT, cs SMALLINT, pss SMALLINT, bps SMALLINT,  -- 0..100 internal
  msp SMALLINT, ppp SMALLINT,
  overall NUMERIC(4,2) GENERATED ALWAYS AS
    ((prs*0.35 + cs*0.30 + pss*0.35)/10.0) STORED,        -- deterministic in the DB too
  decision TEXT,                      -- STRONG GO | CONDITIONAL GO | NO GO
  unlocked BOOLEAN NOT NULL DEFAULT false,
  unlocked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON niche_results (user_id, created_at DESC);

CREATE TABLE venture_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  niche_id UUID NOT NULL REFERENCES niche_results(id),
  status TEXT NOT NULL DEFAULT 'unlocked',
    -- shortlisted|unlocked|validated|financial_ready|pitch_ready|investor_ready
  acu_spent BIGINT NOT NULL DEFAULT 0,
  memory JSONB NOT NULL DEFAULT '{}',                     -- workspace + process memory
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE generated_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES venture_projects(id),
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                 -- validation|forecast|pnl|riskmap|excel|bizplan|pitch|memo|roadmap|market_entry|package
  version INT NOT NULL DEFAULT 1,
  storage_key TEXT NOT NULL,          -- R2 object
  acu_cost BIGINT NOT NULL,
  investor_mode BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, type, version)
);

-- Events, memory, agents ----------------------------------------------------
CREATE TABLE platform_events (        -- append-only event ledger
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  type TEXT NOT NULL,                 -- search.created, niche.unlocked, plan.generated, payment.completed, risk.detected, ...
  payload JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON platform_events (type, created_at DESC);
CREATE INDEX ON platform_events (user_id, created_at DESC);

CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent TEXT NOT NULL, user_id UUID,
  status TEXT NOT NULL DEFAULT 'queued',                  -- queued|running|completed|failed
  input JSONB, output JSONB, confidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE user_memory (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  tiers JSONB NOT NULL DEFAULT '{}',  -- {user:{...}, workspace:{...}, process:{...}, intelligence:{...}}
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partners, API keys, support ------------------------------------------------
CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tier TEXT NOT NULL,                 -- influencer|strategic
  commission_pct NUMERIC(5,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  referee_id UUID NOT NULL REFERENCES users(id) UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  commission_acu BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,      -- SHA-256; plaintext shown once
  prefix TEXT NOT NULL,               -- nf_live_ / nf_test_
  scopes TEXT[] NOT NULL,
  last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE support_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  transcript JSONB NOT NULL,
  intent TEXT, failure_reason TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Permissions: application role has no `UPDATE/DELETE` on `acu_ledger`, `platform_events`, `webhook_events`. Admin mutations go through stored procedures that also write ledger rows. Row-level security scopes user-facing reads to `user_id = current_setting('app.user_id')::uuid`.

---

## 11. API Specification (v1)

Base: `https://api.nichefinderhq.com/v1` · Auth: `Authorization: Bearer <JWT>` (users) or `X-API-Key: nf_live_…` (developers) · All mutating endpoints accept `Idempotency-Key` · Rate limits: 60 r/min user, 600 r/min developer key (429 + `Retry-After`) · Errors: `{ "error": { "code": "INSUFFICIENT_ACU", "message": "...", "request_id": "..." } }` with stable codes (`INSUFFICIENT_ACU`, `WELCOME_ACU_READONLY`, `CAPITAL_CAP_EXCEEDED`, `FALLBACK_TRIGGERED`, `RATE_LIMITED`, `IDEMPOTENT_REPLAY`, `PROVIDER_UNAVAILABLE`, `FORBIDDEN_SCOPE`).

| Method & path | Purpose | ACU |
|---|---|---|
| `POST /searches` | Run niche search. Body: `{country, sectors?, business_type?, capital_max?, note?, priority?, investor_mode?}` → `202 {search_id}` then results via `GET /searches/:id` or webhook `search.completed` | 125 (×1.4 investor) |
| `GET /searches/:id` | Session + ranked results with score bundle, decision, `fallback_used` | — |
| `POST /niches/:id/unlock` | Unlock full opportunity; creates project | 150 |
| `POST /projects/:id/assets` | `{type: "bizplan"…, investor_mode?}` → `202 {asset_id}` | per price list |
| `GET /projects/:id/assets/:assetId` | Metadata + signed download URL | — |
| `POST /projects/:id/assets/:assetId/regenerate` | New version | ⌈cost/2⌉ |
| `GET /wallet` | `{paid, free, bonus, reserved}` | — |
| `GET /wallet/ledger?cursor=` | Paginated ledger | — |
| `POST /wallet/topups` | `{package_id, provider: "bitripay"\|"stripe", success_url, cancel_url}` → checkout URL | — |
| `POST /webhooks/bitripay` · `/webhooks/stripe` | Signed settlement (see §7.4) | — |
| `GET /me` / `PATCH /me` | Profile | — |
| `POST /support/messages` | Chat turn; may create case | 1 |
| `GET /partner/referrals` · `GET /partner/commissions` | Partner data (scope: partner) | — |
| `POST /admin/users/:id/acu` | `{action:"grant"\|"deduct", amount, reason}` — finance_admin+, ledgered | — |
| `GET /admin/metrics` | Command Overview KPIs | — |
| `GET /gov/heatmap?country=` | Aggregated, k-anonymised (enterprise scope) | — |

Outbound platform webhooks (developer-registered, HMAC-signed, retried): `search.completed`, `asset.ready`, `wallet.low_balance`, `payment.completed`, `project.status_changed`.

Example:
```http
POST /v1/searches
Idempotency-Key: 0d1f…
{ "country": "CD", "sectors": ["agribusiness"], "capital_max": 10000,
  "priority": "breakthrough", "investor_mode": false }

202 { "search_id": "b7e4…", "acu_charged": 125, "balance_after": 975 }
```

---

## 12. Monetisation Model

**Core rule preserved:** £1 = 100 ACU; welcome 100 free ACU read-only; prepaid only, hard stop at zero, no overdraft.

**Capital-bracket margin engine (the pricing law).** The user charge is always AI-provider cost × a multiplier band, and the band is set by the venture's capital bracket:

| Bracket | Capital class | Multiplier band | ACU price factor |
|---|---|---|---|
| 1 | £0 – £10,000 (standard) | 3×–10× provider cost | ×1 (the published price list) |
| 2 | £10,001 – £20,000 | 6×–20× | ×2 |
| 3 | £20,001 – £30,000 | 12×–40× | ×4 |
| n | each further £10k | doubles again | ×2^(n−1), capped at ×1024 |

Within a bracket the dynamic multiplier moves 3×–10× (base) by action tier and margin-floor pressure; the bracket factor then scales the result. Implemented as `bracketFactor(capitalGBP)` in the gateway meter and `NF.bracket()/NF.costFor()` client-side — one formula, enforced at metering time, displayed before every commit. Every quote, reservation, and ledger row records the bracket so margin telemetry stays auditable per class.

| Stream | Mechanics | Notes |
|---|---|---|
| ACU top-ups | £5/£10/£20/£30-style packages with bonus tiers (500 / 1,100 / 2,400 / 6,500) | Primary engine; bonus ACUs drive pack-size upsell |
| Action fees | Fixed price list (§6.5); serious niche ≈ 2,395 ACU end-to-end; full investor package 1,500 | Value-based, not token-based |
| Investor Mode | ×1.4 multiplier on generation | Premium switch, zero marginal build cost |
| Template tiers | Pitch decks 500/650/850 (standard/premium/elite) | Perceived-value ladder |
| Subscriptions (Phase 3) | Pro £29/mo (monthly ACU allowance + watermark-free exports + presets), Studio £99/mo (multi-project, scenario bundles) | Allowance expires monthly; never cheaper per-ACU than Investor pack |
| API usage | Developer keys billed in ACU at same price list + 20% platform fee | Meters through the same wallet engine |
| Partner commissions | 10–20% of referred top-ups, configurable per partner | Already modelled in Super Admin OS |
| White-label / Enterprise | Accelerators, DFIs, banks: per-seat licence + wholesale ACU blocks | Gross-margin-protected wholesale floor |
| Government data products | Aggregated sector-demand heatmaps, adoption reports | Anonymised only; annual licence |
| BitriPay gateway revenue | Share of processing margin on merchant volume through the API door | Fintech flywheel independent of ACU |

**Optimisation engines:** LTV model on ledger cohorts; churn signal = wallet at zero > 14 days with ≥1 unlocked project → win-back credit campaign (bonus ACU, never free-tier expansion); upsell trigger = projected pipeline cost > current balance at unlock time ("This venture needs ~2,395 ACU to reach investor-ready — the Founder pack covers it"); dynamic pricing changes gated by Finance Admin approval and A/B ledger measurement.

---

## 13. Security, Compliance & Risk

- **Zero trust:** every request authenticated and scoped; no network-trust assumptions between services; service-to-service mTLS with short-lived identities.
- **Identity:** MFA (TOTP + WebAuthn), risk-based step-up on new device/geo, device fingerprinting (hashed), session binding, refresh-token rotation with reuse detection.
- **RBAC:** roles from §3 as JWT custom claims; permission checks in the gateway *and* in each service (defence in depth); admin actions require reason strings and produce ledger rows.
- **Application security:** parameterised queries only; CSP + output encoding (XSS); SameSite + CSRF tokens on cookie flows; strict input schemas (zod) at the BFF; upload scanning; API abuse throttling per key/IP/user; bot defence (Turnstile) on auth and checkout.
- **Data protection:** TLS 1.3 in transit; AES-256 at rest (KMS-managed keys, per-service); field-level encryption for PII; tokenisation of payment references (no PAN storage — PCI scope stays SAQ-A via hosted checkout); secrets in a vault with rotation and access audit.
- **Fraud:** welcome-credit farming controls (one grant per verified identity/phone/device-cluster), transaction velocity scoring, top-up/refund pattern analysis, agent-scored holds with human release.
- **AI-specific controls:** prompt-injection filtering on user-supplied context (the 260-char note, uploaded docs); output schema validation before anything touches the ledger; provider keys only in the gateway; per-action token caps; model-router kill switch; agents cannot modify their own permissions (Admin Control Agent + human approval).
- **Compliance:** GDPR/UK-GDPR (DSR endpoints: export, delete with ledger-preserving anonymisation; RoPA; DPIA for scoring), PCI-DSS via hosted checkout, KYB for merchants/partners with payouts, AML screening on payout counterparties, cookie consent gating trackers (already implemented), audit-log retention 7 years for financial records.
- **Disclosure honesty (product-level compliance):** decision-support disclaimers on every generated document (already in the asset renderer); no guaranteed-outcome claims; breakthrough language restricted to "underbuilt / rarely executed / not yet mainstream" — never "never created before".

---

## 14. Admin Super Control Centre

Extends the shipped Super Admin OS (`admin.html`) into the production control plane:

- **Command Overview:** operators, revenue (ledger-derived), AI cost by "Reasoning Core" (provider names abstracted), operational margin, SEO pipeline, semantic clusters, system health (SLO burn-down), live incident banner.
- **Platform Ops:** support case queue (SLA timers), blog/SEO pipeline, user directory with wallet drill-down and reasoned grant/deduct, partner approvals + commission jobs, full ledger with filters and export.
- **Payments desk:** provider reconciliation status, refunds, disputes with evidence workflow, settlement calendar.
- **Agent governance:** agent registry with on/off switches, permission matrix, prompt version history, per-agent cost and error telemetry, escalation queue (every mandatory-human item lands here).
- **Model routing:** live failover state (claude/gemini/openai), per-route cost & latency, manual override with expiry.
- **Release control:** deploy history, canary status, one-click rollback, feature-flag console.
- **Risk & fraud:** flagged accounts, hold queue, device-cluster graphs, welcome-abuse dashboard.
- **OS Governance:** margin trend, unit economics per action, adoption velocity, pricing experiment results.

Everything an admin does writes to `platform_events` with actor attribution — the admin console has no unledgered powers.

---

## 15. Developer Build Roadmap

| Phase | Scope | Milestones | Commercial objective |
|---|---|---|---|
| **P0 — Foundation (wks 1–6)** | Identity + wallet-service (port `nf-wallet.js` semantics to Postgres), payments door (BitriPay + Stripe webhooks, idempotent settlement), gateway hardening (reserve/settle hooks), `scoring-engine` package w/ full test suite | Money-safe core: no unledgered ACU movement possible | Enable real revenue |
| **P1 — MVP (wks 6–12)** | discovery-service + search API, unlock → project → Build Hub assets (validation, forecast, P&L, risk, plan, deck), asset renderer server-side, Command Center on live data, support bot + cases | Feature parity with prototype, all server-backed; PWA install | First paying operators; validate 125/150/500 price points |
| **P2 — Beta (wks 12–20)** | Partner portal + commissions, developer keys + public API + webhooks, notification engine, fraud agent v1, memory layer + next-best-action, Breakthrough mode + fallback live, currency parity engine | 99.9% SLO, load test 100× current, pen test remediated | Partner-driven acquisition; API early adopters |
| **P3 — Commercial launch (wks 20–28)** | Subscriptions, Investor Mode everywhere, scenario builder + full investor package, SEO War Room autonomous pipeline, Government Mode v1 (aggregated heatmaps), mobile wrapper | Public launch; conversion funnel instrumented end-to-end | £10+ ARPU/mo; partner GMV; first enterprise pilots |
| **P4 — Enterprise (mo 7–10)** | White-label tenancy, SSO/SAML, wholesale ACU, KYB/AML payout rails, e-signature contracts, data-product exports, BitriPay merchant API door GA | Multi-tenant isolation audit; SOC 2 Type I underway | DFI/accelerator licences; gateway revenue share |
| **P5 — Global scale (mo 10+)** | Multi-region active/passive, WhatsApp/USSD channels, local mobile-money coverage, SLM edge models for low-cost preprocessing, reinforcement loops on acceptance/rejection data | Region failover drill passed; unit cost per 1k ACU down 40% | Frontier-market volume; category leadership |

Exit criteria at every phase: clean CI, error budget respected, ledger reconciliation zero-diff for 14 consecutive days, and a production-readiness review sign-off (runbooks, alerts, rollback tested).

---

## 16. Competitive Advantage (why this wins and keeps winning)

1. **Trust moat:** deterministic scoring + internally consistent financials + honest fallbacks. Competitors selling vibes can't retrofit determinism.
2. **Economic moat:** prepaid value-priced ACUs with an enforced 3× margin floor make every marginal user profitable; there is no negative-margin free tier to subsidise.
3. **Data moat:** every search, rejection, unlock, and outcome feeds country/sector intelligence memory — recommendation quality compounds with volume, and the aggregated exhaust becomes a sellable data product no idea-generator has.
4. **Distribution moat:** partner commissions + white-label + the BitriPay API door turn accelerators, DFIs, and payment merchants into channels rather than competitors.
5. **Provider independence:** the gateway abstraction means model-price wars *improve* margin instead of forcing repricing; users buy ACUs, never tokens.
6. **Frontier-market head start:** currency parity, mobile money, USSD/WhatsApp entry, and informal-economy taxonomy address markets the US-centric incumbents structurally ignore.
7. **Operational leverage:** the agent workforce (support at 1 ACU/message, autonomous SEO, self-healing SRE runbooks) keeps headcount flat as volume scales — the same pattern that lets Cloudflare/Stripe run infrastructure margins.

---

## 17. Document Governance

- This file is the architecture source of truth; changes ship by PR with an ADR (Architecture Decision Record) appended under `docs/adr/`.
- Section owners: §5/§9 CTO-line, §7/§12 CFO-line, §13 CISO-line, §15 delivery lead.
- **Secrets policy (non-negotiable):** no API keys, service-account files, or webhook secrets in this repo — ever. All credentials live in the vault; any key that appears in a chat transcript or document is treated as compromised and rotated immediately.
