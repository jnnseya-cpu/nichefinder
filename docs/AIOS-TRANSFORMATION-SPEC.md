# NICHE FINDER
## AI Infrastructure Operating System

─────────────────────────────────────

**Production-Grade AI-OS Transformation Specification**

Venture Intelligence  |  Multi-Agent Orchestration  |  Commercial Architecture
BitriPay Integration  |  Enterprise Security  |  Global Scale Infrastructure

**CONFIDENTIAL — INVESTOR & DEVELOPER GRADE DOCUMENT**

| Document control | |
|---|---|
| Version | 1.1 |
| Date | 13 July 2026 |
| Classification | Confidential — internal, investor & contracted-developer distribution only |
| Owner | Super Admin (S-ADMIN) |
| Companion document | `docs/AI-OS-ARCHITECTURE.md` (17-section platform architecture, system of record for schema & API detail) |
| Brand system | NicheFinder mark — gold `#E8A61A` / bright gold `#FFC53D` / royal blue `#3D85E0` on ink `#070B14` |

---

# SECTION 01 — EXECUTIVE PRODUCT VISION

## 1. Executive Product Vision

### 1.1 Platform Identity

Niche Finder is not a search engine, idea generator, or market research tool. It is a fully autonomous, multi-agent AI Infrastructure Operating System engineered to compress the entire venture creation lifecycle — from raw market signal to investor-ready execution package — into a single, self-learning, continuously improving intelligence platform.

The platform sits at the intersection of three historically disconnected disciplines: venture intelligence, financial engineering, and generative document production. By unifying these inside a single agentic OS, Niche Finder eliminates the three most expensive bottlenecks in early-stage venture building: time, capital, and access to expert knowledge.

### 1.2 The Problem at Global Scale

| Problem Category | Market Reality | Cost to Founders |
|---|---|---|
| Market Selection Failure | 42% of startups fail due to no market need (CBInsights) | Avg. $150K wasted per failed venture |
| Research Cost | Professional market research costs $15K–$50K per study | Inaccessible to 90% of founders |
| Financial Modeling | CFO-grade models require 2–6 weeks to produce | 6-week delay to investor conversations |
| Document Production | Pitch deck + business plan = $8K–$25K from consultants | Blocks pre-revenue fundraising |
| Execution Gap | No tool connects validation to step-by-step build roadmap | Ideas remain ideas indefinitely |

### 1.3 Platform Thesis

Niche Finder is built on a single, commercially validated thesis: the fastest path to a fundable venture is not better ideation — it is better intelligence infrastructure. The platform deploys a multi-agent AI workforce, a proprietary venture scoring engine, an automated financial modeling system, and a generative document production pipeline to deliver what previously required a team of consultants, analysts, and financial advisors — in under five minutes.

### 1.4 Why This OS Can Dominate

| Competitive Dimension | Niche Finder Advantage |
|---|---|
| Speed | Sub-5-minute path from search to investor-grade output |
| Depth | Neural scoring model across 40+ venture viability dimensions |
| Automation | Full document pipeline — no human production required |
| Memory | Venture Memory Layer learns user preferences across sessions |
| Monetisation | ACU credit model creates recurring, metered, scalable revenue |
| Scalability | Multi-agent architecture scales horizontally without quality degradation |
| Ecosystem | API-open architecture enables white-label and enterprise licensing |
| Geography | Country + industry + budget constraints enable hyper-local opportunity discovery |

### 1.5 Platform Positioning Statement

> "Niche Finder is the world's first AI Infrastructure Operating System for venture creation — autonomously discovering, validating, modelling, and packaging fundable business opportunities for founders, incubators, and investors at unprecedented speed and commercial depth."

---

# SECTION 02 — MARKET GAP DEEP REVIEW

## 2. Market Gap Analysis

### 2.1 Competitive Landscape Forensics

