# Trend Intelligence AI — feasibility & fit assessment

**Against:** the Niche Finder codebase (this repo) · **Spec:** Trend Intelligence
AI build spec v2.3 (10 Nov 2026) · **Date:** 2026-11-10

This document answers three of the four things asked ("feasibility & fit",
"pilot Niche Finder as first host") and records what the committed reference
foundation (`trend-intel/`) actually is. It is deliberately honest about the
gap between a working foundation and the spec's full 6–8-week, 2-engineer,
five-gate build. No false readiness.

---

## 1. What the spec is

A **standalone, industry-neutral control layer** that sits in front of
existing SEO/marketing agents. Loop: read demand signals → score opportunity
and confidence → emit a versioned, time-limited **Growth Brief** → existing
agents adapt their work to the brief → gated execution on an owned surface →
measure outcomes → continue / revise / roll back.

Two defining constraints:

1. **Keyless core.** 100% of the core workflow must run with **zero new
   third-party API keys** — reuse the host's AI gateway, or bundled/local
   inference, or deterministic templates. (Release gate, §2 / §20.)
2. **Portability.** Core code must **never branch on a platform slug** or
   bake in an industry taxonomy. Everything platform-specific is data on a
   Platform Profile (§14 portability rule).

## 2. Stack reality — spec vs Niche Finder

| | Spec mandate | Niche Finder today |
|---|---|---|
| Language | Python 3.12 | Node.js 22 ESM |
| API | FastAPI + Pydantic | raw `http.createServer`, zero-dep gateway |
| Store | PostgreSQL + RLS + pgvector | file backend (default) / `node:sqlite` |
| Inference | host gateway / bundled local (Qwen3-8B, BGE-M3) | Anthropic / Gemini / OpenAI SDKs via connector wrapper |
| Tenancy | installation-scoped rows + Postgres RLS | single-tenant app, wallet-scoped accounts |

**This is a different product on a different stack.** The spec says so
explicitly ("Build a standalone Growth Intelligence service… The platform
integration is an HTTPS adapter, regardless of whether the host uses Node,
Python, PHP or another stack"). It is **not** an addition to the Niche Finder
Node gateway; it is a service Niche Finder could *integrate with* as a host.

## 3. What Niche Finder already has that maps onto the spec

Niche Finder is further along than a greenfield start because several spec
primitives already exist here in production-hardened form:

| Spec requirement | Already in this repo |
|---|---|
| Metering: reserve → settle → release, never charge for unusable output | Wallet `reserve→settleHold→releaseHold` + append-only ledger; "never charged for failed AI output" guard (test-locked) |
| Approval + audit of every action | admin approval flows, audit events, output-guard |
| Connector timeout/retry/breaker/telemetry (§4) | `connector.js` wrapper (tested) |
| Agent registry with honest live/partial/proposed status (§4) | `agents.manifest.js` + validator (tested) |
| Encrypted secrets, env-override-first, no secrets in repo (§8 trust boundary) | `secrets.js` AES-256-GCM store + Admin → API Keys |
| Owned-surface renderer + immutable content (§18) | article/blog renderer, owned pages |
| Human gate against abuse (§8) | proof-of-work human gate on signup/login |
| Economy/pricing control plane (§19) | `shared/nf-economy.js` ACU economy |

**Implication:** porting the engine's *rails* (metering, approval, audit,
connector, secrets) to reuse Niche Finder's would save real time. The genuinely
**new** work is the intelligence + contract layer (below).

## 4. What is genuinely new (not present here)

- **Signal ingestion + source registry** (§3): access-path classification
  (public_keyless / host_mediated / file_import), provenance, coverage, lag.
- **Detection & scoring** (§5/§17): log-lift + robust-z gates, opportunity
  (25/25/20/15/15) and confidence (35/25/20/20) with single-family cap.
- **Growth Brief contract + SDK** (§6, App. A): closed, versioned, time-limited
  payload; effective-brief resolution with baseline fallback.
- **Owned-surface adapter** (§18): compare-and-set apply/rollback with
  idempotent receipts and reconciliation.
- **Experiment/measurement** (§10): holdout/observational, guardrails.
- **Multi-installation tenancy** (§15): installation-scoped rows + Postgres RLS.
- **Profile portability** (§14): zero slug-branching; data-driven behaviour.

## 5. What the committed foundation (`trend-intel/`) actually is

A **real, running, test-green reference** of the deterministic core — the part
the spec says to prove first (gate **G1** + the **TI-01…TI-22** matrix). Built
stack-neutral (pure-stdlib `trendintel` package) so the heart runs anywhere,
wrapped by FastAPI for the §16 surface.

