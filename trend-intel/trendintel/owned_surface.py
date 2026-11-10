"""Native owned-surface adapter + measurement — spec §18.

A real page store at a deployment-managed address. Writes use
compare-and-set against an expected revision and persist an idempotent
receipt atomically with the revision change. Public read serves only the
active revision; drafts/previews are never public.

This adapter needs no third-party integration and no new credentials: it is
the owned activation path that must work even when every external connector
is disabled (spec §2 coverage boundary, §13 owned-surface egress blocked).

Semantics implemented (§18 adapter interface):
  get_asset(asset_id)
  apply_patch(asset_id, expected_revision, fields, action_key)   CAS
  get_receipt(action_key)
  restore_patch(asset_id, expected_applied_revision, previous_fields, key)
"""
from __future__ import annotations

from dataclasses import dataclass

from .drafts import V1_LIVE_ACTION_KINDS
from .errors import Conflict, Invalid, NotFound, TargetRevisionConflict
from .store import Store, canonical_hash, now_iso

# §18 typed field allowlist for live patches.
ALLOWED_PATCH_FIELDS = {"title", "meta_description", "body_block",
                        "headline", "cta_copy"}
# Out of scope for v1 automation (§18).
FORBIDDEN_PATCH_FIELDS = {"url", "redirects", "canonical", "robots",
                          "structured_data", "permissions", "template_code"}


@dataclass
class AssetView:
    asset_id: str
    current_revision: int
    active_revision: int
    fields: dict
    content_hash: str
    approved: bool