| Competitor | What They Do Well | Critical Gaps | Niche Finder Advantage |
|---|---|---|---|
| Exploding Topics | Trend signal detection | No financial modelling, no validation, no document output | Full pipeline from signal to investor package |
| CB Insights | Deep enterprise market intelligence | Cost ($15K+/yr), not founder-accessible, no automation | ACU model makes intelligence accessible at any budget |
| Gartner / Forrester | Premium research reports | Static, slow, expensive, not actionable | Real-time, dynamic, executable outputs |
| Crunchbase | Competitor & funding data | No opportunity discovery, no financial models | Discovery + validation + modelling in one OS |
| Bplan.com / Bizplan | Business plan builders | Template-only, no intelligence, no market validation | AI-generated, market-validated, data-backed plans |
| Slidebean | Pitch deck generation | No market data integration, no financial modelling | Pitch decks grounded in validated market intelligence |
| Lean Canvas tools | Hypothesis documentation | No scoring, no data, no financial output | Scored, validated, financially modelled opportunities |

### 2.2 Market Gap Identification

**Gap 01: No Platform Connects Discovery to Execution**
Every existing tool operates in isolation — trend tools find signals, research tools validate, financial tools model, document tools produce. No platform provides a continuous, automated pipeline from signal discovery through to investor-ready execution package. Niche Finder closes this gap entirely.

**Gap 02: Financial Modelling Inaccessible to Early-Stage Founders**
CFO-grade 3-year financial forecasting requires specialist knowledge and significant time investment. No consumer-grade platform produces dynamic, assumption-driven financial models automatically. Niche Finder's Automated Financial Modelling Agent closes this gap at zero marginal cost per model.

**Gap 03: Venture Intelligence Has No Memory Layer**
Existing platforms treat every session as a fresh interaction. They cannot learn user preferences, sector biases, risk tolerance, or geographic focus over time. Niche Finder's Venture Memory Layer — backed by a vector database — creates a continuously improving, personalised intelligence engine for each user.

**Gap 04: No ACU-Based Metered Model in Venture Intelligence**
Existing platforms use flat subscription models that charge users regardless of usage. The ACU model allows Niche Finder to align revenue precisely with value delivery, enabling lower entry barriers, higher conversion rates, and superior lifetime value engineering through targeted upsell at moment of value realisation.

**Gap 05: No Agentic Architecture in Venture Platforms**
No competitor deploys a true multi-agent AI workforce where specialised agents handle discovery, scoring, financial modelling, document generation, compliance, and risk independently. This single architectural decision gives Niche Finder a quality ceiling and scalability floor that static LLM-prompt platforms cannot match.

---

# SECTION 03 — TRANSFORMATION PILLARS (ENGINEERING ANNEX)

*The sections below are the engineering-grade transformation annex: audited current state, invariant laws already enforced in code, and the gap-closing work per pillar. They are superseded section-by-section as further master-document sections are ratified.*

## 3. Current-state audit (prototype inventory)

| Layer | Today | Production-ready? |
|---|---|---|
| Front end | 15 static pages, shared design system, `nf-polish.css` product layer, new logo/brand palette platform-wide | Yes — carries forward |
| Wallet & ledger | `nf-wallet.js` (client) + gateway file-store wallet (`/v1/wallet*`) with idempotency, welcome grant, 402 enforcement | P0: migrate store to Postgres |
| Pricing law | Capital-bracket engine in both client (`NF.bracket/costFor`) and gateway (`bracketFactor/meterAcu`), 12 passing smoke tests | Yes — port tests to CI |
| AI gateway | `gateway/` Node ESM, provider failover, `/v1/generate`, `/v1/estimate`, `/v1/health`, `/v1/models` | P0: deploy + auth + rate limits |
| Scoring | Deterministic PRS/CS/PSS + BPS breakthrough rank, enforced in prompts and client rendering | Yes — move to server-side scoring service in P1 |
| Admin | Super Admin OS (command overview, platform ops, SEO war room, governance) on localStorage | P1: bind to real APIs |
| Government Mode | Venture Demand Observatory with k-anonymity posture, per-country datasets | P2: real aggregation pipeline |
| Payments | ACU packages defined; BitriPay contract specified (§7 of architecture doc) | P1: live integration |
| Identity | Per-browser `NF_WALLET_USER` id | P0/P1: real auth |
| State | localStorage keys (`nf_wallet`, `nf_ledger`, `nf_state_*`, `nf_reports`, …) | Progressive server migration P0→P2 |

