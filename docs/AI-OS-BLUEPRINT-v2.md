# Niche Finder AI-OS — Master Blueprint v2.0

**Current-State Reconciliation & Expansion**
**Status: build-ready · grounded in the live codebase at commit `ef8248b` (2026-10-25)**

> **How to read this document.** It does **not** replace `docs/AI-OS-ARCHITECTURE.md`
> (the v1.0 target architecture) or `docs/AIOS-TRANSFORMATION-SPEC.md` (the deep
> module/agent spec). Those remain the design source of truth and nothing in them
> is removed. This v2.0 adds the one thing they lack and the one thing a senior
> engineering org needs before it writes a line of code: **an honest map of where
> the starting line actually is** — what is shipped and running today, what is
> partially there, and what is still a design on paper — plus the expanded
> framing this brief asks for (multi-agent ecosystem, self-managing layer, AI data
> intelligence, cybersecurity command centre, commercial dominance, BitriPay).
>
> **Prime rule honoured:** nothing is removed; everything is preserved, upgraded
> and made executable against reality. **No false readiness, no "unhackable"
> claims, no feature described as shipped unless it is in the code and tested.**

---

## 0. The reconciliation — blueprint vs. what is actually running

The v1.0 blueprint describes a multi-service, Postgres/Redis/R2/vector-DB platform
with an autonomous C-suite of agents. That is the correct **target**. The **actual
platform today** is a lean, genuinely-working system with a very different shape,
and the gap between the two is the real backlog. Everything below is verified
against the running code (34 passing test suites; a live launch audit under
`launch-audit/`).

| Subsystem | v1.0 blueprint target | **Shipped & running today (verified)** | Gap to target |
|---|---|---|---|
| **Runtime** | Independently deployable services behind a BFF | **One zero-dependency Node ESM gateway** (`backend/gateway/src/`), 3 runtime deps (Anthropic/Google/OpenAI SDKs), serving a static vanilla-JS PWA. Single process, systemd + Caddy on one Hostinger VPS, **Node 22 LTS** | Service split is deferred until load demands it (correct call — do not pre-split) |
| **Data store** | Postgres (system of record) + Redis + R2 + Vector DB + Warehouse | **Encrypted file stores** (`data/*.json`, AES-256-GCM) with an **optional `node:sqlite` backend** + migration path (`docs/DB-MIGRATION.md`). No Redis, R2, vector DB or warehouse yet | Postgres cutover is the first infra milestone; the rest are threshold-gated (see §6) |
| **Wallet / ACU economy** | Postgres ledger, reserve→settle, append-only | **Fully implemented in code**: dual-balance wallet, reserve→`settleHold`→release (TOCTOU-safe), append-only ledger, 12 money-leak invariants tested (refund/chargeback claw-back, idempotent webhooks, concurrency, zero ledger-diff) | Port the store to SQL; logic is already correct and test-locked |
| **Scoring** | Deterministic PRS/CS/PSS engine (pure function) | **Partially real, honestly:** the *free homepage score* is a pure deterministic function; the *paid search* scores are produced by the model against a **fixed published rubric** + World Bank grounding — calibrated and transparent, not bit-reproducible | Build a server-side pure re-derivation if strict determinism on the paid path is wanted (tracked as D-02) |
| **AI layer** | Multi-agent orchestrator, agent registry, memory tiers | **One provider gateway** (`claude-opus-4-8` primary → gemini → openai failover) with adaptive thinking, self-healing param degradation, and a **"never charge for unusable output" guard**. "Agents" today = role-specialised prompts, not autonomous processes | A real agent registry + memory layer is Phase 2+ (see §2) |
| **Payments** | BitriPay (first-class) + Stripe + Adyen/PayPal | **Stripe (cards) + KODA (mobile money)** live, HMAC-verified, idempotent, reconciliation-safe. **BitriPay not yet integrated** | BitriPay is now a *small* job — it drops into the connector + secret-store foundation shipped this cycle (§5, §10) |
| **Connector credentials** | Vault + connector registry | **Shipped this cycle:** an **encrypted admin-managed API-key store** (`secrets.js`, AES-256-GCM, env-override-first, never returned to client) with an **Admin → API Keys** UI for Anthropic/Gemini/OpenAI, Stripe, KODA, SMTP, GSC, Meta | This *is* the connector-registry seed; new connectors add a row + a handler |
| **Admin control plane** | Super Admin OS (full governance) | **Real `admin-console.html`** with session-bearer auth and tabs: **Users, Revenue, Leads, Content & SEO, Growth (referrals), Comms, API Keys, Security & System** — all wired to live endpoints | Agent-governance + model-routing + release-control panels are proposed |
| **Security** | Zero-trust, MFA, WAF, SOC | **Shipped:** scrypt+sessions, AES-256-GCM at rest, constant-time admin gate, IDOR/session-binding, **proof-of-work human gate** (signup/login/forgot), **denial-of-wallet circuit breaker**, per-IP rate limiting, webhook HMAC + stale-timestamp, security headers, prepared SQL, path-traversal guards, demo-data prod guard | MFA/WebAuthn, WAF/Turnstile, SSO/SAML, a real SOC are proposed (§7) |
| **Self-managing ops** | Full SRE agent tier | **Shipped:** uptime watchdog (`nf-monitor`), 2-gate **auto-deploy with auto-rollback**, encrypted off-site **backups + a tested restore drill**, 34 CI suites, a GO/NO-GO **preflight** | Autonomous bug-triage/auto-repair agents are proposed (§4) |
| **Compliance** | GDPR DSRs, KYC/KYB, AML, PCI SAQ-A, SOC 2 | **Shipped:** GDPR erasure (ledger-preserving) tested, cookie-consent gating, k-anonymised Government Mode, legal entity correct (JNN GLOBAL LTD, 15405437). **No KYB/AML/MFA/SOC2 yet** | Required before merchant payouts / enterprise (§7, §11) |
| **Production readiness** | — | **Honest verdict: NO-GO for public launch until live-validated** (no prod/staging/live-key access from the build environment). Every layer testable without that access passes. Full report in `launch-audit/FINAL-REPORT.md` | Deploy + live-key + load/DR drills are the gates (§11) |

