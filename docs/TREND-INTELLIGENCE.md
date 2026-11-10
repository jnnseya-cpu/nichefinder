# Trend Intelligence — embedded, invisible control layer

**Status:** embedded into the live Niche Finder gateway (not a separate service).
**Spec:** Trend Intelligence AI build spec v2.3. **Backing code:** `backend/gateway/src/trends.js`.
**Visibility:** none to end users — operates in the background; operator control is admin-API only.

## What it is

A control layer embedded inside the existing gateway that reads demand signals,
scores opportunities on a fixed published rubric, issues a versioned, time-limited
**Growth Brief**, and — only with operator approval — applies SEO/content changes
to an owned page, measures the result, and can roll it back. It reuses the
platform's own rails (auth/admin gate, audit, the article/owned-page surface,
the connector wrapper for host AI) and is scoped to this one platform
installation. It is **100% keyless**: detection, scoring, templates, the
owned-surface activation and measurement need no new third-party API key.

It runs **invisibly**: a background scheduler (`startTrendsScheduler`, started in
`server.js` on boot) runs detection/scoring on operator-configured topics and
records **shadow (draft) briefs only**. Nothing goes live, and nothing is shown
to users, without an explicit operator approval through the admin API.

## Why embedded, not standalone

The build-spec ships as a standalone Python/FastAPI service, but the requirement
here is a single platform: the engine is re-implemented as a native zero-dependency
Node ESM module matching the gateway's conventions (own JSON persistence with a
debounced atomic write + flush, exactly like `articles.js`). No separate process,
no new runtime, no new credentials.

## What is enforced (and test-locked in `test/trends.js`)

- **Scoring** (§5/§17): log-lift, robust-z, opportunity (25/25/20/15/15) and
  confidence (35/25/20/20); reproduces the spec example exactly — **86.25 / 83.5**,
  unrounded. Single source family capped at 69; readiness 0 vetoes activation.
- **Idempotent ingest**: replay → duplicate, changed hash → 409, PII rejected.
- **Growth Brief v1** (Appendix A closed object) + runtime rules (validity window,
  market/policy match, only enabled channels). No lifecycle/CRM direct-marketing
  path in v1.
- **Owned surface** (§18): compare-and-set apply/rollback, idempotent receipts,
  crash recovery via reconciliation (one side effect), stale-revision conflict.
- **Action lifecycle** (§6): approval binds the canonical payload hash; author ≠
  approver; execution re-authorises freshness/freeze/policy; expired brief denies
  a queued action.
- **Prompt-injection safety**: only typed, allowlisted action kinds; a draft is a
  closed structure with no privilege surface.
- **Freeze switch**, measurement (eligible/conversions/rate), and third-party
  external writes reported `unavailable` (never prompts for a credential).

## Operator surface (admin-API only, invisible to users)

All under `/v1/admin/trends` and admin-gated (`adminOf()`), mirroring the other
admin endpoints. No console tab, no user-facing page.

| Endpoint | Purpose |
|---|---|
| `GET /v1/admin/trends` | Dashboard: profile, sources, briefs, actions, pages, report, recent audit |
| `POST /v1/admin/trends/profile` | Configure the platform profile (market, locale, claims, fit map, `autopilot_topics`) |
| `POST /v1/admin/trends/source` | Register a signal source + access path + availability |
| `POST /v1/admin/trends/observations` | Ingest first-party / keyless observations |
| `POST /v1/admin/trends/score` | Score a topic |
| `POST /v1/admin/trends/detect` | Run one detection cycle on demand |
| `POST /v1/admin/trends/brief` | Create a brief (draft or approved) |
| `POST /v1/admin/trends/page` | Create/approve an owned page |
| `POST /v1/admin/trends/action[/approve|/execute|/rollback]` | Gated owned-surface activation |
| `POST /v1/admin/trends/freeze` | Emergency freeze / unfreeze |

## Safety posture (unchanged platform laws)

No agent holds a provider key. No live write without human approval. ACU charges
are unchanged — trend operations are internal platform tooling and do not bill
users. Secrets are never committed. The six Trend Intelligence agents are declared
honestly in the agent registry (`agents.manifest.js`) with `live` status and an
`impl` pointer to `trends.js`.

## Enabling background autopilot

Configure `autopilot_topics` on the profile (via `POST /v1/admin/trends/profile`)
with per-topic scoring inputs. The scheduler then records shadow briefs for topics
that clear the reviewable-brief band. Opt out entirely with `TRENDS_AUTOPILOT=0`.
Without configured topics it is a safe no-op.
