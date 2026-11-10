"""Commercial control plane — spec §19.

Entitlements, metering and billing reconciliation. No payment-provider
integration is wired (admin-managed entitlements for v1 pilots); the billing
adapter here is the reconciliation contract, not a live gateway.

Metering rule (§19): count one completed draft per unique logical generation
id, never attempts or template fallback. Reserve atomically before
generation, settle once on successful persist, release on final
failure/expiry. Hard caps by default; 429 at quota.

Billing reconciliation (§19, TI-13): verified events carry unique provider
event ids and a sequence. Late events cannot overwrite a more recent
provider state. Provisioning is idempotent by provider event id.
"""
from __future__ import annotations

import datetime as dt

from .errors import NotFound, QuotaExceeded
from .store import Store, now_iso

TRIAL = "trial"
ACTIVE = "active"
GRACE = "grace"
SUSPENDED = "suspended"
ENDED = "ended"

RESERVED = "reserved"
SETTLED = "settled"
RELEASED = "released"

# States where live/generation work is allowed.
_WRITE_OK = {TRIAL, ACTIVE}
_GENERATE_OK = {TRIAL, ACTIVE}
# Suspended/grace/ended -> read/export/rollback only.


def _period(now: dt.datetime | None = None) -> str:
    now = now or dt.datetime.now(dt.timezone.utc)
    return now.strftime("%Y-%m")


def provision(store: Store, installation_id: str, *, plan: str, draft_cap: int,
              status: str = ACTIVE, plan_revision: int = 1) -> dict:
    store.execute(
        "INSERT INTO entitlements(installation_id,plan,plan_revision,status,"
        "draft_cap,effective_at) VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(installation_id) DO UPDATE SET plan=excluded.plan,"
        "plan_revision=excluded.plan_revision,status=excluded.status,"
        "draft_cap=excluded.draft_cap,effective_at=excluded.effective_at",
        (installation_id, plan, plan_revision, status, draft_cap, now_iso()),
    )
    store.commit()
    return get(store, installation_id)


def get(store: Store, installation_id: str) -> dict:
    r = store.execute(
        "SELECT * FROM entitlements WHERE installation_id=?", (installation_id,),
    ).fetchone()
    if r is None:
        raise NotFound("entitlement")
    return dict(r)


def can_generate(store: Store, installation_id: str) -> bool:
    return get(store, installation_id)["status"] in _GENERATE_OK


def can_write(store: Store, installation_id: str) -> bool:
    return get(store, installation_id)["status"] in _WRITE_OK


def set_status(store: Store, installation_id: str, status: str):
    store.execute("UPDATE entitlements SET status=? WHERE installation_id=?",
                  (status, installation_id))
    store.commit()


# --- metering ------------------------------------------------------------
def _used(conn, installation_id: str, period: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE installation_id=? AND "
        "period=? AND state IN (?,?)",
        (installation_id, period, RESERVED, SETTLED),
    ).fetchone()
    return row["n"]


def reserve_draft(store: Store, installation_id: str, work_id: str,
                  *, sku: str = "draft", now: dt.datetime | None = None) -> dict:
    """Atomically reserve one unit against the cap. QuotaExceeded at the cap.

    Concurrency-safe (TI-09): the unique (installation, work_id) PK plus the
    single-writer transaction mean two concurrent reservations for the same
    final unit cannot both succeed.
    """
    if not can_generate(store, installation_id):
        raise QuotaExceeded("generation disabled for current entitlement status")
    ent = get(store, installation_id)
    period = _period(now)
    with store.tx() as conn:
        # Idempotent: a repeated work_id returns its current state.
        existing = conn.execute(
            "SELECT state FROM usage_ledger WHERE installation_id=? AND work_id=?",
            (installation_id, work_id),
        ).fetchone()
        if existing is not None:
            return {"work_id": work_id, "state": existing["state"],
                    "idempotent": True}
        if _used(conn, installation_id, period) >= ent["draft_cap"]:
            raise QuotaExceeded(
                "draft cap reached",
                reset=f"{period}-01 next month", cap=ent["draft_cap"],
            )
        conn.execute(
            "INSERT INTO usage_ledger(installation_id,work_id,sku,state,period,"
            "created_at) VALUES (?,?,?,?,?,?)",
            (installation_id, work_id, sku, RESERVED, period, now_iso()),
        )
    return {"work_id": work_id, "state": RESERVED, "idempotent": False}


def settle_draft(store: Store, installation_id: str, work_id: str):
    """Settle once, on successful persist of a real generated draft."""
    store.execute(
        "UPDATE usage_ledger SET state=? WHERE installation_id=? AND work_id=? "
        "AND state=?", (SETTLED, installation_id, work_id, RESERVED),
    )
    store.commit()


def release_draft(store: Store, installation_id: str, work_id: str):
    """Release on final failure / expiry / template fallback (not billed)."""
    store.execute(
        "UPDATE usage_ledger SET state=? WHERE installation_id=? AND work_id=? "
        "AND state=?", (RELEASED, installation_id, work_id, RESERVED),
    )
    store.commit()


def usage(store: Store, installation_id: str, now: dt.datetime | None = None) -> dict:
    period = _period(now)
    with store.tx() as conn:
        used = _used(conn, installation_id, period)
    ent = get(store, installation_id)
    return {"period": period, "used": used, "cap": ent["draft_cap"],
            "remaining": max(0, ent["draft_cap"] - used)}


# --- billing reconciliation (TI-13) --------------------------------------
def apply_billing_event(store: Store, installation_id: str, *,
                        provider_event_id: str, seq: int, plan: str) -> dict:
    """Record a verified provider event and reconcile to the newest state.

    Idempotent by provider_event_id. A late (lower-seq) event is recorded but
    never overwrites a more recent applied state.
    """
    with store.tx() as conn:
        dup = conn.execute(
            "SELECT applied FROM billing_events WHERE provider_event_id=?",
            (provider_event_id,),
        ).fetchone()
        if dup is not None:
            return {"provider_event_id": provider_event_id, "duplicate": True}
        max_seq = conn.execute(
            "SELECT COALESCE(MAX(seq), -1) AS m FROM billing_events WHERE "
            "installation_id=? AND applied=1", (installation_id,),
        ).fetchone()["m"]
        is_newer = seq > max_seq
        conn.execute(
            "INSERT INTO billing_events(provider_event_id,installation_id,seq,"
            "plan,applied,created_at) VALUES (?,?,?,?,?,?)",
            (provider_event_id, installation_id, seq, plan,
             1 if is_newer else 0, now_iso()),
        )
        if is_newer:
            conn.execute(
                "UPDATE entitlements SET plan=?, plan_revision=plan_revision+1 "
                "WHERE installation_id=?", (plan, installation_id),
            )
    return {"provider_event_id": provider_event_id, "applied": is_newer,
            "duplicate": False}