## 4. Pillar I — Venture Intelligence

### 4.1 The deterministic scoring core (invariant)

Every opportunity carries a score out of 10 computed as a pure function:

```
Overall = PRS × 0.35 + CS × 0.30 + PSS × 0.35
```

- **PRS — Market Readiness (35%)**: is demand real and current in the user's country?
- **CS — Competitive Gap (30%)**: is there room to win?
- **PSS — Prospect of Success (35%)**: can this user execute it, here, now, within the capital class?

Bands: **green 8–10**, **amber 5–7**, **red 0–4**. Decision mapping: **STRONG GO ≥ 7.5**, **CONDITIONAL GO 6.0–7.4**, **NO GO < 6.0**.

### 4.2 Breakthrough Discovery (invariant)

Optional fourth pillar **BPS (Breakthrough Potential)** with ranking:

```
BreakthroughRank = PSS × 0.25 + BPS × 0.30 + MSP × 0.10 + PPP × 0.30 + PRS × 0.05
```

An opportunity is labelled a breakthrough only when **both BPS ≥ 7.5 and PSS ≥ 7.5**. When no candidate qualifies, the OS must return exactly:

> "No credible breakthrough opportunity was found for this search. We are showing the strongest realistic opportunities based on your country and selected filters."

### 4.3 Grounding rules

- **Country is mandatory.** Every discovery, score, and document is grounded in the user's market.
- **Capital class ceiling.** ≤ £10,000 / $10,000 / €10,000. Currency parity: GBP and EUR zones use the flat 10k figure (no FX conversion); dollarized economies (DR Congo, Ecuador, El Salvador, Panama, Zimbabwe, Timor-Leste) use US$10,000; all other markets use the local-currency equivalent of US$10,000.
- **AI narrates, the engine decides.** Models produce evidence and prose; scores, bands, decisions, and prices are computed deterministically and rendered from the engine's output, never parsed back out of model text.

### 4.4 Production target

Move scoring from prompt-enforced convention to a server-side **Scoring Service**: the gateway returns raw pillar evidence, the service computes scores/bands/decision, persists them to the opportunities table, and signs the result so documents downstream can prove score integrity. The **Venture Memory Layer** (vector database) personalises discovery across sessions — sector bias, risk tolerance, geographic focus — without ever influencing the deterministic score arithmetic.

## 5. Pillar II — Multi-Agent Orchestration

### 5.1 Gateway (exists)

The AI gateway is the single door to model providers:

- Failover chain **claude → gemini → openai**; a provider failure degrades, never breaks, the request.
- `/v1/generate` accepts `capitalGBP` and `investorMode`, returns `{ text, provider, usage, acu, bracketFactor }`.
- `/v1/estimate` prices a request before commit; `/v1/health` and `/v1/models` expose operational state.
- Metering: `meterAcu(provider, usage, investorMode, capitalGBP)` converts provider token cost into ACU, applies the capital-bracket factor, then the ×1.4 Investor Mode uplift.

### 5.2 Agent workforce (target)

The platform workforce runs as orchestrated roles above the gateway, each with a budget, a queue, and an audit trail:

| Agent | Duty | Trigger |
|---|---|---|
| Discovery Agent | Country-grounded niche sweeps | User search |
| Validation Agent | Market validation dossiers | Build Hub |
| Financial Agent | Forecasts, P&L, Excel models | Build Hub |
| Document Agent | Business plans, pitch decks, memos | Build Hub |
| Content Agent | SEO pipeline articles | Admin / SEO War Room |
| Support Concierge | First-line answers, 1 ACU/message, 2-strike escalation to human cases | Support widget |
| Governance Agent | Anomaly, margin, and adoption insights for S-ADMIN | Scheduled |

