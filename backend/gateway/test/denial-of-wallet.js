import './isolate-stores.js'; // never touch live data/ files (must be first)
// DENIAL-OF-WALLET test (A1 fix). A fresh guest wallet is minted with welcome ACU
// that can fund a Quick Preview — a real provider call. A script rotating guest
// wallet ids could otherwise farm unlimited free AI at the operator's cost. The
// circuit breaker caps FREE previews per IP (and globally); PAID previews bypass it.
// Run: node test/denial-of-wallet.js
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18855';
process.env.STRIPE_SECRET_KEY = 'sk_test_dow';     // flips billing enforcement on
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dow';
process.env.WALLET_STORE = '/tmp/dow-wallets.json';
process.env.ADMIN_API_KEY = 'adm_dow';
process.env.NF_FREE_PREVIEW_IP_MAX = '3';          // low, so the cap is exercised fast
process.env.NF_FREE_PREVIEW_GLOBAL_MAX = '1000';
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const preview = (user) => fetch(`${BASE}/v1/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, preview: true, messages: [{ role: 'user', content: 'quick niche idea' }] }) });

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

console.log('— a script rotating fresh guest wallet ids is capped per IP —');
// Each id is a brand-new guest wallet (100 welcome ACU, 0 paid) → every preview is
// FREE-funded. From one IP, only NF_FREE_PREVIEW_IP_MAX (3) may be served.
const results = [];
for (let i = 1; i <= 5; i++) {
  const r = await preview('op_dowguest' + String(i).padStart(4, '0'));
  results.push(r.status);
}
check('first 3 free previews (rotating guest ids) succeed', results.slice(0, 3).every((s) => s === 200), `statuses=${results}`);
check('4th free preview is REFUSED (429 free_preview_limit)', results[3] === 429, `status=${results[3]}`);
const body4 = await (await preview('op_dowguest0009')).json();
check('refusal carries code free_preview_limit', body4.error === 'free_preview_limit', JSON.stringify(body4).slice(0, 120));

console.log('— a PAID wallet bypasses the cap entirely (real customers unaffected) —');
// Fund a wallet with paid ACU; its previews are paid-funded, so the free cap (now
// exhausted for this IP) must NOT apply.
const PAID = 'op_dowpaid00001';
let r = await fetch(`${BASE}/v1/wallet/credit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'adm_dow' }, body: JSON.stringify({ user: PAID, amount: 500 }) });
check('funded a paid wallet (500 ACU)', r.status === 200);
const p1 = await preview(PAID);
const p2 = await preview(PAID);
check('paid wallet preview succeeds despite the IP free cap being exhausted', p1.status === 200 && p2.status === 200, `p1=${p1.status} p2=${p2.status}`);

console.log('— the guard did not corrupt billing: paid wallet was charged, not blocked —');
const w = await (await fetch(`${BASE}/v1/wallet?user=${PAID}`)).json();
check('paid wallet balance moved (previews were served + billed, not refused)', (w.paid ?? (w.wallet && w.wallet.paid)) < 500 || (w.free ?? (w.wallet && w.wallet.free)) < 100, JSON.stringify(w).slice(0, 140));

console.log(failures === 0 ? '\nDENIAL-OF-WALLET: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
