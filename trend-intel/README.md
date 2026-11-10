# Trend Intelligence AI — reference engine

A working, test-green **foundation** for the Trend Intelligence AI build spec
v2.3: the deterministic, **keyless** core of a standalone control layer for
existing SEO/marketing agents — signal ingestion → scoring → versioned Growth
Brief → gated owned-surface execution → measurement → rollback.

> Scope honesty: this implements the spec's **G1 clean-install gate** and the
> full **TI-01…TI-22 conformance matrix** as real passing tests. It is **not**
> the complete 6–8-week product. See [`docs/FIT-ASSESSMENT.md`](docs/FIT-ASSESSMENT.md)
> for exactly what is and isn't here, and how Niche Finder maps on as the first
> pilot host.

## Design

- **`trendintel/`** — stack-neutral core, **pure Python stdlib** (no third-party
  imports), so the deterministic heart runs anywhere:
  - `scoring.py` — §5/§17 log-lift, robust-z gates, opportunity & confidence
    (reproduces the spec example exactly: **86.25 / 83.5**, unrounded).
  - `schema.py` — Growth Brief v1 validation (Appendix A, closed object) +
    §507 runtime rules. Uses `jsonschema` when present, else a built-in validator.
  - `store.py` — SQLite reference backend; installation-scoped rows (Postgres+RLS
    is the documented production isolation layer).
  - `observations.py` — idempotent ingest (replay→duplicate, changed hash→409).
  - `inference.py` — host / deployment / deterministic router, **no implicit
    cross-provider fallback**, no provider secrets in config/prompts/logs.
  - `drafts.py` — deterministic template drafts + claim-safety checks.
  - `owned_surface.py` — native page adapter: compare-and-set apply/rollback,
    idempotent receipts, reconciliation, first-party measurement.
  - `actions.py` — proposed→approved→applied state machine; approval binds the
    canonical payload hash + target revision; author≠approver; execution re-auth.
  - `entitlement.py` — reserve/settle/release metering, billing reconciliation.
  - `erasure.py`, `profiles.py`, `engine.py`, `fixtures.py`.
- **`contracts/`** — `growth-brief.v1.schema.yaml` (Appendix A), `openapi.json`
  snapshot, canonical brief + two profile fixtures (A: subscription/en-CA,
  B: storefront/fr-FR).
- **`services/api/`** — FastAPI surface for the §16 API; `/openapi.json` for SDK
  generation. Optional (only needed for the HTTP surface).
- **`tests/`** — `conformance/test_ti.py` (TI-01…TI-22) + `test_contracts.py`.

## Run the conformance suite

The core needs **no dependencies**. The FastAPI surface and full-fidelity
schema validation use a few libs:

```bash
cd trend-intel
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pytest tests -q            # 26 passed
```

The deterministic core also runs under a plain interpreter with no installs
(the schema validator falls back to its built-in path):

```bash
python3 -c "import sys; sys.path.insert(0,'.'); \
from trendintel.scoring import opportunity_score, OpportunityInputs; \
print(opportunity_score(OpportunityInputs(80,95,85,90,80)).score)"   # 86.25
```

## Run the API

```bash
cd trend-intel
uvicorn services.api.app:app --port 8800
# GET /healthz ; GET /openapi.json ; POST /v1/observations:batch (X-Installation header)
```

## Conformance evidence

`evidence/conformance-run.txt` — the TI-01…TI-22 run, twice, deterministic.