**The one-line truth:** the *commercial and economic core is real and test-locked*;
the *enterprise infrastructure and agent autonomy are a disciplined, phased
roadmap*, not a weekend's work, and must not be sold as already built.

---

## 1. Executive product vision (unchanged, reaffirmed)

Niche Finder AI-OS is **the operating system a founder runs a venture on — from
first market signal to investor-ready pack** — grounded in the user's real country
and capped at the £10k build class. One scoring rubric, one prepaid ACU wallet, one
provider-agnostic AI layer, one auditable ledger. Positioning: *"the Bloomberg
Terminal for the £10k founder."* (v1.0 §1 stands in full; the economics below are
the live, enforced numbers.)

**Why it can dominate — grounded, not aspirational:**
1. **Hard constraints are the product** (country mandatory, capital capped) — live in the Search Canvas.
2. **A transparent rubric + honest NO-GO** — live; the system genuinely returns NO GO.
3. **Internally consistent outputs** — the deck, plan and Excel model draw from one evidence base (deep-dive workspace).
4. **A real prepaid economy with an enforced margin floor** (≥ ~3× fully-loaded cost) — live and test-locked.
5. **Provider independence** — claude→gemini→openai failover; users buy ACU, never tokens — live.
6. **You are never charged for a failed analysis** — the output-guard is live and test-covered (a genuine trust differentiator most AI tools lack).

---

## 2. Multi-agent ecosystem — honest model + roadmap

The brief asks for a full workforce of autonomous agents (CEO/CFO/CTO agents, etc.).
Here is the **honest** engineering position, because mislabelling prompts as
autonomous agents is exactly the "fake functionality" trap to avoid.

**Today (real):** there is **one orchestrated reasoning layer** — the Claude
provider behind the gateway — invoked with **role-specialised system prompts** for
each job (discovery, document studio, support concierge, etc.). This is a
*single-agent, many-roles* system. It is honest to call these "AI functions" or
"role prompts," **not** autonomous agents, because they do not run unattended,
hold no tools of their own, and take no irreversible action.

**Target (proven pattern, phased):** a real **agent registry** behind the
orchestrator, each agent a typed spec (the `AgentSpec` interface already defined in
v1.0 §5) with explicit inputs, outputs, RBAC scopes, triggers, escalation, and
provider policy. The non-negotiable safety law (from v1.0 §5, reaffirmed):

