"""Persistence and isolation — spec §8, §15.

SQLite reference backend. The *installation* is the v1 tenancy boundary;
installation_id is carried on every private row and every scoped accessor
requires it. A cross-installation id resolves as NotFound (404) — TI-02 at
the application layer.

Production isolation (spec §15 / [S17]) additionally uses PostgreSQL
row-level security with a non-BYPASSRLS runtime role and per-transaction
`SET LOCAL app.installation_id`. That is a database-enforced second layer;
this reference store proves the contract at the application layer and the
schema maps 1:1 onto the documented Postgres DDL.
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
import threading
import uuid
from typing import Any, Optional

from .errors import Conflict, NotFound

_SCHEMA = """
CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY,
  organisation    TEXT NOT NULL,
  platform_slug   TEXT NOT NULL,
  environment     TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'draft_only',
  disabled_at     TEXT,
  UNIQUE (organisation, platform_slug, environment)
);

CREATE TABLE IF NOT EXISTS profiles (
  installation_id TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 0,
  policy_version  INTEGER NOT NULL DEFAULT 1,
  doc             TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (installation_id, revision)
);

CREATE TABLE IF NOT EXISTS observations (
  installation_id  TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  source_family    TEXT NOT NULL,
  obs_hash         TEXT NOT NULL,
  doc              TEXT NOT NULL,
  ingested_at      TEXT NOT NULL,
  PRIMARY KEY (installation_id, source_id, source_record_id, revision)
);

CREATE TABLE IF NOT EXISTS idempotency (
  installation_id TEXT NOT NULL,
  op              TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (installation_id, op, key)
);

CREATE TABLE IF NOT EXISTS assets (
  installation_id  TEXT NOT NULL,
  asset_id         TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  active_revision  INTEGER NOT NULL,
  fields           TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  approved         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, asset_id)
);

CREATE TABLE IF NOT EXISTS briefs (
  installation_id TEXT NOT NULL,
  brief_id        TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 0,
  market          TEXT NOT NULL,
  locale          TEXT NOT NULL,
  topic_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  doc             TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (installation_id, brief_id, revision)
);

CREATE TABLE IF NOT EXISTS actions (
  installation_id  TEXT NOT NULL,
  action_id        TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  state            TEXT NOT NULL,
  action_kind      TEXT NOT NULL,
  channel          TEXT NOT NULL,
  target_id        TEXT,
  expected_revision INTEGER,
  applied_revision INTEGER,
  payload_hash     TEXT,
  approved_hash    TEXT,
  receipt          TEXT,
  doc              TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (installation_id, action_id),
  UNIQUE (installation_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS entitlements (
  installation_id TEXT PRIMARY KEY,
  plan            TEXT NOT NULL,
  plan_revision   INTEGER NOT NULL,
  status          TEXT NOT NULL,
  draft_cap       INTEGER NOT NULL,
  effective_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  installation_id TEXT NOT NULL,
  work_id         TEXT NOT NULL,
  sku             TEXT NOT NULL,
  state           TEXT NOT NULL,   -- reserved | settled | released
  period          TEXT NOT NULL,   -- UTC YYYY-MM
  created_at      TEXT NOT NULL,
  PRIMARY KEY (installation_id, work_id)
);

CREATE TABLE IF NOT EXISTS billing_events (
  provider_event_id TEXT PRIMARY KEY,
  installation_id   TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  plan              TEXT NOT NULL,
  applied           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  installation_id TEXT NOT NULL,
  outcome_id      TEXT NOT NULL,
  variant         TEXT,
  revision_id     TEXT,
  denominator     TEXT NOT NULL,
  conversion      TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (installation_id, outcome_id)
);

CREATE TABLE IF NOT EXISTS erasure_log (
  installation_id TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (installation_id, subject_id)
);

CREATE TABLE IF NOT EXISTS surface_receipts (
  installation_id  TEXT NOT NULL,
  action_key       TEXT NOT NULL,
  asset_id         TEXT NOT NULL,
  applied_revision INTEGER NOT NULL,
  status           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (installation_id, action_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  stage           TEXT NOT NULL,
  detail          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
"""


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Store:
    """Thread-safe SQLite store. One instance per process/test."""

    def __init__(self, path: str = ":memory:"):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._lock = threading.RLock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # -- low level ---------------------------------------------------------
    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def commit(self):
        with self._lock:
            self._conn.commit()

    def tx(self):
        return _Transaction(self)

    # -- installations -----------------------------------------------------
    def create_installation(self, organisation: str, platform_slug: str,
                            environment: str, mode: str = "draft_only") -> str:
        iid = new_id("inst")
        with self.tx() as c:
            try:
                c.execute(
                    "INSERT INTO installations(installation_id,organisation,"
                    "platform_slug,environment,mode) VALUES (?,?,?,?,?)",
                    (iid, organisation, platform_slug, environment, mode),
                )
            except sqlite3.IntegrityError:
                raise Conflict("installation already exists for this scope")
        return iid

    def get_installation(self, installation_id: str) -> dict:
        row = self.execute(
            "SELECT * FROM installations WHERE installation_id=?",
            (installation_id,),
        ).fetchone()
        if not row:
            raise NotFound("installation")
        return dict(row)

    def audit(self, installation_id: str, stage: str, detail: dict | str):
        self.execute(
            "INSERT INTO audit_events(installation_id,stage,detail,created_at)"
            " VALUES (?,?,?,?)",
            (installation_id, stage,
             detail if isinstance(detail, str) else json.dumps(detail, sort_keys=True),
             now_iso()),
        )
        self.commit()

    def audit_trail(self, installation_id: str) -> list[dict]:
        rows = self.execute(
            "SELECT * FROM audit_events WHERE installation_id=? ORDER BY seq",
            (installation_id,),
        ).fetchall()
        return [dict(r) for r in rows]


class _Transaction:
    def __init__(self, store: Store):
        self._store = store

    def __enter__(self):
        self._store._lock.acquire()
        self._store._conn.execute("BEGIN")
        return self._store._conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self._store._conn.commit()
            else:
                self._store._conn.rollback()
        finally:
            self._store._lock.release()
        return False


def jloads(s: str) -> Any:
    return json.loads(s)


def jdumps(o: Any) -> str:
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def canonical_hash(obj: Any) -> str:
    import hashlib
    return hashlib.sha256(jdumps(obj).encode("utf-8")).hexdigest()