class OwnedSurface:
    def __init__(self, store: Store):
        self.store = store

    # -- editorial lifecycle ----------------------------------------------
    def create_page(self, installation_id: str, asset_id: str,
                    fields: dict, *, approved: bool = False) -> AssetView:
        """A first native page must be explicitly created (and approved by an
        editor before it serves publicly)."""
        self._check_fields(fields)
        h = canonical_hash(fields)
        with self.store.tx() as conn:
            exists = conn.execute(
                "SELECT 1 FROM assets WHERE installation_id=? AND asset_id=?",
                (installation_id, asset_id),
            ).fetchone()
            if exists:
                raise Conflict("asset already exists")
            conn.execute(
                "INSERT INTO assets(installation_id,asset_id,current_revision,"
                "active_revision,fields,content_hash,approved) VALUES "
                "(?,?,?,?,?,?,?)",
                (installation_id, asset_id, 1, 1 if approved else 0,
                 __import__("json").dumps(fields, sort_keys=True), h,
                 1 if approved else 0),
            )
        return self.get_asset(installation_id, asset_id)

    def approve_page(self, installation_id: str, asset_id: str) -> AssetView:
        a = self._row(installation_id, asset_id)
        self.store.execute(
            "UPDATE assets SET approved=1, active_revision=current_revision "
            "WHERE installation_id=? AND asset_id=?",
            (installation_id, asset_id),
        )
        self.store.commit()
        return self.get_asset(installation_id, asset_id)

    # -- §18 adapter interface --------------------------------------------
    def get_asset(self, installation_id: str, asset_id: str) -> AssetView:
        r = self._row(installation_id, asset_id)
        return AssetView(
            asset_id=r["asset_id"],
            current_revision=r["current_revision"],
            active_revision=r["active_revision"],
            fields=__import__("json").loads(r["fields"]),
            content_hash=r["content_hash"],
            approved=bool(r["approved"]),
        )

    def apply_patch(self, installation_id: str, asset_id: str,
                    expected_revision: int, fields: dict,
                    action_key: str) -> dict:
        """Atomic compare-and-set of all allowed fields (TI-08 conflict)."""
        self._check_fields(fields)
        with self.store.tx() as conn:
            # Idempotent receipt: same action_key returns the stored result.
            rec = conn.execute(
                "SELECT applied_revision,status FROM surface_receipts WHERE "
                "installation_id=? AND action_key=?",
                (installation_id, action_key),
            ).fetchone()
            if rec is not None:
                return {"status": rec["status"],
                        "applied_revision": rec["applied_revision"],
                        "idempotent_replay": True}
            row = conn.execute(
                "SELECT * FROM assets WHERE installation_id=? AND asset_id=?",
                (installation_id, asset_id),
            ).fetchone()
            if row is None:
                raise NotFound("asset")
            if row["current_revision"] != expected_revision:
                raise TargetRevisionConflict(
                    "expected revision does not match current",
                    expected=expected_revision, current=row["current_revision"],
                )
            merged = __import__("json").loads(row["fields"])
            merged.update(fields)
            new_rev = row["current_revision"] + 1
            h = canonical_hash(merged)
            conn.execute(
                "UPDATE assets SET current_revision=?, active_revision=?, "
                "fields=?, content_hash=? WHERE installation_id=? AND asset_id=?",
                (new_rev, new_rev if row["approved"] else row["active_revision"],
                 __import__("json").dumps(merged, sort_keys=True), h,
                 installation_id, asset_id),
            )
            conn.execute(
                "INSERT INTO surface_receipts(installation_id,action_key,"
                "asset_id,applied_revision,status,created_at) VALUES (?,?,?,?,?,?)",
                (installation_id, action_key, asset_id, new_rev, "applied",
                 now_iso()),
            )
        return {"status": "applied", "applied_revision": new_rev,
                "idempotent_replay": False}

    def get_receipt(self, installation_id: str, action_key: str) -> dict:
        r = self.store.execute(
            "SELECT * FROM surface_receipts WHERE installation_id=? AND "
            "action_key=?", (installation_id, action_key),
        ).fetchone()
        if r is None:
            return {"status": "not_found"}
        return {"status": r["status"], "applied_revision": r["applied_revision"],
                "asset_id": r["asset_id"]}

    def restore_patch(self, installation_id: str, asset_id: str,
                      expected_applied_revision: int, previous_fields: dict,
                      rollback_key: str) -> dict:
        """Atomic CAS restore; preserve unrelated edits (TI-08)."""
        with self.store.tx() as conn:
            rec = conn.execute(
                "SELECT applied_revision,status FROM surface_receipts WHERE "
                "installation_id=? AND action_key=?",
                (installation_id, rollback_key),
            ).fetchone()
            if rec is not None:
                return {"status": "applied",
                        "applied_revision": rec["applied_revision"],
                        "idempotent_replay": True}
            row = conn.execute(
                "SELECT * FROM assets WHERE installation_id=? AND asset_id=?",
                (installation_id, asset_id),
            ).fetchone()
            if row is None:
                raise NotFound("asset")
            if row["current_revision"] != expected_applied_revision:
                raise TargetRevisionConflict(
                    "asset changed since applied revision; manual resolution",
                    expected=expected_applied_revision,
                    current=row["current_revision"],
                )
            merged = __import__("json").loads(row["fields"])
            merged.update(previous_fields)
            new_rev = row["current_revision"] + 1
            conn.execute(
                "UPDATE assets SET current_revision=?, active_revision=?, "
                "fields=?, content_hash=? WHERE installation_id=? AND asset_id=?",
                (new_rev, new_rev if row["approved"] else row["active_revision"],
                 __import__("json").dumps(merged, sort_keys=True),
                 canonical_hash(merged), installation_id, asset_id),
            )
            conn.execute(
                "INSERT INTO surface_receipts(installation_id,action_key,"
                "asset_id,applied_revision,status,created_at) VALUES (?,?,?,?,?,?)",
                (installation_id, rollback_key, asset_id, new_rev, "applied",
                 now_iso()),
            )
        return {"status": "applied", "applied_revision": new_rev,
                "idempotent_replay": False}

    # -- public read (active revision only) -------------------------------
    def public_render(self, installation_id: str, asset_id: str) -> dict:
        r = self._row(installation_id, asset_id)
        if not r["approved"]:
            raise NotFound("no public (approved) revision")
        return {"asset_id": asset_id, "revision": r["active_revision"],
                "fields": __import__("json").loads(r["fields"])}

    # -- helpers ----------------------------------------------------------
    def _row(self, installation_id: str, asset_id: str):
        r = self.store.execute(
            "SELECT * FROM assets WHERE installation_id=? AND asset_id=?",
            (installation_id, asset_id),
        ).fetchone()
        if r is None:
            raise NotFound("asset")
        return r

    @staticmethod
    def _check_fields(fields: dict):
        if not isinstance(fields, dict) or not fields:
            raise Invalid("fields must be a non-empty object")
        bad = FORBIDDEN_PATCH_FIELDS & set(fields)
        if bad:
            raise Invalid(f"fields out of scope for v1 automation: {sorted(bad)}")
        unknown = set(fields) - ALLOWED_PATCH_FIELDS
        if unknown:
            raise Invalid(f"fields not in allowlist: {sorted(unknown)}")


# --- native measurement (§18) --------------------------------------------
def record_outcome(store: Store, installation_id: str, outcome_id: str,
                   denominator: str, *, variant: str | None = None,
                   revision_id: str | None = None, conversion: str | None = None):
    """Deduplicated first-party outcome ingestion (pseudonymous outcome id)."""
    try:
        with store.tx() as conn:
            conn.execute(
                "INSERT INTO outcomes(installation_id,outcome_id,variant,"
                "revision_id,denominator,conversion,created_at) VALUES "
                "(?,?,?,?,?,?,?)",
                (installation_id, outcome_id, variant, revision_id,
                 denominator, conversion, now_iso()),
            )
        return True
    except Exception:  # duplicate outcome id -> ignore (dedup)
        return False


def measurement_report(store: Store, installation_id: str) -> dict:
    rows = store.execute(
        "SELECT denominator, conversion, variant, revision_id FROM outcomes "
        "WHERE installation_id=?", (installation_id,),
    ).fetchall()
    eligible = sum(1 for r in rows if r["conversion"] is None)
    conversions = sum(1 for r in rows if r["conversion"] is not None)
    rate = (conversions / eligible) if eligible else None
    return {
        "eligible_sessions": eligible,
        "conversions": conversions,
        "conversion_rate": rate,
        "sample_status": "sufficient" if eligible >= 1 else "insufficient",
    }
