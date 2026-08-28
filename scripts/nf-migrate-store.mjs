// Niche Finder — money-store migration: flat-file wallets.json → SQLite.
// Reads the JSON wallet store (decrypting an NFE1 envelope with WALLET_STORE_KEY
// if needed), loads every wallet, ledger entry, hold and idempotency key into
// SQLite inside ONE transaction, and VERIFIES that counts and total balances
// match the source before committing. A mismatch rolls the whole thing back —
// the migration is all-or-nothing, and it never mutates the JSON source, so the
// file store stays intact as an instant rollback.
//
// CLI:  node scripts/nf-migrate-store.mjs <wallets.json> <out.db>
//       (WALLET_STORE_KEY=<64 hex> in the env if the store is encrypted)
// Requires Node ≥ 22 (built-in node:sqlite).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'gateway', 'src', 'store', 'schema.sql'), 'utf8');
const int = (v) => Math.trunc(Number(v) || 0);
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

function decryptEnvelope(envelope, keyHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex || '')) throw new Error('WALLET_STORE_KEY must be 64 hex chars to decrypt this store');
  const [magic, ivB64, tagB64, ctB64] = envelope.split(':');
  if (magic !== 'NFE1') throw new Error('not an NFE1 envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

export function readWalletStore(walletStore, keyHex = process.env.WALLET_STORE_KEY) {
  const raw = fs.readFileSync(walletStore, 'utf8');
  return JSON.parse(raw.startsWith('NFE1:') ? decryptEnvelope(raw, keyHex) : raw);
}

export async function migrateWalletStore({ walletStore, dbPath, keyHex = process.env.WALLET_STORE_KEY }) {
  const { DatabaseSync } = await import('node:sqlite'); // Node ≥22 only
  const store = readWalletStore(walletStore, keyHex);
  const wallets = store.wallets || {};
  const idem = store.idempotency || {};

  // Source totals, computed from the JSON, to verify against after load.
  const src = { wallets: 0, paid: 0, free: 0, ledger: 0, holds: 0, idem: Object.keys(idem).length };
  for (const w of Object.values(wallets)) {
    src.wallets++; src.paid += int(w.paid); src.free += int(w.free);
    src.ledger += (w.ledger || []).length; src.holds += Object.keys(w.holds || {}).length;
  }

  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  if (num(db.prepare('SELECT COUNT(*) c FROM wallets').get().c) > 0) {
    db.close(); throw new Error(`refusing to migrate into a non-empty database: ${dbPath}`);
  }

  const wIns = db.prepare(`INSERT INTO wallets (user_id,paid,free,held,frozen,plan_id,plan_status,plan_since,plan_renewed_at,plan_canceled_at,claimed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const lIns = db.prepare(`INSERT INTO ledger (user_id,ts,label,amt,type,pool,balance_before,balance_after,bracket_factor,reversal_requested,shortfall,reference_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const hIns = db.prepare(`INSERT INTO holds (user_id,key,amount,created_at) VALUES (?,?,?,?)`);
  const iIns = db.prepare(`INSERT INTO idempotency (key,result_json,created_at) VALUES (?,?,?)`);

  db.exec('BEGIN');
  try {
    for (const [uid, w] of Object.entries(wallets)) {
      const p = w.plan || {};
      wIns.run(uid, int(w.paid), int(w.free), int(w.held || 0), w.frozen ? 1 : 0,
        p.id ?? null, p.status ?? null, p.since ?? null, p.renewedAt ?? null, p.canceledAt ?? null,
        w.claimedBy ?? null, int(w.createdAt || Date.now()));
      for (const e of (w.ledger || [])) {
        lIns.run(uid, int(e.ts), e.t ?? null, int(e.amt), e.type ?? null, e.pool ?? null,
          e.balanceBefore ?? null, e.balanceAfter ?? null, e.bracketFactor ?? null,
          e.reversalRequested ?? null, e.shortfall ?? null, e.referenceId ?? null);
      }
      for (const [k, amt] of Object.entries(w.holds || {})) hIns.run(uid, k, int(amt), int(w.createdAt || Date.now()));
    }
    for (const [k, res] of Object.entries(idem)) iIns.run(k, JSON.stringify(res), Date.now());

    // VERIFY inside the transaction — commit only if the DB exactly matches source.
    const got = {
      wallets: num(db.prepare('SELECT COUNT(*) c FROM wallets').get().c),
      paid: num(db.prepare('SELECT COALESCE(SUM(paid),0) s FROM wallets').get().s),
      free: num(db.prepare('SELECT COALESCE(SUM(free),0) s FROM wallets').get().s),
      ledger: num(db.prepare('SELECT COUNT(*) c FROM ledger').get().c),
      holds: num(db.prepare('SELECT COUNT(*) c FROM holds').get().c),
      idem: num(db.prepare('SELECT COUNT(*) c FROM idempotency').get().c),
    };
    for (const k of Object.keys(src)) {
      if (got[k] !== src[k]) throw new Error(`verification failed on ${k}: source=${src[k]} db=${got[k]}`);
    }
    db.exec('COMMIT');
    db.close();
    return { ok: true, ...got };
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [walletStore, dbPath] = process.argv.slice(2);
  if (!walletStore || !dbPath) { console.error('usage: node scripts/nf-migrate-store.mjs <wallets.json> <out.db>'); process.exit(1); }
  migrateWalletStore({ walletStore, dbPath })
    .then((r) => { console.log('[migrate] OK — verified:', JSON.stringify(r)); })
    .catch((e) => { console.error('[migrate] FAILED (rolled back):', e.message); process.exit(1); });
}
