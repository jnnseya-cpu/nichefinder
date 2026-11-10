"""Draft generation — spec §2 (templates keep workflow available), §7, §18.

The deterministic template route is the keyless guarantee: it produces
schema-valid SEO and organic-social drafts from the brief + approved claims
with no model and no provider account. It is also the fallback when a host
or deployment route is unavailable.

Every factual marketing claim must map to an approved claim id (§8 trust
boundary). Prohibited claims are never emitted. A prompt-injection string in
the input cannot produce a privileged action because the output is a typed,
closed draft structure — the executor only interprets validated typed
actions (TI-06).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .inference import InferenceRequest

SEO_DRAFT = "seo_page_draft"
SOCIAL_DRAFT = "organic_social_draft"
SEO_METADATA_PATCH = "seo_metadata_patch"
OWNED_CONTENT_PATCH = "owned_content_patch"

# §18: live execution v1 supports only these two kinds, on prebound assets.
V1_LIVE_ACTION_KINDS = {SEO_METADATA_PATCH, OWNED_CONTENT_PATCH}
V1_DRAFT_ACTION_KINDS = {SEO_DRAFT, SOCIAL_DRAFT}


@dataclass
class DraftContext:
    topic: str
    audience: str
    intent: str
    approved_claims: dict  # claim_id -> approved text
    cta_text: str
    prohibited_claims: list
    market: str
    locale: str


def _contains_prohibited(text: str, prohibited: list) -> Optional[str]:
    low = text.lower()
    for p in prohibited:
        if p.lower() in low:
            return p
    return None


def template_seo_draft(ctx: DraftContext) -> dict:
    """Deterministic SEO draft (title/description/body block). No model."""
    claim_text = next(iter(ctx.approved_claims.values()), "")
    title = f"{ctx.topic.strip().title()} — {ctx.audience.strip()}"[:60]
    description = (f"{claim_text} {ctx.cta_text}".strip())[:155]
    body = (
        f"People in {ctx.market} are looking to {ctx.intent}. "
        f"{claim_text} {ctx.cta_text}"
    ).strip()
    draft = {
        "action_kind": SEO_DRAFT,
        "channel": "seo",
        "fields": {"title": title, "meta_description": description,
                   "body_block": body},
        "claim_refs": list(ctx.approved_claims.keys()),
        "locale": ctx.locale,
    }
    return draft


def template_social_draft(ctx: DraftContext) -> dict:
    claim_text = next(iter(ctx.approved_claims.values()), "")
    post = f"{claim_text} {ctx.cta_text}".strip()[:280]
    return {
        "action_kind": SOCIAL_DRAFT,
        "channel": "organic_social",
        "fields": {"post": post},
        "claim_refs": list(ctx.approved_claims.keys()),
        "locale": ctx.locale,
    }


def claim_safety_check(draft: dict, ctx: DraftContext) -> list[str]:
    """Return a list of violations ([] == safe). Enforced before any write."""
    violations = []
    for field_val in draft.get("fields", {}).values():
        if not isinstance(field_val, str):
            continue
        hit = _contains_prohibited(field_val, ctx.prohibited_claims)
        if hit:
            violations.append(f"prohibited claim present: {hit!r}")
    # Every claim ref must resolve to an approved claim.
    for cid in draft.get("claim_refs", []):
        if cid not in ctx.approved_claims:
            violations.append(f"unapproved claim ref: {cid}")
    return violations


def make_template_route(ctx: DraftContext):
    """Build an inference-router template_fn that emits a draft by purpose."""
    def _fn(req: InferenceRequest) -> dict:
        if req.purpose == "social_draft":
            return template_social_draft(ctx)
        return template_seo_draft(ctx)
    return _fn