> **No agent has a side door.** Agents act through the same ACU-gated, ledgered,
> permission-checked APIs as humans. High-impact actions (price changes, wallet
> mutations above a limit, releases, policy edits, anything irreversible or
> outbound) require **human approval**. An agent can never modify its own
> permissions.

**Sequencing (what to actually build, in order):**
- **Phase A — Agent registry + memory (no new autonomy):** formalise today's role prompts as registry entries; add the four-tier memory layer (User/Workspace/Process/Intelligence) as a projection over the event ledger. Pure refactor + persistence; zero new risk.
- **Phase B — Read-only analytical agents:** Analyst, Research, Predictive Growth — they *recommend*, never execute. Everything they produce lands in a human queue.
- **Phase C — Approval-gated executors:** Automation, Pricing, Marketing/SEO publish, Fraud holds — each action proposed, human-approved, then executed through the normal ledgered APIs.
- **Phase D — Self-managing SRE agents:** only ones that execute *pre-approved runbooks* (restart, cache flush, provider re-route, rollback), never novel mutations (§4).

The "executive C-suite" framing (CEO/COO/CFO agents) is best treated as **named
dashboards over the analytical agents**, not literal autonomous executives —
honest, useful, and it avoids implying the platform makes unsupervised strategic
decisions it must not make.

---

## 3. AI Command Centres — mapped to the real UI

v1.0 §4 defines the per-user-type Command Centres. The **shipped reality** to build
on:
- **Operator Command Center** = `dashboard.html` (wallet, saved niches, assets, engine runs, predictive next-action, referral link). Live.
- **Super Admin Command Centre** = `admin-console.html`, now with **8 live tabs** (Users, Revenue, Leads, Content & SEO, Growth, Comms, **API Keys**, Security & System). Live, session-bearer gated.
- **Partner / Developer / Government Command Centres** = defined in v1.0, **not yet built as dedicated surfaces** (referral data is live in the admin Growth tab; a partner-facing portal is Phase 2).

Every agent/AI output continues to follow the mandatory **8-point contract**
(Situation · Insight · Risk · Recommendation · Next Action · Owner · Deadline ·
Confidence) — already the shape used in the deep-dive operational brief.

---

## 4. Self-managing platform layer — what's real vs. proposed

| Capability | Status | Evidence / plan |
|---|---|---|
| **System health / uptime watchdog** | **Shipped** | `scripts/nf-monitor.*` — detects outage, alerts, de-dups, recovers; tested in the `drill` suite |
| **Auto-deploy + rollback** | **Shipped** | 2-gate deploy (`vps-autodeploy.sh`, `nf-deploy.timer`), auto-rollback on gate failure |
| **Backups + restore** | **Shipped** | encrypted off-site backups (`nf-backup.*`) + a **tested restore drill** |
| **Release management** | **Partial** | git-poll auto-deploy with test gate; no canary/progressive rollout yet |
| **Bug detection agent** | **Proposed** | wire error telemetry (Sentry-class) → error-cluster triage; start read-only |
| **Auto-repair agent** | **Proposed** | execute *pre-approved runbooks only*; anything novel pages a human |
| **Infra-cost optimisation** | **Proposed** | meaningful only post-Postgres/multi-service; threshold-gated |
| **AI governance agent** | **Partial** | prompt/version discipline exists in code; a governance *panel* is proposed |

**Rule (reaffirmed):** self-healing executes only pre-approved runbooks and files
an incident record; it never invents a mutation.

---

## 5. BitriPay integration — now a small, well-scoped job

v1.0 §7 fully specifies the BitriPay API door (merchant portal, keys, sandbox/live,
webhooks, QR/links/wallet/mobile-money, settlement, refunds, disputes, commission
split). It is **not yet built**, but two things shipped this cycle make it a
**contained task rather than a project**:

1. **The settlement engine already exists and is provider-shaped.** Stripe and KODA
   both flow through one idempotent, HMAC-verified, reconciliation-safe webhook +
   crediting path. BitriPay is a **third provider on the same handler shape** —
   `verify signature → idempotency check → load package from metadata → credit
   wallet in one transaction with a ledger row`.
