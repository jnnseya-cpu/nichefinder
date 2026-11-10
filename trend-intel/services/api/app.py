"""FastAPI surface — spec §16 core API over the trendintel engine.

Reference surface. Installation scope is carried on the `X-Installation`
header (a stand-in for the scoped bearer credential in §16); full OIDC
issuer/audience binding and per-role scopes are host-integration work
(§14 step 2). Typed engine errors map to the §16 HTTP contract, and the
OpenAPI document is served at /openapi.json for SDK generation (§20).

Run:  uvicorn services.api.app:app  (from the trend-intel/ directory)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fastapi import FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from trendintel import __version__, entitlement, profiles  # noqa: E402
from trendintel.engine import Engine  # noqa: E402
from trendintel.errors import TrendIntelError  # noqa: E402
from trendintel.fixtures import bootstrap  # noqa: E402

app = FastAPI(title="Trend Intelligence AI", version=__version__,
              description="Reference API (spec §16). Keyless core workflow.")

ENGINE = Engine()
FIXTURES = bootstrap(ENGINE.store)


def _scope(x_installation: str | None) -> str:
    if not x_installation:
        raise HTTPException(status_code=401, detail="X-Installation header required")
    try:
        ENGINE.store.get_installation(x_installation)
    except TrendIntelError:
        raise HTTPException(status_code=404, detail="installation not found")
    return x_installation


@app.exception_handler(TrendIntelError)
async def _te(_req: Request, exc: TrendIntelError):
    return JSONResponse(
        status_code=exc.http_status,
        content={"code": exc.code, "message": exc.message,
                 "retryable": exc.retryable, **exc.extra},
    )


# -- models ---------------------------------------------------------------
class Observation(BaseModel):
    source_id: str
    source_record_id: str
    source_family: str
    observed_at: str
    metric: str
    value: float
    revision: int = 1


class ObservationBatch(BaseModel):
    observations: list[Observation] = Field(..., max_length=500)


class ScoreRequest(BaseModel):
    topic: str
    demand: float
    timing: float
    readiness: float
    source_quality: float
    coverage: float
    freshness: float
    source_record_ids: list[str] = []
    vetoes: list[str] = []


# -- routes ---------------------------------------------------------------
@app.get("/healthz")
def healthz():
    return {"status": "ok", "version": __version__,
            "keyless_core": True, "installations": len(FIXTURES)}


@app.get("/v1/fixtures")
def fixtures():
    return {k: {"installation_id": v["installation_id"],
                "platform_slug": v["platform_slug"], "market": v["market"],
                "locale": v["locale"]} for k, v in FIXTURES.items()}


@app.post("/v1/observations:batch", status_code=202)
def observations_batch(batch: ObservationBatch,
                       x_installation: str = Header(None)):
    iid = _scope(x_installation)
    res = ENGINE.ingest(iid, [o.model_dump() for o in batch.observations])
    return res.as_dict()


@app.post("/v1/score")
def score(req: ScoreRequest, x_installation: str = Header(None)):
    iid = _scope(x_installation)
    return ENGINE.score_topic(iid, topic=req.topic, demand=req.demand,
                              timing=req.timing, readiness=req.readiness,
                              source_record_ids=req.source_record_ids,
                              source_quality=req.source_quality,
                              coverage=req.coverage, freshness=req.freshness,
                              vetoes=req.vetoes or None)


@app.get("/v1/briefs:effective")
def effective_brief(market: str, locale: str, topic_id: str,
                    x_installation: str = Header(None)):
    iid = _scope(x_installation)
    doc = ENGINE.effective_brief(iid, market=market, locale=locale,
                                 topic_id=topic_id)
    if doc is None:
        return JSONResponse(status_code=204, content=None)
    return doc


@app.get("/v1/entitlement")
def get_entitlement(x_installation: str = Header(None)):
    iid = _scope(x_installation)
    return {**entitlement.get(ENGINE.store, iid),
            "usage": entitlement.usage(ENGINE.store, iid)}


@app.get("/v1/experiments/{experiment_id}")
def experiment(experiment_id: str, x_installation: str = Header(None)):
    iid = _scope(x_installation)
    rep = ENGINE.report(iid)
    return {"experiment_id": experiment_id, **rep,
            "control_method": "observational" if rep["sample_status"] != "sufficient"
            else "first_party_holdout"}


@app.get("/v1/sources")
def sources(x_installation: str = Header(None)):
    _scope(x_installation)
    return {"sources": ENGINE.sources.status()}
