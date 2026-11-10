"""High-level engine facade — composes the core modules.

Used by the FastAPI surface (services/api) and the conformance suite so the
same code paths are exercised by both. No platform-slug branching lives here
(§14 portability rule): behaviour is driven by the installation's profile.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Optional

from . import entitlement, profiles
from .actions import ActionService, BriefRef
from .drafts import DraftContext, make_template_route
from .errors import NotFound
from .inference import (DEPLOYMENT, DETERMINISTIC, HOST, InferenceRequest,
                        InferenceRouter)
from .observations import ingest_batch, independent_family_count
from .owned_surface import OwnedSurface, measurement_report, record_outcome
from .scoring import (ConfidenceInputs, OpportunityInputs, confidence_score,
                      corroboration_value, decide, opportunity_score)
from .store import Store, jdumps, jloads, new_id, now_iso


# --- source registry (§3) ------------------------------------------------
PUBLIC_KEYLESS = "public_keyless"
HOST_MEDIATED = "host_mediated"
FILE_IMPORT = "file_import"


@dataclass
class SourceRegistry:
    """Tracks access_path and availability per source (§3).

    A source needing an access token the installation does not already hold
    (host-mediated with no authorised host integration) is reported
    unavailable — the workflow continues on what is available (TI-22). The
    module never prompts for a new credential.
    """
    _sources: dict = field(default_factory=dict)

    def register(self, source_id: str, *, access_path: str, family: str,
                 available: bool = True):
        self._sources[source_id] = {
            "access_path": access_path, "family": family,
            "available": available,
        }

    def available(self, source_id: str) -> bool:
        return self._sources.get(source_id, {}).get("available", False)

    def registered(self) -> set[str]:
        return set(self._sources)

    def status(self) -> list[dict]:
        return [{"source_id": k, **v} for k, v in sorted(self._sources.items())]


class Engine:
    def __init__(self, store: Optional[Store] = None, *,
                 clock=None):
        self.store = store or Store(":memory:")
        self.surface = OwnedSurface(self.store)
        self.clock = clock or (lambda: dt.datetime.now(dt.timezone.utc))
        self.actions = ActionService(self.store, self.surface, clock=self.clock)
        self.sources = SourceRegistry()

    # -- ingestion --------------------------------------------------------
    def ingest(self, installation_id: str, observations: list[dict]):
        return ingest_batch(self.store, installation_id, observations,
                            registered_sources=self.sources.registered() or None)

    # -- scoring (profile-driven) -----------------------------------------
    def score_topic(self, installation_id: str, *, topic: str, demand: float,
                    timing: float, readiness: float, source_record_ids: list[str],
                    source_quality: float, coverage: float, freshness: float,
                    vetoes: Optional[list[str]] = None) -> dict:
        profile = profiles.active_profile(self.store, installation_id)
        fit, intent = profiles.fit_intent_for(profile, topic)
        opp = opportunity_score(
            OpportunityInputs(demand=demand, fit=fit, intent=intent,
                              timing=timing, readiness=readiness),
            vetoes=vetoes,
        )
        families = independent_family_count(self.store, installation_id,
                                            source_record_ids)
        conf = confidence_score(ConfidenceInputs(
            source_quality=source_quality,
            corroboration=corroboration_value(families),
            coverage=coverage, freshness=freshness,
            independent_families=families,
        ))
        decision = decide(opp.score, conf.score, vetoed=opp.vetoed)
        return {
            "topic": topic, "opportunity_score": opp.score,
            "confidence": conf.score, "decision": decision,
            "vetoed": opp.vetoed, "veto_reasons": opp.veto_reasons,
            "independent_families": families,
            "confidence_capped": conf.capped,
            "opportunity_breakdown": opp.breakdown,
            "confidence_breakdown": conf.breakdown,
        }

    # -- briefs -----------------------------------------------------------
    def create_brief(self, installation_id: str, brief_doc: dict,
                     *, status: str = "approved") -> dict:
        profile = profiles.active_profile(self.store, installation_id)
        with self.store.tx() as conn:
            conn.execute("UPDATE briefs SET active=0 WHERE installation_id=? "
                         "AND market=? AND locale=? AND topic_id=?",
                         (installation_id, brief_doc["market"],
                          brief_doc["locale"], brief_doc["topic_id"]))
            conn.execute(
                "INSERT INTO briefs(installation_id,brief_id,revision,active,"
                "market,locale,topic_id,status,doc,created_at) VALUES "
                "(?,?,?,?,?,?,?,?,?,?)",
                (installation_id, brief_doc["brief_id"], brief_doc["brief_version"],
                 1, brief_doc["market"], brief_doc["locale"], brief_doc["topic_id"],
                 status, jdumps(brief_doc), now_iso()),
            )
        self.store.audit(installation_id, "brief.created",
                         {"brief_id": brief_doc["brief_id"], "status": status})
        return brief_doc

    def effective_brief(self, installation_id: str, *, market: str, locale: str,
                        topic_id: str) -> Optional[dict]:
        """Resolve an approved, fresh brief, or None (caller uses baseline).

        An expired or revoked brief never resolves (TI-05).
        """
        r = self.store.execute(
            "SELECT doc,status FROM briefs WHERE installation_id=? AND market=? "
            "AND locale=? AND topic_id=? AND active=1",
            (installation_id, market, locale, topic_id),
        ).fetchone()
        if r is None or r["status"] != "approved":
            return None
        doc = jloads(r["doc"])
        expires = dt.datetime.fromisoformat(doc["expires_at"].replace("Z", "+00:00"))
        if self.clock() >= expires:
            return None
        return doc

    def brief_ref(self, brief_doc: dict, *, revoked: bool = False) -> BriefRef:
        return BriefRef(
            brief_id=brief_doc["brief_id"],
            brief_version=brief_doc["brief_version"],
            expires_at=dt.datetime.fromisoformat(
                brief_doc["expires_at"].replace("Z", "+00:00")),
            policy_version=brief_doc["policy_version"],
            revoked=revoked,
        )

    # -- draft generation -------------------------------------------------
    def draft_context(self, installation_id: str, brief_doc: dict) -> DraftContext:
        profile = profiles.active_profile(self.store, installation_id)
        claims = {cid: profile.get("claims", {}).get(cid, "")
                  for cid in brief_doc["approved_claim_ids"]}
        cta_text = brief_doc["cta_id"].replace("cta_", "").replace("_", " ")
        return DraftContext(
            topic=brief_doc["topic_id"].replace("-", " "),
            audience=brief_doc["audience"], intent=brief_doc["intent"],
            approved_claims=claims, cta_text=cta_text,
            prohibited_claims=brief_doc["prohibited_claims"],
            market=brief_doc["market"], locale=brief_doc["locale"],
        )

    def make_router(self, ctx: DraftContext, *, route: str = DETERMINISTIC,
                    host_fn=None, deployment_fn=None,
                    authorised_alternate=None) -> InferenceRouter:
        return InferenceRouter(
            template_fn=make_template_route(ctx), host_fn=host_fn,
            deployment_fn=deployment_fn, route=route,
            authorised_alternate=authorised_alternate,
            validate_fn=lambda d: isinstance(d, dict) and "fields" in d,
        )

    def generate_draft(self, installation_id: str, brief_doc: dict, *,
                       purpose: str = "seo_draft", route: str = DETERMINISTIC,
                       host_fn=None, deployment_fn=None,
                       authorised_alternate=None, meter: bool = True) -> dict:
        ctx = self.draft_context(installation_id, brief_doc)
        router = self.make_router(ctx, route=route, host_fn=host_fn,
                                  deployment_fn=deployment_fn,
                                  authorised_alternate=authorised_alternate)
        work_id = new_id("work")
        reserved = False
        if meter:
            entitlement.reserve_draft(self.store, installation_id, work_id)
            reserved = True
        try:
            req = InferenceRequest(
                installation_id=installation_id, request_id=new_id("req"),
                purpose=purpose, model_alias="default", schema_revision="v1",
                sanitized_input={"topic": ctx.topic, "intent": ctx.intent},
            )
            resp = router.generate_structured(req)
            # §19: only a real generated draft is metered; template -> release.
            if meter:
                if resp.status == "ok":
                    entitlement.settle_draft(self.store, installation_id, work_id)
                else:
                    entitlement.release_draft(self.store, installation_id, work_id)
            return {"draft": resp.output, "route": resp.route,
                    "status": resp.status, "calls": router.calls,
                    "work_id": work_id}
        except Exception:
            if reserved:
                entitlement.release_draft(self.store, installation_id, work_id)
            raise

    # -- third-party external write (not available in v1) -----------------
    def third_party_write(self, installation_id: str, destination: str) -> dict:
        """External-account writes depend on an already-authorised host
        integration. Absent that, report unavailable — never prompt for a new
        credential (TI-20, TI-22)."""
        return {"destination": destination, "status": "unavailable",
                "reason": "no authorised host integration; use owned surface or export"}

    # -- measurement ------------------------------------------------------
    def record_visit(self, installation_id: str, outcome_id: str,
                     denominator: str = "eligible_session", **kw):
        return record_outcome(self.store, installation_id, outcome_id,
                              denominator, **kw)

    def report(self, installation_id: str) -> dict:
        return measurement_report(self.store, installation_id)