Orchestration requirements: every agent run is a **job** (id, user, action key, ACU quote, bracket factor, provider trace, outcome) written to the ledger; retries are idempotent; long jobs stream progress; no agent can spend without a pre-authorised ACU hold.

## 6. Pillar III — Commercial Architecture

### 6.1 The ACU economy (invariant)

- **£1 = 100 ACU.** New accounts receive **100 free welcome ACUs** — read-only, never spendable on generation.
- Packages: **£5 → 500**, **£10 → 1,100**, **£20 → 2,400**, **£50 → 6,500** ACU.
- Canonical action prices (bracket 1): search 125 · unlock 150 · PDF export 100 · validation 250 · forecast 250 · P&L 220 · risk map 250 · Excel model 350 · cashflow+P&L bundle 400 · financial bundle 500 · scenario 300 · scenario bundle 700 · benchmark 250 · confidence report 200 · business plan 500 (+150 PDF) · pitch 500/650/850 · PPT export 200 · investor memo 350 · execution roadmap 300 · market entry 350 · full investor package 1,500 · support message 1.
- **Investor Mode**: ×1.4 on all action prices, stacked after the bracket factor.

### 6.2 The capital-bracket margin law (invariant)

Prices are anchored to real AI-provider cost, not arbitrary numbers:

- **≤ £10,000 (bracket 1):** every charge sits **3–10× provider cost**.
- **Each further £10k bracket doubles the band and every price**: £10,001–£20k → 6–20× (×2), £20,001–£30k → 12–40× (×4), and so on.
- Engine: `tier = min(ceil(capital/10000), 11)`, `factor = 2^(tier−1)`, capped at ×1024. Enforced identically in the client (`NF.bracket`, `NF.costFor`) and the gateway (`bracketFactor`, `meterAcu`); unlocked projects carry their bracket factor into the Build Hub.
- The Search Canvas shows the live bracket and band as the capital slider moves; no price ever changes after commit.

### 6.3 Production target

- Wallet as system of record in Postgres (P0 store exists on the gateway; migrate file → DB, keep the idempotency-key contract and `402 insufficient_acu` semantics).
- Revenue recognition: ledger entries tagged by action key, bracket, provider cost, and margin — feeding the Super Admin margin dashboard that already renders from the ledger today.
- Refund/credit policy executed only through admin-audited `credit` operations.

## 7. Pillar IV — BitriPay Integration

BitriPay is the payment door for ACU top-ups and, later, merchant services (architecture doc §7 holds the full contract; summarised here as the transformation surface):

1. **Checkout**: package selection → BitriPay hosted session → webhook `payment.settled` → idempotent wallet `credit` with the package's ACU amount (bonus included) → ledger entry → receipt.
2. **Webhook contract**: HMAC-signed, replay-protected (event id + timestamp window), processed exactly once via the same idempotency-key mechanism the wallet already enforces.
3. **Settlement & commissions**: partner referral commissions computed on settled revenue only; payouts batched and approved in the Super Admin Partners tab.
4. **Failure posture**: a failed or reversed payment never leaves ACU spendable — credit is applied only on settlement, reversed by a compensating debit on chargeback.
5. **Compliance**: BitriPay carries card-data scope (SAQ-A posture for Niche Finder); Niche Finder stores no PANs, ever.

## 8. Pillar V — Enterprise Security & Compliance

- **Secrets law (standing)**: provider keys live only in deployment environment variables; no key appears in the repository, client bundles, or documents. Any credential that appears in a chat transcript or shared document is treated as compromised and rotated immediately.
- **Identity**: P0 per-browser ids give way to real authentication (email + OAuth), with wallet ownership migrated by verified claim.
- **Wallet integrity**: server-authoritative balances, idempotent mutations, atomic persistence, capped ledgers; the client mirror is a cache, never the truth.
- **Privacy**: 30-day category consent (necessary / analytics / marketing) gates every non-essential tag; Government Mode publishes only k-anonymised aggregates — no personal data, no small-cell disclosure.
- **Data residency & GDPR**: user data in-region where required; export and erasure served from the system of record.
- **Auditability**: every ACU movement, admin action (grants, deductions, partner approvals, content publishing), and agent job is a ledger event with actor, timestamp, and reason.
- **Abuse controls**: gateway rate limits per user and per IP; ACU pre-authorisation holds prevent negative balances under concurrency.

