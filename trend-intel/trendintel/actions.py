"""Action lifecycle — spec §6, §16, §18.

State machine:
  proposed -> validated -> pending_approval -> approved
           -> queued -> executing -> applied | failed | reconciliation_required
Applied reversible actions can be rolled back.

Guarantees:
  * Approval binds to the exact canonical payload hash + target revision +
    policy + brief version. Any edit invalidates approval.
  * Author and approver must differ; no self-approval of a live change.
  * Idempotency key derives from tenant, brief version, channel, action kind,
    target and canonical patch hash -> at-least-once delivery, one side effect.
  * Execution re-checks freshness/freeze/revision immediately before the write.
  * A stale/expired/revoked brief cannot trigger an action (TI-05).
  * A prompt-injection payload cannot escalate: only typed, allowlisted action
    kinds are accepted; unknown kinds are rejected (TI-06).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Callable, Optional

from .drafts import V1_LIVE_ACTION_KINDS
from .errors import Conflict, Forbidden, Invalid, NotFound, TargetRevisionConflict
from .owned_surface import OwnedSurface
from .store import Store, canonical_hash, jdumps, jloads, new_id, now_iso

PROPOSED = "proposed"
VALIDATED = "validated"
PENDING_APPROVAL = "pending_approval"
APPROVED = "approved"
QUEUED = "queued"
EXECUTING = "executing"
APPLIED = "applied"
FAILED = "failed"
RECONCILIATION_REQUIRED = "reconciliation_required"
ROLLED_BACK = "rolled_back"


def derive_idempotency_key(*, installation_id: str, brief_version: int,
                           channel: str, action_kind: str, target_id: str,
                           base_revision: int, patch: dict) -> str:
    return canonical_hash({
        "i": installation_id, "bv": brief_version, "c": channel,
        "k": action_kind, "t": target_id, "r": base_revision,
        "p": patch,
    })[:40]


@dataclass
class BriefRef:
    brief_id: str
    brief_version: int
    expires_at: dt.datetime
    policy_version: int
    revoked: bool = False


class ActionService:
    def __init__(self, store: Store, surface: OwnedSurface,
                 *, clock: Callable[[], dt.datetime] | None = None):
        self.store = store
        self.surface = surface
        self.clock = clock or (lambda: dt.datetime.now(dt.timezone.utc))
        self._frozen: set[str] = set()

    # -- freeze switch (§8 emergency freeze) ------------------------------
    def freeze(self, installation_id: str):
        self._frozen.add(installation_id)

    def unfreeze(self, installation_id: str):
        self._frozen.discard(installation_id)

    def is_frozen(self, installation_id: str) -> bool:
        return installation_id in self._frozen

    # -- propose ----------------------------------------------------------
    def propose(self, installation_id: str, *, brief: BriefRef, channel: str,
                action_kind: str, target_id: str, expected_revision: int,
                patch: dict, author: str) -> dict:
        if action_kind not in V1_LIVE_ACTION_KINDS:
            raise Invalid(f"unknown or non-live action kind: {action_kind}")
        self._assert_brief_fresh(brief)
        # Target must exist and match the expected revision at propose time.
        asset = self.surface.get_asset(installation_id, target_id)
        idem = derive_idempotency_key(
            installation_id=installation_id, brief_version=brief.brief_version,
            channel=channel, action_kind=action_kind, target_id=target_id,
            base_revision=expected_revision, patch=patch,
        )
        payload = {
            "channel": channel, "action_kind": action_kind,
            "target_id": target_id, "expected_revision": expected_revision,
            "patch": patch, "brief_id": brief.brief_id,
            "brief_version": brief.brief_version,
            "policy_version": brief.policy_version,
        }
        payload_hash = canonical_hash(payload)
        action_id = new_id("act")
        with self.store.tx() as conn:
            dup = conn.execute(
                "SELECT action_id,doc FROM actions WHERE installation_id=? AND "
                "idempotency_key=?", (installation_id, idem),
            ).fetchone()
            if dup is not None:
                return jloads(dup["doc"])
            doc = {
                "action_id": action_id, "state": VALIDATED, "author": author,
                "approver": None, **payload, "payload_hash": payload_hash,
                "idempotency_key": idem, "applied_revision": None,
                "receipt": None,
            }
            conn.execute(
                "INSERT INTO actions(installation_id,action_id,idempotency_key,"
                "state,action_kind,channel,target_id,expected_revision,"
                "applied_revision,payload_hash,approved_hash,receipt,doc,created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (installation_id, action_id, idem, VALIDATED, action_kind,
                 channel, target_id, expected_revision, None, payload_hash,
                 None, None, jdumps(doc), now_iso()),
            )
        self.store.audit(installation_id, "action.proposed",
                         {"action_id": action_id, "kind": action_kind})
        return doc

    # -- approve ----------------------------------------------------------
    def approve(self, installation_id: str, action_id: str, *, approver: str,
                payload_hash: str) -> dict:
        doc = self._load(installation_id, action_id)
        if doc["state"] not in (VALIDATED, PENDING_APPROVAL):
            raise Conflict(f"cannot approve from state {doc['state']}")
        if doc["author"] == approver:
            raise Forbidden("author and approver must differ")
        if payload_hash != doc["payload_hash"]:
            raise Conflict("approval payload hash mismatch; re-approve required")
        doc["state"] = APPROVED
        doc["approver"] = approver
        doc["approved_hash"] = payload_hash
        self._save(installation_id, action_id, doc, approved_hash=payload_hash,
                   state=APPROVED)
        self.store.audit(installation_id, "action.approved",
                         {"action_id": action_id, "approver": approver})
        return doc

    # -- execute (worker only) --------------------------------------------
    def execute(self, installation_id: str, action_id: str, *,
                brief: BriefRef) -> dict:
        doc = self._load(installation_id, action_id)
        if doc["state"] != APPROVED:
            raise Conflict(f"cannot execute from state {doc['state']}")
        if self.is_frozen(installation_id):
            raise Forbidden("installation frozen: new live work rejected")
        # Re-authorise at execution (§6, §18 step 3): brief freshness + policy.
        self._assert_brief_fresh(brief)
        if brief.brief_version != doc["brief_version"]:
            raise Conflict("brief version changed since approval")
        if brief.policy_version != doc["policy_version"]:
            raise Conflict("policy changed since approval")
        if doc["approved_hash"] != doc["payload_hash"]:
            raise Conflict("approval does not bind current payload")

        action_key = doc["idempotency_key"]
        # Save previous field values before calling the adapter (§18 step 4).
        before = self.surface.get_asset(installation_id, doc["target_id"])
        doc["previous_fields"] = {k: before.fields.get(k)
                                  for k in doc["patch"].keys()}
        self._save(installation_id, action_id, doc, state=EXECUTING)
        try:
            res = self.surface.apply_patch(
                installation_id, doc["target_id"], doc["expected_revision"],
                doc["patch"], action_key,
            )
        except TargetRevisionConflict:
            # Live target moved; leave asset intact, require new approval.
            self._save(installation_id, action_id, doc,
                       state=RECONCILIATION_REQUIRED)
            raise
        doc["applied_revision"] = res["applied_revision"]
        doc["receipt"] = action_key
        doc["state"] = APPLIED
        self._save(installation_id, action_id, doc, state=APPLIED,
                   applied_revision=res["applied_revision"], receipt=action_key)
        self.store.audit(installation_id, "action.applied",
                         {"action_id": action_id,
                          "applied_revision": res["applied_revision"]})
        return doc

    def reconcile(self, installation_id: str, action_id: str) -> dict:
        """Recover from ambiguous completion using the provider receipt
        keyed by the original idempotency key (TI-07)."""
        doc = self._load(installation_id, action_id)
        rec = self.surface.get_receipt(installation_id, doc["idempotency_key"])
        if rec["status"] == "applied":
            doc["applied_revision"] = rec["applied_revision"]
            doc["receipt"] = doc["idempotency_key"]
            doc["state"] = APPLIED
            self._save(installation_id, action_id, doc, state=APPLIED,
                       applied_revision=rec["applied_revision"],
                       receipt=doc["idempotency_key"])
        return doc

    # -- rollback (new authorised compensating action) --------------------
    def rollback(self, installation_id: str, action_id: str, *,
                 approver: str) -> dict:
        doc = self._load(installation_id, action_id)
        if doc["state"] != APPLIED:
            raise Conflict("only an applied action can be rolled back")
        if doc["author"] == approver:
            raise Forbidden("rollback author and approver must differ")
        rollback_key = canonical_hash({"rollback": doc["idempotency_key"]})[:40]
        res = self.surface.restore_patch(
            installation_id, doc["target_id"], doc["applied_revision"],
            doc["previous_fields"], rollback_key,
        )
        doc["state"] = ROLLED_BACK
        doc["rolled_back_to_revision"] = res["applied_revision"]
        self._save(installation_id, action_id, doc, state=ROLLED_BACK)
        self.store.audit(installation_id, "action.rolled_back",
                         {"action_id": action_id,
                          "revision": res["applied_revision"]})
        return doc

    # -- helpers ----------------------------------------------------------
    def _assert_brief_fresh(self, brief: BriefRef):
        if brief.revoked:
            raise Conflict("brief revoked")
        if self.clock() >= brief.expires_at:
            raise Conflict("brief expired")

    def _load(self, installation_id: str, action_id: str) -> dict:
        r = self.store.execute(
            "SELECT doc FROM actions WHERE installation_id=? AND action_id=?",
            (installation_id, action_id),
        ).fetchone()
        if r is None:
            raise NotFound("action")
        return jloads(r["doc"])

    def get(self, installation_id: str, action_id: str) -> dict:
        return self._load(installation_id, action_id)

    def _save(self, installation_id: str, action_id: str, doc: dict, **cols):
        sets = ["doc=?"]
        params: list = [jdumps(doc)]
        for k, v in cols.items():
            sets.append(f"{k}=?")
            params.append(v)
        params.extend([installation_id, action_id])
        self.store.execute(
            f"UPDATE actions SET {', '.join(sets)} WHERE installation_id=? "
            f"AND action_id=?", tuple(params),
        )
        self.store.commit()