**Proven, really executing (26/26 tests, deterministic):**

- §5/§17 scoring reproduces the spec example **exactly: 86.25 / 83.5, unrounded**
  (TI-03); bands and vetoes; single-family confidence cap.
- Growth Brief v1 validation (Appendix A schema, closed object) + §507 runtime
  rules; canonical fixture validates, negatives rejected.
- Observation idempotency: replay → duplicate, changed hash → 409 (TI-01).
- Application-layer installation isolation: cross-install → 404 (TI-02).
- Deterministic drafts + inference router with **no implicit cross-provider
  fallback** (TI-10, TI-18, TI-19); prompt-injection cannot escalate (TI-06).
- Owned-surface CAS apply/rollback, idempotent receipts, crash-recovery via
  reconciliation — one side effect (TI-07, TI-08).
- Metering reserve/settle/release, concurrency-safe (TI-09); billing
  reconciliation keeps newest state (TI-13); suspension keeps rollback (TI-11).
- Erasure replayed after restore (TI-15); two dissimilar profiles, no slug
  branch (TI-17); missing-token source reported unavailable, workflow continues
  (TI-22).
- Full owned-surface release-gate flow end to end (TI-21): signals → score →
  brief → local-inference draft → approve → apply SEO + content patch → measure
  → rollback, with an audit trail connecting every stage.

**Honest limits of the foundation (what it is NOT):**

- **No real LLM runs.** The "deployment" route is deterministic local
  generation (input-derived, labelled `bundled-local`), not Qwen3-8B. Wiring a
  real local model (llama.cpp/vLLM) is spec §8 integration work. TI-21 here
  proves the *keyless owned-surface pipeline*, not GPU inference.
- **SQLite, not Postgres+RLS.** Isolation is enforced at the application layer
  and the schema maps 1:1 onto the documented Postgres DDL, but the §15 RLS
  second layer (non-BYPASSRLS role, `SET LOCAL app.installation_id`) is not
  stood up here.
- **No OIDC / scoped bearer tokens.** The API scopes on an `X-Installation`
  header stand-in; real issuer/audience/role binding (§14 step 2) is pending.
- **No live third-party connectors, ad/email execution, new-page creation, or
  commercial billing provider** — all explicitly out of v1 core / separately
  released (§7, §12, §19).

## 6. Recommendation — Niche Finder as the reference pilot host

The spec's gate **G2** needs "a selected host with usable first-party data,
approved claims, a measurable outcome and a reversible test asset." **Niche
Finder qualifies on all four** and is the natural first pilot:

- **First-party data:** internal search / failed searches / validation events.
- **Approved claims + CTA:** already governed in the admin console.
- **Measurable outcome:** ACU conversions / qualified actions.
- **Reversible asset:** the article/owned-page renderer (compare-and-set).

**Two viable paths, with a recommendation:**

1. **Standalone Python service + HTTPS adapter (spec-faithful).** Build
   `trend-intel/` out through gates G1→G2; Niche Finder implements the thin
   **host adapter contract** (§14): `get_asset / apply_patch / get_receipt /
   restore_patch` over its article renderer, plus an observation push and the
   effective-brief SDK call. Keeps the engine portable for later hosts.
   *Best when the engine is meant to be sold to other hosts too (the spec's
   actual commercial thesis).* **Recommended.**

2. **Reimplement the core on Node to reuse Niche Finder's rails.** Faster to a
   single-host pilot (reuses wallet-metering, approval, audit, connector,
   secrets), but **forks the product off the portable spec** and loses the
   multi-host/standalone distribution the spec is built around. Choose only if
   Niche Finder is the *only* intended host.

**Recommended sequence:** finish G1 on the committed Python foundation (done
for the deterministic core) → wire a real local inference route and Postgres
RLS → have Niche Finder implement the §14 host adapter in shadow mode → run
G2 on one reversible Niche Finder page. Keep the brief/action contracts frozen.

## 7. Effort (honest)

- **Delivered this session:** G1 deterministic core + full TI-01…TI-22
  conformance, contracts, two fixtures, FastAPI surface. Runnable and green.
- **To spec-complete G1→G2 pilot:** ~the spec's own estimate, **6–8 weeks, two
  engineers + part-time product/SEO**, dominated by real local inference,
  Postgres RLS, OIDC, the host CMS adapter, and calibration against labelled
  history (§11 "≥80% actionable precision" gate).
- **G3→G5 (portability, first external sale, private deployment):** additional,
  per §20.

No host repository, live keys, production traffic, model benchmark, or payment
terms were available, so nothing above is claimed as production-ready.
