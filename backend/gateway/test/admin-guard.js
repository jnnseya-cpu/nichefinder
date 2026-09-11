import './isolate-stores.js'; // never touch live data/ files (must be first)
// SECURITY REGRESSION TEST — the admin gate must be CLOSED when ADMIN_API_KEY is
// unset, never open. Guards against the `undefined === undefined → true` bug that
// would let an unauthenticated caller mint unlimited ACU (money-printing).
// Run: node test/admin-guard.js
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18844';
process.env.WALLET_STORE = '/tmp/admin-guard-wallets.json';
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {} // start from a clean store every run
delete process.env.ADMIN_API_KEY;   // the dangerous condition: NO admin key set
delete process.env.ALLOW_FREE_AI;   // billing enforced (production default)

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const post = (p, body, headers = {}) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const VICTIM = 'op_guardaaaa0001';

console.log('— with NO ADMIN_API_KEY set, admin routes are CLOSED (not open) —');
// The money-printer: a grant (amount, no packageId) with NO admin header.
let res = await post('/v1/wallet/credit', { user: VICTIM, amount: 100000000 });
check('unauthenticated ACU grant is REFUSED (403)', res.status === 403, `got ${res.status}`);

// A forged/guessed header must also fail when no key is configured.
res = await post('/v1/wallet/credit', { user: VICTIM, amount: 100000000 }, { 'x-admin-key': 'anything' });
check('grant with a bogus key (no key configured) is REFUSED (403)', res.status === 403, `got ${res.status}`);

// And the balance must be untouched — nothing was minted.
res = await fetch(`${BASE}/v1/wallet?user=${VICTIM}`);
const w = await res.json().catch(() => ({}));
const paid = (w && (w.paid ?? (w.wallet && w.wallet.paid))) || 0;
check('victim wallet has ZERO paid ACU (nothing minted)', paid === 0, `paid=${paid}`);

// diag must also refuse without a key.
res = await fetch(`${BASE}/v1/admin/diag`);
check('diag refused without a key (403)', res.status === 403, `got ${res.status}`);

console.log('— once a key IS configured, a correct header works (gate not over-tightened) —');
process.env.ADMIN_API_KEY = 'adm_guard_live';
res = await post('/v1/wallet/credit', { user: VICTIM, amount: 500 }, { 'x-admin-key': 'adm_guard_live' });
check('grant with the correct key succeeds (200)', res.status === 200, `got ${res.status}`);
res = await post('/v1/wallet/credit', { user: VICTIM, amount: 500 }, { 'x-admin-key': 'wrong' });
check('grant with a wrong key still refused (403)', res.status === 403, `got ${res.status}`);

console.log(failures === 0 ? '\nADMIN-GUARD: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
