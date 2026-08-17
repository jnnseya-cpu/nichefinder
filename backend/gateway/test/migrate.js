// MIGRATE test — guest→account wallet migration invariants (unit, no network).
// Verifies real money bought as a guest moves into the account exactly once,
// welcome (free) ACUs are NOT migrated (no multi-grant farming), and the move
// is idempotent and side-effect-free for bogus sources.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = path.join(os.tmpdir(), 'nf-migrate-test');
process.env.WALLET_STORE = path.join(TMP, 'wallets.json');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

const { credit, migratePaid, getWallet, peekWallet, charge } = await import('../src/wallet.js');

const GUEST = 'op_guest1234567890';
const ACCT = 'op_acct1234567890';

console.log('— setup —');
credit({ user: GUEST, packageId: 'starter_5' }); // guest buys 500 ACU (also mints its welcome pool)
const g0 = getWallet(GUEST);
check('guest starts 500 paid + 100 free', g0.paid === 500 && g0.free === 100, JSON.stringify(g0));
const a0 = getWallet(ACCT);
check('account starts 0 paid + 100 free', a0.paid === 0 && a0.free === 100, JSON.stringify(a0));

console.log('— migrate —');
const r1 = migratePaid({ from: GUEST, to: ACCT });
check('reports 500 moved', r1.moved === 500, JSON.stringify(r1));
check('account now holds 500 paid', r1.wallet.paid === 500);
check('account keeps its OWN welcome free (not doubled)', r1.wallet.free === 100, JSON.stringify(r1.wallet));
check('guest paid is zeroed', peekWallet(GUEST).paid === 0);
check('guest welcome free untouched (per-identity)', peekWallet(GUEST).free === 100);

console.log('— idempotency & guards —');
const r2 = migratePaid({ from: GUEST, to: ACCT });
check('repeat move transfers 0 (idempotent)', r2.moved === 0 && r2.wallet.paid === 500, JSON.stringify(r2));
const r3 = migratePaid({ from: 'op_nobody00000000', to: ACCT });
check('unknown source moves 0', r3.moved === 0 && r3.wallet.paid === 500);
check('unknown source is NOT minted', peekWallet('op_nobody00000000') === null);
const r4 = migratePaid({ from: ACCT, to: ACCT });
check('same-id migrate is a no-op', r4.moved === 0 && r4.wallet.paid === 500);

console.log('— migrated ACU is real —');
const spent = charge({ user: ACCT, amount: 500, label: 'post-migrate spend' });
check('migrated ACU is spendable', spent.charged === 500 && spent.wallet.paid === 0);

console.log(failures === 0 ? '\nMIGRATE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
