-- Niche Finder — money-store schema (SQLite dialect, via Node's built-in
-- node:sqlite). Replaces the flat-file wallet store with an ACID, durably-
-- committed database. The invariants that were previously only enforced in JS
-- (never-negative balance, held ≤ paid, exactly-once settlement) become DB
-- constraints, so no code path — or future bug — can violate them.
--
-- Durability: WAL + synchronous=NORMAL survives a process crash with no lost
-- committed write (unlike the file store's 50 ms debounce window). synchronous=
-- FULL is available for maximum safety at some throughput cost.

PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

-- ── wallets: one row per operator/account ───────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  user_id           TEXT    PRIMARY KEY,
  paid              INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0),   -- spendable, never negative
  free              INTEGER NOT NULL DEFAULT 0 CHECK (free >= 0),   -- welcome pool (read-only for AI)
  held              INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),   -- in-flight reservations
  frozen            INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0,1)),
  plan_id           TEXT,
  plan_status       TEXT,
  plan_since        INTEGER,
  plan_renewed_at   INTEGER,
  plan_canceled_at  INTEGER,
  claimed_by        TEXT,                                           -- guest→account one-time claim
  created_at        INTEGER NOT NULL,
  CHECK (held <= paid)                                             -- can't reserve more than is owned
);

-- ── ledger: append-only money history (the audit trail) ─────────────────────
CREATE TABLE IF NOT EXISTS ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            TEXT    NOT NULL REFERENCES wallets(user_id) ON DELETE CASCADE,
  ts                 INTEGER NOT NULL,
  label              TEXT,
  amt                INTEGER NOT NULL,                              -- signed (+credit / −debit)
  type               TEXT,                                         -- credit_purchase, debit_action, …
  pool               TEXT,                                         -- paid | free
  balance_before     INTEGER,
  balance_after      INTEGER,
  bracket_factor     REAL,
  reversal_requested INTEGER,
  shortfall          INTEGER,
  reference_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_ts ON ledger(user_id, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_type    ON ledger(type);

-- ── holds: outstanding reservations (reserve → settle/release) ──────────────
CREATE TABLE IF NOT EXISTS holds (
  user_id     TEXT    NOT NULL REFERENCES wallets(user_id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ── idempotency: exactly-once settlement (webhook replay safety) ────────────
-- key is UNIQUE, so a duplicate settlement is a primary-key conflict the DB
-- rejects — the exactly-once guarantee stops being a hand-rolled map.
CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT    PRIMARY KEY,
  result_json TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency(created_at);

-- ── schema version, so future migrations are ordered + repeatable ───────────
CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT);
INSERT OR IGNORE INTO schema_meta(k, v) VALUES ('version', '1');

-- ── FOLLOW-ON (documented in docs/DB-MIGRATION.md; not yet migrated) ─────────
-- accounts(user_id PK, email UNIQUE, pw_hash, pw_salt, name, role, disabled,
--          avatar, created_at)  — from auth.json
-- sessions(token PK, user_id, created_at, expires_at)
-- referral_codes(user_id PK, code UNIQUE), referral_links(referee PK, referrer),
-- referral_awards(purchase_key PK, referrer, amount, reversed)  — from referrals.json
-- These move in phase 2; wallets (the money store) move first because they carry
-- the highest risk and gain the most from transactions + durability.
