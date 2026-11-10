"""Observation ingestion — spec §5 schema, §6 /observations:batch, TI-01.

Unique source-version key (installation, source_id, source_record_id,
revision) prevents replay inflation. Exact replay -> duplicate. Same key,
different content hash -> 409 conflict (a source version cannot be mutated
in place). A feed gap is unknown data, never zero.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Iterable

from .errors import Conflict, Invalid
from .store import Store, canonical_hash, now_iso

# Keys the observation schema carries (spec §5). PII text is rejected.
_REQUIRED = {"source_id", "source_record_id", "source_family", "observed_at",
             "metric", "value"}
_FORBIDDEN_PII = {"email", "phone", "full_name", "ip", "device_id"}


@dataclass
class BatchResult:
    accepted: int = 0
    duplicate: int = 0
    rejected: int = 0
    errors: list = None  # type: ignore

    def as_dict(self):
        return {
            "accepted": self.accepted,
            "duplicate": self.duplicate,
            "rejected": self.rejected,
            "errors": self.errors or [],
        }


def _validate_obs(obs: dict) -> str | None:
    if not isinstance(obs, dict):
        return "observation must be an object"
    missing = _REQUIRED - set(obs)
    if missing:
        return f"missing fields: {sorted(missing)}"
    if _FORBIDDEN_PII & set(obs):
        return "personally identifiable fields are rejected"
    if not isinstance(obs.get("revision", 1), int):
        return "revision must be an integer"
    return None


def ingest_batch(store: Store, installation_id: str,
                 observations: Iterable[dict],
                 *, registered_sources: set[str] | None = None) -> BatchResult:
    """§16: an invalid batch fails atomically; a valid batch returns counts.

    Returns accepted/duplicate/rejected. Atomic: if any item is structurally
    invalid, nothing is written (indexed validation errors are raised).
    """
    items = list(observations)
    if len(items) > 500:
        raise Invalid("batch exceeds 500 items")

    # Pre-validate the whole batch; invalid batch fails atomically (§16).
    errors = []
    for i, obs in enumerate(items):
        err = _validate_obs(obs)
        if err:
            errors.append({"index": i, "error": err})
        elif registered_sources is not None and obs["source_id"] not in registered_sources:
            errors.append({"index": i, "error": "unregistered source"})
    if errors:
        raise Invalid("batch validation failed", errors=errors)

    result = BatchResult(errors=[])
    with store.tx() as conn:
        for obs in items:
            revision = int(obs.get("revision", 1))
            key = (installation_id, obs["source_id"], obs["source_record_id"], revision)
            h = canonical_hash({k: v for k, v in obs.items()})
            existing = conn.execute(
                "SELECT obs_hash FROM observations WHERE installation_id=? AND "
                "source_id=? AND source_record_id=? AND revision=?", key,
            ).fetchone()
            if existing is not None:
                if existing["obs_hash"] == h:
                    result.duplicate += 1
                    continue
                # Same key, different content -> conflict (TI-01).
                raise Conflict(
                    "source version exists with a different content hash",
                    source_id=obs["source_id"],
                    source_record_id=obs["source_record_id"],
                    revision=revision,
                )
            conn.execute(
                "INSERT INTO observations(installation_id,source_id,"
                "source_record_id,revision,source_family,obs_hash,doc,ingested_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (installation_id, obs["source_id"], obs["source_record_id"],
                 revision, obs["source_family"], h,
                 __import__("json").dumps(obs, sort_keys=True), now_iso()),
            )
            result.accepted += 1
    return result


def list_observations(store: Store, installation_id: str) -> list[dict]:
    rows = store.execute(
        "SELECT * FROM observations WHERE installation_id=? ORDER BY ingested_at",
        (installation_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def independent_family_count(store: Store, installation_id: str,
                             topic_record_ids: Iterable[str]) -> int:
    """Count DISTINCT source families across the given records.

    Syndicated stories / mirrors share a family and count once (TI-04, TI-14):
    callers map syndicated copies to the same source_family before ingest, or
    pass the records and we count distinct families here.
    """
    ids = list(topic_record_ids)
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    rows = store.execute(
        f"SELECT DISTINCT source_family FROM observations WHERE installation_id=? "
        f"AND source_record_id IN ({placeholders})",
        (installation_id, *ids),
    ).fetchall()
    return len(rows)
