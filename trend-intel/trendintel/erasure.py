"""Erasure and restore-replay — spec §15, TI-15.

An erasure request is logged (append-only) and the subject's evidence is
removed. After a backup restore, pending erasures are replayed so restored
backups do not re-expose deleted tenant evidence, and exports never include
an erased subject.
"""
from __future__ import annotations

from .store import Store, now_iso

# (table, subject column) pairs that hold erasable subject evidence.
_ERASABLE = [
    ("outcomes", "outcome_id"),
    ("observations", "source_record_id"),
]


def request_erasure(store: Store, installation_id: str, subject_id: str) -> dict:
    with store.tx() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO erasure_log(installation_id,subject_id,"
            "created_at) VALUES (?,?,?)",
            (installation_id, subject_id, now_iso()),
        )
    removed = _purge(store, installation_id, subject_id)
    return {"subject_id": subject_id, "removed": removed}


def _purge(store: Store, installation_id: str, subject_id: str) -> int:
    removed = 0
    with store.tx() as conn:
        for table, col in _ERASABLE:
            cur = conn.execute(
                f"DELETE FROM {table} WHERE installation_id=? AND {col}=?",
                (installation_id, subject_id),
            )
            removed += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    return removed


def replay_erasures(store: Store, installation_id: str) -> int:
    """Reapply every logged erasure (e.g. after a restore). Returns rows purged."""
    subjects = store.execute(
        "SELECT subject_id FROM erasure_log WHERE installation_id=?",
        (installation_id,),
    ).fetchall()
    total = 0
    for s in subjects:
        total += _purge(store, installation_id, s["subject_id"])
    return total


def is_erased(store: Store, installation_id: str, subject_id: str) -> bool:
    r = store.execute(
        "SELECT 1 FROM erasure_log WHERE installation_id=? AND subject_id=?",
        (installation_id, subject_id),
    ).fetchone()
    return r is not None


def export_outcomes(store: Store, installation_id: str) -> list[dict]:
    """Export excludes any erased subject (defence even if a purge was missed)."""
    rows = store.execute(
        "SELECT o.* FROM outcomes o WHERE o.installation_id=? AND o.outcome_id "
        "NOT IN (SELECT subject_id FROM erasure_log WHERE installation_id=?)",
        (installation_id, installation_id),
    ).fetchall()
    return [dict(r) for r in rows]
