"""Platform profiles — spec §9, §14, §16.

A profile supplies offer/catalogue, audience, markets/locales, topic
vocabulary, capacity checks, approved claims and CTAs, channels, forbidden
topics, outcomes and permitted asset ids. Core services never branch on a
platform slug (§14 portability rule): all platform-specific behaviour is
data carried on the profile.

Profiles are immutable revisions; one active revision at a time.
"""
from __future__ import annotations

from .errors import NotFound
from .store import Store, jdumps, jloads, now_iso


def put_profile(store: Store, installation_id: str, doc: dict, *,
                policy_version: int = 1) -> int:
    """Save a new immutable profile revision and make it the active one."""
    with store.tx() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(revision),0) AS m FROM profiles WHERE "
            "installation_id=?", (installation_id,),
        ).fetchone()
        revision = row["m"] + 1
        conn.execute("UPDATE profiles SET active=0 WHERE installation_id=?",
                     (installation_id,))
        conn.execute(
            "INSERT INTO profiles(installation_id,revision,active,policy_version,"
            "doc,created_at) VALUES (?,?,1,?,?,?)",
            (installation_id, revision, policy_version, jdumps(doc), now_iso()),
        )
    return revision


def active_profile(store: Store, installation_id: str) -> dict:
    r = store.execute(
        "SELECT * FROM profiles WHERE installation_id=? AND active=1",
        (installation_id,),
    ).fetchone()
    if r is None:
        raise NotFound("active profile")
    doc = jloads(r["doc"])
    doc["_revision"] = r["revision"]
    doc["_policy_version"] = r["policy_version"]
    return doc


def fit_intent_for(profile: dict, topic: str) -> tuple[float, float]:
    """§17: fit and intent come from a verified per-profile mapping only.

    Inference may *suggest* values, but they take effect only from the
    verified mapping here. Unknown topics map to 0/0 (no fit).
    """
    m = profile.get("fit_map", {}).get(topic)
    if not m:
        return 0.0, 0.0
    return float(m.get("fit", 0.0)), float(m.get("intent", 0.0))
