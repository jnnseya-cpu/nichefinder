// DB-MIGRATION test — proves the flat-file → SQLite money-store migration is
// lossless, that the DB enforces the money invariants as constraints, and that
// it is all-or-nothing + rollback-safe. Skips cleanly on Node < 22 (no
// node:sqlite) so it never breaks the suite on the current production runtime.
// Run: node test/dbmigrate.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('DB MIGRATION: SKIPPED — node:sqlite unavailable (needs Node ≥ 22). Not a failure.'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { migrateWalletStore } = await import(path.join(ROOT, 'scripts', 'nf-migrate-store.mjs'));
const T = '/tmp/nf-dbmigrate-test';
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T, { recursive: true });
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

// Sample flat-file store: 2 wallets with ledgers, a hold, a plan, idempotency.
const store = {
  wallets: {
    op_alpha: {
      paid: 640, free: 100, held: 150, frozen: 0,
      plan: { id: 'pro', status: 'active', since: 111, renewedAt: 222 },
      createdAt: 1000,
      holds: { 'gen_x': 150 },
      ledger: [
        { t: 'TOP-UP · Builder', amt: 1100, ts: 1001, type: 'credit_purchase', pool: 'paid', balanceBefore: 0, balanceAfter: 1100, bracketFactor: 1 },
        { t: 'OPERATIONAL_TASK · generation', amt: -460, ts: 1002, type: 'debit_generation', pool: 'paid', balanceBefore: 1100, balanceAfter: 640, bracketFactor: 1, referenceId: 'ref9' },
      ],
    },
    op_bravo: { paid: 0, free: 100, frozen: 1, createdAt: 2000, ledger: [{ t: 'WELCOME', amt: 100, ts: 2000, type: 'credit_welcome', pool: 'free', balanceBefore: 0, balanceAfter: 100, bracketFactor: 1 }] },
  },
  idempotency: { 'stripe_evt_1': { credited: 1100 }, 'stripe_dispute_ch1': { clawedBack: 1100 } },
};
const JSONP = path.join(T, 'wallets.json');
fs.writeFileSync(JSONP, JSON.stringify(store));

// ── 1) lossless migration ──
console.log('— lossless migration (counts + balances verified) —');
const DB1 = path.join(T, 'money.db');
const r = await migrateWalletStore({ walletStore: JSONP, dbPath: DB1 });
check('migration reports ok with verified totals', r.ok && r.wallets === 2 && r.paid === 640 && r.free === 200 && r.ledger === 3 && r.holds === 1 && r.idem === 2, JSON.stringify(r));

const db = new DatabaseSync(DB1);
const alpha = db.prepare('SELECT * FROM wallets WHERE user_id=?').get('op_alpha');
check('wallet row migrated with exact balances + plan + held', alpha.paid === 640 && alpha.free === 100 && alpha.held === 150 && alpha.plan_id === 'pro', JSON.stringify(alpha));
check('frozen flag migrated', db.prepare('SELECT frozen FROM wallets WHERE user_id=?').get('op_bravo').frozen === 1);
check('ledger rows migrated per user', Number(db.prepare('SELECT COUNT(*) c FROM ledger WHERE user_id=?').get('op_alpha').c) === 2);
check('reference_id preserved on the debit', db.prepare('SELECT reference_id FROM ledger WHERE reference_id=?').get('ref9') != null);
check('hold migrated', db.prepare('SELECT amount FROM holds WHERE user_id=? AND key=?').get('op_alpha', 'gen_x').amount === 150);
check('idempotency keys migrated (settlement replay safety)', Number(db.prepare('SELECT COUNT(*) c FROM idempotency').get().c) === 2);

// ── 2) DB enforces the money invariants ──
console.log('— DB constraints enforce the money law —');
const negRejected = (() => { try { db.prepare('UPDATE wallets SET paid=-1 WHERE user_id=?').run('op_alpha'); return false; } catch { return true; } })();
check('a negative balance is rejected by the DB (CHECK paid>=0)', negRejected);
const overHold = (() => { try { db.prepare('UPDATE wallets SET held=paid+1 WHERE user_id=?').run('op_alpha'); return false; } catch { return true; } })();
check('held > paid is rejected by the DB (CHECK held<=paid)', overHold);
const dupIdem = (() => { try { db.prepare('INSERT INTO idempotency(key,result_json,created_at) VALUES(?,?,?)').run('stripe_evt_1', '{}', 1); return false; } catch { return true; } })();
check('duplicate settlement key is rejected (PK) — exactly-once enforced', dupIdem);
db.close();

// ── 3) all-or-nothing: refuse migrating into a non-empty DB ──
console.log('— rollback safety —');
let refused = false;
try { await migrateWalletStore({ walletStore: JSONP, dbPath: DB1 }); } catch { refused = true; }
check('re-migrating into a populated DB is refused (no double-load)', refused);
check('JSON source is untouched (instant rollback path intact)', JSON.parse(fs.readFileSync(JSONP, 'utf8')).wallets.op_alpha.paid === 640);

// ── 4) encrypted-store round-trip ──
console.log('— encrypted (NFE1) store migrates with the key —');
const keyHex = 'ab'.repeat(32);
function encrypt(json, keyHex) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return `NFE1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
const ENCP = path.join(T, 'wallets.enc.json'); fs.writeFileSync(ENCP, encrypt(JSON.stringify(store), keyHex));
const DB2 = path.join(T, 'money2.db');
const r2 = await migrateWalletStore({ walletStore: ENCP, dbPath: DB2, keyHex });
check('encrypted store decrypts + migrates losslessly', r2.ok && r2.paid === 640 && r2.wallets === 2, JSON.stringify(r2));
let wrongKey = false;
try { await migrateWalletStore({ walletStore: ENCP, dbPath: path.join(T, 'x.db'), keyHex: 'cd'.repeat(32) }); } catch { wrongKey = true; }
check('wrong key is refused (auth-tag failure), not silently mis-migrated', wrongKey);

fs.rmSync(T, { recursive: true, force: true });
console.log(failures === 0 ? '\nDB MIGRATION: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
