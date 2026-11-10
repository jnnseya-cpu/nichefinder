"""Growth Brief v1 validation — Appendix A schema + §507 runtime rules.

Closed object: unknown fields are rejected (additionalProperties: false).
A schema-valid object can still fail the runtime rules; both gates run.

Uses the `jsonschema` library when available for full-fidelity validation
against contracts/growth-brief.v1.schema.yaml; otherwise falls back to a
focused built-in validator that enforces the same constraints. Either way
the runtime rules are enforced in pure Python.
"""
from __future__ import annotations

import datetime as dt
import os
import re
from dataclasses import dataclass
from typing import Any

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_MARKET_RE = re.compile(r"^[A-Z]{2}$")
_CHANNEL_ENUM = {
    "seo",
    "organic_social",
    "sales_enablement",
    "owned_placement",
    "lifecycle",
    "paid",
}
# §507 / §16: only two draft routes are actually enabled in v1.
V1_ENABLED_CHANNELS = {"seo", "organic_social"}

REQUIRED_FIELDS = [
    "schema_version", "brief_id", "brief_version", "tenant_id", "platform_id",
    "market", "locale", "topic_id", "opportunity_score", "confidence",
    "valid_from", "expires_at", "evidence_ids", "audience", "intent",
    "approved_claim_ids", "cta_id", "allowed_channels", "prohibited_claims",
    "objective", "experiment_id", "policy_version",
]
_ALLOWED_FIELDS = set(REQUIRED_FIELDS)

_SCHEMA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "contracts", "growth-brief.v1.schema.yaml",
)


class BriefValidationError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


def _parse_utc(value: Any) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("timestamp must be RFC3339 UTC ending in Z")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def _builtin_schema_errors(brief: dict) -> list[str]:
    errors: list[str] = []
    if not isinstance(brief, dict):
        return ["brief must be an object"]

    extra = set(brief) - _ALLOWED_FIELDS
    if extra:
        errors.append(f"unknown fields rejected: {sorted(extra)}")
    for f in REQUIRED_FIELDS:
        if f not in brief:
            errors.append(f"missing required field: {f}")
    if errors:
        return errors

    def _is_id(v):
        return isinstance(v, str) and bool(_ID_RE.match(v))

    if brief["schema_version"] != 1:
        errors.append("schema_version must be 1")
    for f in ("brief_id", "tenant_id", "platform_id", "topic_id", "cta_id",
              "experiment_id"):
        if not _is_id(brief[f]):
            errors.append(f"{f} is not a valid id")
    for f in ("brief_version", "policy_version"):
        if not isinstance(brief[f], int) or isinstance(brief[f], bool) or brief[f] < 1:
            errors.append(f"{f} must be an integer >= 1")
    if not (isinstance(brief["market"], str) and _MARKET_RE.match(brief["market"])):
        errors.append("market must match ^[A-Z]{2}$")
    if not (isinstance(brief["locale"], str) and 2 <= len(brief["locale"]) <= 35):
        errors.append("locale length must be 2..35")
    for f in ("opportunity_score", "confidence"):
        v = brief[f]
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0 <= v <= 100):
            errors.append(f"{f} must be a number in 0..100")
    for f in ("audience", "intent", "objective"):
        v = brief[f]
        if not (isinstance(v, str) and 1 <= len(v) <= 500):
            errors.append(f"{f} must be short_text (1..500 chars)")
    for f in ("evidence_ids", "approved_claim_ids"):
        v = brief[f]
        if not isinstance(v, list) or len(v) > 64 or len(set(map(str, v))) != len(v):
            errors.append(f"{f} must be a unique id_list (<=64)")
        elif not all(_is_id(x) for x in v):
            errors.append(f"{f} has a non-id member")
    if len(brief.get("evidence_ids", [1])) < 1:
        errors.append("evidence_ids requires at least one item")
    ch = brief["allowed_channels"]
    if (not isinstance(ch, list) or not (1 <= len(ch) <= 6)
            or len(set(ch)) != len(ch) or not all(c in _CHANNEL_ENUM for c in ch)):
        errors.append("allowed_channels must be 1..6 unique channel enum values")
    pc = brief["prohibited_claims"]
    if (not isinstance(pc, list) or len(pc) > 32 or len(set(pc)) != len(pc)
            or not all(isinstance(x, str) and 1 <= len(x) <= 500 for x in pc)):
        errors.append("prohibited_claims must be <=32 unique short_text")
    for f in ("valid_from", "expires_at"):
        try:
            _parse_utc(brief[f])
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{f}: {exc}")
    return errors


def _jsonschema_errors(brief: dict) -> list[str] | None:
    """Full-fidelity validation when jsonschema + yaml are available."""
    try:
        import yaml  # type: ignore
        import jsonschema  # type: ignore
    except Exception:  # noqa: BLE001
        return None
    try:
        with open(_SCHEMA_PATH, "r", encoding="utf-8") as fh:
            schema = yaml.safe_load(fh)
        validator = jsonschema.Draft202012Validator(schema)
        return [
            f"{list(e.absolute_path)}: {e.message}"
            for e in sorted(validator.iter_errors(brief), key=str)
        ]
    except FileNotFoundError:
        return None


def validate_schema(brief: dict) -> list[str]:
    """Return schema errors ([] == valid). Prefers jsonschema, else built-in."""
    errs = _jsonschema_errors(brief)
    if errs is None:
        errs = _builtin_schema_errors(brief)
    return errs


@dataclass
class RuntimeContext:
    now: dt.datetime
    installed_locales: set[str]
    active_market: str
    active_policy_version: int
    enabled_channels: set[str] | None = None  # defaults to V1_ENABLED_CHANNELS


def validate_runtime(brief: dict, ctx: RuntimeContext) -> list[str]:
    """§507 runtime rules beyond JSON Schema.

    These assume the object already passed validate_schema.
    """
    errors: list[str] = []
    try:
        vf = _parse_utc(brief["valid_from"])
        ex = _parse_utc(brief["expires_at"])
    except Exception as exc:  # noqa: BLE001
        return [f"timestamp parse: {exc}"]

    if not vf < ex:
        errors.append("valid_from must be < expires_at")
    if not (vf <= ctx.now < ex):
        errors.append("brief not currently in its validity window")
    if brief["locale"] not in ctx.installed_locales:
        errors.append(f"locale {brief['locale']} not in installed locale set")
    if brief["market"] != ctx.active_market:
        errors.append(f"market {brief['market']} does not match active profile")
    if brief["policy_version"] != ctx.active_policy_version:
        errors.append("policy_version mismatch with active policy")
    enabled = ctx.enabled_channels or V1_ENABLED_CHANNELS
    not_enabled = [c for c in brief["allowed_channels"] if c not in enabled]
    if not_enabled:
        errors.append(f"channels not enabled by an adapter+policy: {not_enabled}")
    return errors


def validate_brief(brief: dict, ctx: RuntimeContext) -> None:
    """Raise BriefValidationError if the brief fails schema or runtime rules."""
    errs = validate_schema(brief)
    if errs:
        raise BriefValidationError(errs)
    errs = validate_runtime(brief, ctx)
    if errs:
        raise BriefValidationError(errs)
