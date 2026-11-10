"""Detection and scoring — spec §5 and §17.

Pure, deterministic functions. No model, no network, no provider account.
These are the "deterministic" keyless path: they always run.

The worked example in §5/§90 must reproduce exactly:
  demand 80, fit 95, intent 85, timing 90, readiness 80  -> opportunity 86.25
  quality 90, corroboration 80, coverage 70, freshness 90 -> confidence 83.5
Both are returned at full precision; callers round only for display (TI-03).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import median
from typing import Iterable, Sequence

# --- §5.4 opportunity weights / §5.5 confidence weights -------------------
OPPORTUNITY_WEIGHTS = {
    "demand": 0.25,
    "fit": 0.25,
    "intent": 0.20,
    "timing": 0.15,
    "readiness": 0.15,
}
CONFIDENCE_WEIGHTS = {
    "source_quality": 0.35,
    "corroboration": 0.25,
    "coverage": 0.20,
    "freshness": 0.20,
}

# --- §5.3 count-feed gate (defaults; adjustable by source/geography) -------
DEFAULT_COUNT_GATE = 20
DEFAULT_Z_GATE = 2.0
MIN_COMPARABLE_PERIODS = 4
SINGLE_FAMILY_CONFIDENCE_CAP = 69.0  # §5.5 starting rule


def log_lift(current: float, baseline: float) -> float:
    """§5.3 lift = ln((c+1)/(b+1))."""
    return math.log((current + 1.0) / (baseline + 1.0))


def _mad(values: Sequence[float], center: float) -> float:
    """Median absolute deviation."""
    if not values:
        return 0.0
    return median([abs(v - center) for v in values])


def robust_z(current: float, history: Sequence[float]) -> float:
    """§5.3 robust anomaly score.

    z = (log1p(c) - median(log1p(x))) / max(1.4826 * MAD(log1p(x)), 0.2)
    """
    logs = [math.log1p(x) for x in history]
    if not logs:
        return 0.0
    med = median(logs)
    scale = max(1.4826 * _mad(logs, med), 0.2)
    return (math.log1p(current) - med) / scale


@dataclass
class CountGateResult:
    passed: bool
    reason: str
    z: float
    lift: float
    insufficient_history: bool


def count_feed_gate(
    current: int,
    history: Sequence[float],
    *,
    count_gate: int = DEFAULT_COUNT_GATE,
    z_gate: float = DEFAULT_Z_GATE,
) -> CountGateResult:
    """§5.3 initial count-feed gate: c >= count_gate AND z >= z_gate.

    With fewer than four comparable periods: label insufficient history and
    keep draft-only (never auto-activate).  Never applied to indexed/ranked
    feeds — those get source-specific gates (see score_demand_component).
    """
    if len(history) < MIN_COMPARABLE_PERIODS:
        return CountGateResult(False, "insufficient_history", 0.0, 0.0, True)
    z = robust_z(current, history)
    lift = log_lift(current, median(history))
    if current < count_gate:
        return CountGateResult(False, f"count<{count_gate}", z, lift, False)
    if z < z_gate:
        return CountGateResult(False, f"z<{z_gate}", z, lift, False)
    return CountGateResult(True, "ok", z, lift, False)


def demand_from_z(z: float) -> float:
    """§17 reference mapping for count feeds: clamp(50 + 10*z, 0, 100)."""
    return _clamp(50.0 + 10.0 * z, 0.0, 100.0)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


@dataclass
class OpportunityInputs:
    demand: float
    fit: float
    intent: float
    timing: float
    readiness: float


@dataclass
class OpportunityResult:
    score: float
    breakdown: dict
    vetoed: bool
    veto_reasons: list = field(default_factory=list)


def opportunity_score(
    inp: OpportunityInputs,
    *,
    vetoes: Iterable[str] | None = None,
) -> OpportunityResult:
    """§5.4 opportunity score 0-100 from weighted components.

    Missing readiness blocks activation (readiness==0 is a hard veto).
    Hard vetoes (out-of-market, unsupported claim, restricted topic,
    unavailable inventory, illegal targeting) force non-activation.
    """
    reasons = list(vetoes or [])
    if inp.readiness <= 0:
        reasons.append("readiness_zero")
    score = (
        OPPORTUNITY_WEIGHTS["demand"] * inp.demand
        + OPPORTUNITY_WEIGHTS["fit"] * inp.fit
        + OPPORTUNITY_WEIGHTS["intent"] * inp.intent
        + OPPORTUNITY_WEIGHTS["timing"] * inp.timing
        + OPPORTUNITY_WEIGHTS["readiness"] * inp.readiness
    )
    return OpportunityResult(
        score=score,
        breakdown={
            "demand": inp.demand,
            "fit": inp.fit,
            "intent": inp.intent,
            "timing": inp.timing,
            "readiness": inp.readiness,
            "weights": dict(OPPORTUNITY_WEIGHTS),
        },
        vetoed=bool(reasons),
        veto_reasons=reasons,
    )


def corroboration_value(independent_families: int) -> float:
    """§17: 0 for one independent family, 80 for two, 100 for three or more."""
    if independent_families <= 1:
        return 0.0
    if independent_families == 2:
        return 80.0
    return 100.0


@dataclass
class ConfidenceInputs:
    source_quality: float
    corroboration: float
    coverage: float
    freshness: float
    independent_families: int = 1


@dataclass
class ConfidenceResult:
    score: float
    capped: bool
    breakdown: dict


def confidence_score(inp: ConfidenceInputs) -> ConfidenceResult:
    """§5.5 confidence 0-100, independent of the opportunity score.

    Single source family is capped at 69 (§5.5 starting rule). Model
    certainty is excluded by construction — it is not an input.
    """
    raw = (
        CONFIDENCE_WEIGHTS["source_quality"] * inp.source_quality
        + CONFIDENCE_WEIGHTS["corroboration"] * inp.corroboration
        + CONFIDENCE_WEIGHTS["coverage"] * inp.coverage
        + CONFIDENCE_WEIGHTS["freshness"] * inp.freshness
    )
    capped = False
    score = raw
    if inp.independent_families <= 1 and raw > SINGLE_FAMILY_CONFIDENCE_CAP:
        score = SINGLE_FAMILY_CONFIDENCE_CAP
        capped = True
    return ConfidenceResult(
        score=score,
        capped=capped,
        breakdown={
            "source_quality": inp.source_quality,
            "corroboration": inp.corroboration,
            "coverage": inp.coverage,
            "freshness": inp.freshness,
            "independent_families": inp.independent_families,
            "weights": dict(CONFIDENCE_WEIGHTS),
            "raw": raw,
        },
    )


# --- §5 decision table ----------------------------------------------------
DECISION_ARCHIVE = "archive"
DECISION_WATCH = "watch"           # watch or draft internally; no live change
DECISION_REVIEWABLE_BRIEF = "reviewable_brief"
DECISION_AUTO_ELIGIBLE = "auto_eligible"  # bounded auto action, low-risk classes


def decide(
    score: float,
    confidence: float,
    *,
    vetoed: bool = False,
    tenant_auto_optin: bool = False,
) -> str:
    """§5 banding. External actions still require policy + channel approval."""
    if vetoed:
        # A veto can never clear for live/auto action; best case is watch.
        return DECISION_WATCH if (score >= 60 and confidence >= 55) else DECISION_ARCHIVE
    if score < 60 or confidence < 55:
        return DECISION_ARCHIVE
    if score >= 85 and confidence >= 85 and tenant_auto_optin:
        return DECISION_AUTO_ELIGIBLE
    if score >= 75 and confidence >= 75:
        return DECISION_REVIEWABLE_BRIEF
    return DECISION_WATCH


def demand_component_from_families(
    family_scores: dict[str, float],
) -> float:
    """§17 demand component: median of the highest-weight valid observation
    per independent source family (here each family contributes one calibrated
    0-100 score), deterministic tie-break by source family id.
    """
    if not family_scores:
        return 0.0
    ordered = [family_scores[k] for k in sorted(family_scores)]
    return float(median(ordered))
