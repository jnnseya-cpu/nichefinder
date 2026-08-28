// WALLET SQLITE BACKEND test — proves the sqlite store backend runs the real
// wallet.js money logic correctly, survives a "restart" (durability, including
// exactly-once settlement keys), and enforces the money invariants as DB
// constraints. Skips cleanly on Node < 22 (no node:sqlite). Run: node test/wallet-sqlite.js
import fs from 'node:fs';

try { (await import('node:module')).createRequire(import.meta.url)('node:sqlite'); }
catch { console.log('WALLET SQLITE: SKIPPED — node:sqlite unavailable (needs Node ≥ 22). Not a failure.'); process.exit(0); }

const DB = '/tmp/nf-wallet-sqlite.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.STORE_BACKEND = 'sqlite';
process.env.WALLET_DB = DB;
process.env.WALLET_STORE = '/tmp/nf-wallet-sqlite-unused.json';
process.env.WALLET_STORE_KEY = 'cd'.repeat(32);

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

const W = await import('../src/wallet.js');
const U = 'op_sqlitewallet01';

console.log('— money operations run on the sqlite backend —');
W.credit({ user: U, packageId: 'builder_10', idempotencyKey: 'stripe_buy_1' });       // +1100
check('credit lands (paid 1100)', W.getWallet(U).paid === 1100, JSON.stringify(W.getWallet(U)));
const c1 = W.charge({ user: U, amount: 100, label: 'gen', idempotencyKey: 'k_charge_1' });
check('charge debits (paid 1000)', W.getWallet(U).paid === 1000 && c1.charged === 100);
const c1replay = W.charge({ user: U, amount: 100, label: 'gen', idempotencyKey: 'k_charge_1' });
check('replayed charge does not double-debit (still 1000)', c1replay.replayed === true && W.getWallet(U).paid === 1000);
W.reserve({ user: U, amount: 60, key: 'h1' });
check('reserve holds funds (spendable drops, paid unchanged)', W.getWallet(U).paid === 1000 && W.getWallet(U).held === 60 && W.getWallet(U).spendable === 940 + 100);
const s1 = W.settleHold({ user: U, key: 'h1', actual: 40, label: 'gen' });
check('settle charges actual + releases the rest (paid 960, held 0)', s1.charged === 40 && W.getWallet(U).paid === 960 && W.getWallet(U).held === 0);
W.reserve({ user: U, amount: 30, key: 'h2' });
W.releaseHold({ user: U, key: 'h2' });
check('release returns held funds (paid 960, held 0)', W.getWallet(U).paid === 960 && W.getWallet(U).held === 0);
const cb = W.clawback({ user: U, amount: 200, reason: 'refund', idempotencyKey: 'stripe_refund_1' });
check('clawback reverses (paid 760)', cb.clawedBack === 200 && W.getWallet(U).paid === 760);

console.log('— ledger + guest migration —');
check('ledger recorded, newest-first', W.getLedger(U)[0].type === 'debit_reversal' && W.getLedger(U).length === 5, JSON.stringify(W.getLedger(U).map((e) => e.type)));
const G = 'op_sqliteguest01';
W.grant({ user: G, amount: 300, reason: 'guest topup' }); // simulate a guest with paid balance
const mv = W.migratePaid({ from: G, to: U });
check('guest balance migrates atomically (moved 300 → paid 1060)', mv.moved === 300 && W.getWallet(U).paid === 1060 && W.getWallet(G).paid === 0);

console.log('— DURABILITY: reload from the DB (simulated restart) —');
const { makeStoreBackend } = await import('../src/store/backend.js');
const fresh = makeStoreBackend({ dbPath: DB, storePath: process.env.WALLET_STORE });
const reloaded = fresh.load();
check('reloaded balance matches (paid 1060 survived restart)', reloaded.wallets[U].paid === 1060, JSON.stringify(reloaded.wallets[U] && { paid: reloaded.wallets[U].paid }));
check('reloaded ledger survived', (reloaded.wallets[U].ledger || []).length >= 6);
check('exactly-once keys survived restart (no replay re-charge)', reloaded.idempotency['stripe_buy_1'] != null && reloaded.idempotency['k_charge_1'] != null && reloaded.idempotency['stripe_refund_1'] != null);
check('migrated-out guest is durably zeroed', reloaded.wallets[G].paid === 0);

console.log('— DB constraints are the money law —');
const { createRequire } = await import('node:module');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const raw = new DatabaseSync(DB);
const neg = (() => { try { raw.prepare('UPDATE wallets SET paid=-5 WHERE user_id=?').run(U); return false; } catch { return true; } })();
check('DB rejects a negative balance (CHECK paid>=0)', neg);
const dup = (() => { try { raw.prepare('INSERT INTO idempotency(key,result_json,created_at) VALUES(?,?,?)').run('stripe_buy_1', '{}', 1); return false; } catch { return true; } })();
check('DB rejects a duplicate settlement key (exactly-once)', dup);
raw.close();

console.log(failures === 0 ? '\nWALLET SQLITE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