## 9. Pillar VI — Global Scale Infrastructure

- **Topology**: static front end on CDN; gateway as a stateless service behind a load balancer; Postgres (system of record) + object storage for generated documents; queue for agent jobs; vector database for the Venture Memory Layer.
- **The single deployment switch already exists**: `nf-config.js` (`NF_GATEWAY_URL`) flips every page from offline demo to live service without code changes — this remains the contract.
- **Progressive Web App**: installable shell (manifest + service worker) ships today; the worker never caches `/v1/*`, so metering and wallets are always live.
- **Observability**: request tracing across gateway → provider → wallet; provider cost and failover rates on the Super Admin "Model Spend" panel; SLOs — 99.9% gateway availability, p95 discovery < 60s, wallet mutation p95 < 150ms.
- **Scale economics**: the bracket law makes margin structural — as provider prices fall, the 3–10× band holds; as users move up capital brackets, revenue doubles per bracket with near-flat cost. API-open architecture enables white-label and enterprise licensing on the same metered core.

## 10. Operating surfaces (governed cockpits)

| Surface | Role | State |
|---|---|---|
| Search Canvas | Discovery + live bracket pricing | Live |
| Deep-Dive / Build Hub | Per-venture execution engines, Investor Mode | Live |
| Command Center (user) | Wallet, projects, history, top-ups | Live |
| Super Admin OS | Revenue/margin, platform ops (support, blog, users, partners, ledger), SEO War Room, governance | Live (localStorage) → P1 API-bound |
| Government Mode | Aggregated venture-demand observatory for governments & DFIs | Live (demo datasets) → P2 pipeline |
| Support Concierge | 1 ACU/message concierge with human escalation | Live |

## 11. Transformation roadmap

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **P0 — Foundations** (now) | Deploy gateway with fresh keys; wallet store file → Postgres; real auth; CI running the smoke suite | A paid top-up on a deployed URL funds a real search end-to-end; zero secrets in repo; all bracket tests green in CI |
| **P1 — Commercial spine** | BitriPay live (checkout, webhooks, settlement); Super Admin bound to real APIs; server-side Scoring Service; document storage | First £ of settled revenue visible in admin margin panel with correct bracket attribution |
| **P2 — Intelligence at scale** | Agent job queue + orchestration; Venture Memory Layer (vector DB); Government Mode aggregation pipeline (k-anonymised); partner/commission engine | 1,000 concurrent discovery jobs without SLO breach; a government dashboard rendered from real aggregates |
| **P3 — Global** | Multi-region, data residency, enterprise SSO, connector ecosystem, white-label/enterprise licensing, mobile wrap of the PWA | Region failover drill passes; enterprise pilot signed |

## 12. KPIs & risk register (summary)

**KPIs**: gross margin per action (target within band per bracket) · paid-conversion from welcome ACUs · discovery→unlock rate · unlock→document rate · provider failover rate · support escalation rate · partner-sourced revenue share.

**Top risks**: provider price/availability shocks (mitigated by failover + bracket law) · payment fraud/chargebacks (settlement-only crediting) · scoring credibility (deterministic core + signed scores) · key leakage (secrets law + rotation drill) · regulatory variance across markets (residency plan, Government Mode k-anonymity).

## 13. Canonical constants (normative appendix)

Scoring weights, bands, and the breakthrough formula (§4); ACU economy, action prices, packages, and the bracket law (§6); parity rule (§4.3); the exact breakthrough fallback sentence (§4.2). Any change to these constants is a governance decision recorded by S-ADMIN and versioned in this document and `docs/AI-OS-ARCHITECTURE.md` together — code, copy, and contract must never disagree.

*© 2026 Niche Finder Ltd. Confidential. Prepared for investor and contracted-developer use only.*