2. **Credentials now have a home.** The encrypted **API-key store** (`secrets.js`)
   and the **Admin → API Keys** UI already manage provider secrets with env-override
   and masking. BitriPay keys (`bp_test_…` / `bp_live_…`) add as managed-key rows —
   no new secret-handling code.

**Build order for BitriPay:** (a) add `koda.js`-style `bitripay.js` with
`createIntent/handleWebhook/configured`; (b) register `BITRIPAY_SECRET_KEY` +
`BITRIPAY_WEBHOOK_SECRET` in `secrets.js` MANAGED; (c) add the checkout + webhook
routes mirroring the Stripe/KODA pair; (d) the merchant-facing **outbound** API door
(keys, sandbox, developer centre) is a Phase-4 enterprise surface, built on the
`api_keys` table from v1.0 §10.

---

## 6. Third-party connector ecosystem — grounded in the shipped secret store

v1.0 §8 lists the full connector matrix. The **real, running connectors today**:

| Connector | Status | Where |
|---|---|---|
| **AI providers** (Anthropic primary, Gemini, OpenAI) | **Live** | gateway router, failover |
| **Stripe** (cards) | **Live** | `payments.js` |
| **KODA** (mobile money) | **Live** | `koda.js` |
| **SMTP email** (Hostinger relay) | **Live** | `mailer.js` |
| **World Bank** (keyless market grounding) | **Live** | `marketdata.js` |
| **Google Search Console** | **Live (optional)** | `search-console.js` |
| **Meta Conversions API** | **Live (optional)** | `meta-capi.js` |
| **IndexNow** (Bing/Yandex) | **Live** | `scripts/indexnow-submit.mjs` |
| BitriPay, Adyen, PayPal, BaaS/Open Banking, KYC/KYB, AML, fraud/device intel, CRM, e-sign, support desk | **Proposed** | add as managed-key + handler |

**The connector-registry pattern is now real, not aspirational:** every integration
reads its secret through the env→encrypted-store resolution, and the **Admin → API
Keys** UI is the operator's single pane for credentials. The disciplined next step
is to formalise the uniform connector interface (`init/healthcheck/execute/webhook`,
timeout + retry-with-jitter + circuit breaker + cost/latency telemetry) from v1.0
§8 as a thin wrapper every handler adopts.

---

## 7. Cybersecurity command centre — defence-in-depth, stated honestly

**No "military-grade" or "unhackable" claims** — no responsible architecture
guarantees that. What the platform has and needs:

**Shipped and verified (live-tested in the launch audit):**
- **Identity & access:** scrypt password hashing + constant-time compare, opaque 256-bit sessions (only hashes stored), 30-day TTL with revocation, reset rotates salt + kills sessions.
- **Human-only gate:** proof-of-work challenge on signup/login/forgot (blocks scripted bots).
- **Authorisation:** account-wallet session binding (IDOR closed — verified: reading/spending another account's wallet without its token returns 403), constant-time admin-key gate (closed when unset), every `/v1/admin/*` route gated.
- **Abuse limits:** per-IP rate limiting (429), denial-of-wallet circuit breaker on free previews.
- **Payments:** Stripe/KODA webhook HMAC verification + stale-timestamp rejection (Stripe) + idempotent crediting.
- **Data protection:** TLS (Caddy) in transit; AES-256-GCM at rest for wallets and the new secret store; secrets never shipped to the client; demo-data can never render on the production host.
- **App security:** prepared SQL (no injection), path-traversal guards, security headers (HSTS/nosniff/frame/referrer/CSP/permissions), 2 MB body cap, input validation on public endpoints.

**Proposed (the real roadmap to "enterprise security"):**
- **MFA/WebAuthn + risk-based step-up**; **WAF / Turnstile** in front of auth + checkout; **KODA webhook replay-window** (needs KODA's signing spec); **CSP tightening** (nonce'd script-src) + moving the session to an `HttpOnly` cookie to blunt XSS token theft; **device fingerprinting + velocity fraud scoring**; **KYB/KYC + AML** before any merchant payout; **a real SOC / SIEM** (threat monitoring, anomaly detection) once volume and team justify it; **SOC 2 Type I** for enterprise sales.

The "SOC / threat-hunter / fraud agents" are **named functions over this control
set**, phased in read-only first (alert, don't act) — never an autonomous system
with a side door into money or identity.

---

## 8. AI data intelligence layer — threshold-gated, not premature

The brief asks for a data lake, warehouse, vector DB, knowledge graph, streaming,
and five intelligence engines. Building these before there is data to justify them
is the classic over-engineering failure. The honest, proven sequencing:

| Layer | Build when | Today |
|---|---|---|
| **Event ledger** (append-only `platform_events`) | **Now** (Phase A) — it is the substrate every projection reads | Partially present as per-domain logs; formalise one typed stream |
| **Warehouse** (BigQuery/Snowflake-class) | When analytics queries start competing with the OLTP path | Not needed yet |
| **Vector DB** (memory, semantic clustering) | When the memory layer + recommendation quality needs embeddings at scale | Not needed yet; World Bank grounding covers market anchoring |
| **Knowledge graph** | When cross-venture/sector relationships drive real recommendations | Deferred |
| **Streaming** (Kafka/Pub-Sub) | At multi-service split | Deferred |
| **The five engines** (predictive / behavioural / recommendation / decision / real-time) | Each as a projection over the event ledger, incrementally | The scoring rubric + predictive next-action report are the first, live |

**Decision intelligence already exists in primitive form:** the deterministic
scoring + the dashboard's "next best action" are the seed of the decision engine.
Grow them on the event ledger; do not stand up a Databricks before there is a
reason.

---

## 9. Production-grade architecture — the real bridge

v1.0 §9 is the correct target diagram. The **migration bridge** (the part a build
team needs):

1. **Keep the modular monolith.** The single gateway is the right shape at current
   scale; the service boundaries in v1.0 §9 are *seams to split along later*, not
   services to build now.
2. **First infra milestone: SQL cutover.** Port the wallet/auth/ledger file stores
   to the `node:sqlite` backend already scaffolded (`docs/DB-MIGRATION.md`), then to
   Postgres when concurrency/HA demands it. The wallet logic is already
   SQL-shaped (`SELECT … FOR UPDATE` semantics map directly).
3. **Then: object storage for assets** (R2/S3) — when generated documents need to
   persist beyond the VPS disk.
4. **Then: Redis** — only when rate-limit/lock/idempotency state must survive
   multi-instance (today it is correctly in-process for a single VPS).
5. **Observability before scale:** structured logs + error monitoring + traces with
   a correlation id per request; SLOs (99.9% API, p95 search within provider
   budget, p95 wallet op < 150 ms). This is the cheapest highest-leverage next
   investment and should precede any service split.

---

## 10. Database, API, monetisation, admin — status against v1.0

These four sections in v1.0 (§§10–14) are **accurate target designs** and are
preserved verbatim. Status notes:

- **Database schema (v1.0 §10):** the target Postgres schema is correct. Today the
  same entities live in encrypted JSON / `node:sqlite`. **Action:** adopt the v1.0
  DDL at the SQL cutover; it needs no redesign.
- **API spec (v1.0 §11):** the public `/v1` surface is the target. Today the
  gateway exposes the internal `/v1/*` routes (generate, document, wallet, auth,
  admin, payments, referrals, human, media, articles, **admin/keys**, **admin/restart**);
  the *developer-facing* public API (keys, rate tiers, outbound webhooks) is Phase 2.
- **Monetisation (v1.0 §12):** **this is live and exact.** £1 = 100 ACU; welcome
  100 (preview-only); packages Starter £5/500, Builder £10/1,100, Founder £20/2,400,
  Investor £50/6,500; subscription plans Starter £19/Pro £49/Growth £99/Enterprise;
  the full action price list (search 125, unlock 150, validation 250, forecast 250,
  P&L 220, Excel 350, business plan 500, GTM 750, pitch 500/650/850, full package
  1,500, growth tools 25–120, support 1); Investor Mode ×1.4; the capital-bracket
  doubling law (×2 per £10k, cap ×1024); the Growth Partner referral commission +
  lifetime cap + refund reversal. **All enforced in `shared/nf-economy.js` and
  test-locked.**
- **Admin control (v1.0 §14):** the shipped `admin-console.html` covers Users,
  Revenue, Leads, Content & SEO, Growth, Comms, **API Keys**, Security. Agent
  governance, model-routing and release-control panels are the proposed additions.

---

## 11. Production-readiness & the path to GO (honest)

A full launch audit was executed this cycle (`launch-audit/`). **Verdict: NO-GO for
public launch — because it is not yet live-validated, not because of an open code
defect.** Every layer testable without production access **passed**:
- Backend suite 34/34 green, `npm audit` 0 vulnerabilities, deterministic builds.
- Live API adversarial battery 16/16 (admin gate, IDOR, input validation, webhook sig+idempotency, headers, CORS, path traversal, rate limit).
- Live financial integrity 4/4 (TOCTOU: 12 concurrent charges vs a 3-ACU wallet → exactly 3 succeed; zero ledger-diff).
- Browser critical journey 9/9 on mobile + slow-3G (free score → signup-with-PoW → full search → dashboard).

**The gates to a real GO (operator/live actions, not code):** deploy + a
deploy→smoke→rollback drill on the box; set prod env incl. `REQUIRE_WALLET_SESSION=1`
and `WALLET_STORE_KEY`; upgrade VPS Node to ≥ 22.23.4; a live AI-key quality +
prompt-injection eval; a live Stripe/KODA sandbox payment run; load/soak at peak;
backup-restore + DR drill on real data; accessibility (WCAG 2.2 AA) + real-device
matrix. Full list in `launch-audit/human-actions.md`.

---

## 12. Developer build roadmap — reconciled to what's done

v1.0 §15 phases (P0–P5) stand. **Reconciled status:**

| Phase | v1.0 scope | Reconciled status |
|---|---|---|
| **P0 Foundation** | wallet/payments/gateway/scoring core, money-safe | **Largely DONE in code** (file/SQLite store, not Postgres yet). Money-safe invariants test-locked. Remaining: SQL cutover |
| **P1 MVP** | search→unlock→build hub, command center, support | **DONE in code** on the current stack; needs live-key validation |
| **P2 Beta** | partner portal, public dev API, notifications, fraud v1, memory, breakthrough | **Partial:** referrals + Growth Partner admin live; breakthrough live; notifications (email) live. **Remaining:** partner *portal*, public dev API, fraud scoring, memory layer |
| **P3 Commercial** | subscriptions, investor mode, scenario, SEO autopilot, Gov Mode, mobile | **Partial:** subscription plans + Investor Mode + Government Mode defined/mostly built; SEO content publishing live via admin |
| **P4 Enterprise** | white-label, SSO, wholesale ACU, KYB/AML, e-sign, BitriPay merchant door | **Proposed** |
| **P5 Global** | multi-region, WhatsApp/USSD, mobile money breadth, SLM edge | **Proposed** (KODA mobile money is the first real step, live) |

**Exit criteria (every phase):** clean CI, error budget respected, **ledger
reconciliation zero-diff for 14 consecutive days**, and a production-readiness
review sign-off (runbooks, alerts, rollback tested).

---

## 13. Competitive advantage (reaffirmed, now evidence-backed)

The seven moats in v1.0 §16 hold. Two are now **demonstrable, not promised**:
- **Trust moat** — the *"never charged for a failed analysis"* guarantee is shipped
  and test-covered; the honest NO-GO verdict is real; the scoring rubric is
  published. Competitors selling confident black boxes can't retrofit this.
- **Economic moat** — the enforced margin floor + prepaid ACU model is live and
  test-locked; there is no negative-margin free tier to subsidise.

---

## 14. Document governance

- v1.0 `AI-OS-ARCHITECTURE.md` remains the **target architecture** source of truth;
  `AIOS-TRANSFORMATION-SPEC.md` the **deep module/agent spec**; **this v2.0 is the
  current-state reconciliation and sequencing authority.** On any conflict about
  *what exists today*, v2.0 wins; about *target design*, v1.0 wins.
- Changes ship by PR with an ADR under `docs/adr/`.
- **Secrets policy (non-negotiable):** no API keys, service-account files, or
  webhook secrets in this repo, ever. Runtime secrets live in the env file or the
  encrypted admin key store; any credential that appears in a transcript or
  document is treated as compromised and rotated.
- **Honesty policy (non-negotiable):** nothing is described as shipped unless it is
  in the code and tested; no "unhackable"/"fully compliant"/guaranteed-outcome
  claims; the reconciliation table in §0 is kept current with each release.
