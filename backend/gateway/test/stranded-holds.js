// STRANDED HOLDS test — a reservation left behind by a process killed mid-request
// (a restart/outage during a search) must not permanently lock paid ACU. The
// stranded-hold guard auto-releases any hold with no timestamp (pre-guard /
// killed) or older than HOLD_MAX_AGE_MS, so `spendable` returns to the gross
// paid balance and the next search can run. Run: node test/stranded-holds.js
import fs from 'node:fs';

const STORE = '/tmp/nf-stranded-holds.json';
// Seed a wallet that shows 161 paid but has 125 locked in a stranded, timestamp-
// less hold — exactly the state that refuses a 125 search while the dashboard
// still reads "161 paid".
fs.writeFileSync(STORE, JSON.stringify({
  wallets: {
    op_stranded: { paid: 161, free: 100, held: 125, holds: { stuck: 125 }, ledger: [], createdAt: Date.now() },
  },
  idempotency: {},
}));
process.env.STORE_BACKEND = 'file';
process.env.WALLET_STORE = STORE;
delete process.env.WALLET_STORE_KEY; // plaintext store for the test

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

const W = await import('../src/wallet.js');
const U = 'op_stranded';

console.log('— a stranded hold self-heals on read —');
const w = W.getWallet(U);
check('stranded hold auto-released (held → 0)', w.held === 0, JSON.stringify(w));
check('spendable restored to full paid + free (261)', w.spendable === 261, JSON.stringify(w));
check('paid balance untouched (161)', w.paid === 161);

console.log('— a 125 paid search can now reserve —');
let reserved = false;
try { W.reserve({ user: U, amount: 125, key: 'search1' }); reserved = true; } catch (e) { reserved = false; }
check('reserve for a 125 search succeeds', reserved);
check('the fresh hold is timestamped and NOT swept (held 125)', W.getWallet(U).held === 125);

console.log('— a settled hold clears cleanly —');
W.settleHold({ user: U, key: 'search1', actual: 125, label: 'niche search', action: 'niche_search' });
const after = W.getWallet(U);
check('after settle: held 0, paid 36 (161 − 125)', after.held === 0 && after.paid === 36, JSON.stringify(after));

try { fs.unlinkSync(STORE); } catch {}
console.log(failures === 0 ? '\nSTRANDED HOLDS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
