import './isolate-stores.js'; // never touch the live data/ files (must be first)
// QUICK PREVIEW test — the cheap teaser that WELCOME (free) ACU may fund, while
// the full search stays paid-only. Verifies: welcome ACU pay for a preview
// (drawn first), the fixed low price is charged server-side, welcome funds run
// out and then paid is required, and a full (non-preview) generation still
// refuses welcome ACU. Run: node test/preview.js
import http from 'node:http';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18831';
process.env.STRIPE_SECRET_KEY = 'sk_test_preview';        // flips billing enforcement on
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_preview';
process.env.WALLET_STORE = '/tmp/preview-wallets.json';
process.env.WALLET_STORE_KEY = 'ab'.repeat(32);
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));
const ECO = globalThis.NF_ECONOMY;
const PRICE = ECO.COSTS.quick_preview;
const WELCOME = ECO.WELCOME_FREE;
const U = 'op_' + 'pv7k2m9x1q'.repeat(2);
const post = (body) => fetch(`${BASE}/v1/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const walletOf = async () => (await (await fetch(`${BASE}/v1/wallet?user=${U}`)).json());

console.log(`— a fresh wallet (0 paid, ${WELCOME} welcome) can run a quick preview on welcome ACU —`);
let w = await walletOf();
check('fresh wallet has welcome ACU, 0 paid', w.free === WELCOME && w.paid === 0, JSON.stringify(w));

let res = await post({ user: U, preview: true, messages: [{ role: 'user', content: 'Quick niche idea for Lagos' }] });
let body = await res.json();
check('preview succeeds', res.status === 200 && body.preview === true, JSON.stringify(body).slice(0, 140));
check(`preview charged the fixed price (${PRICE})`, body.charged === PRICE, `charged=${body.charged}`);
check('preview was paid from WELCOME ACU (free drawn first)', body.fromFree === PRICE, `fromFree=${body.fromFree}`);
w = await walletOf();
check('welcome balance dropped, paid untouched', w.free === WELCOME - PRICE && w.paid === 0, JSON.stringify(w));

console.log('— welcome ACU keep funding previews until they run out, then paid is required —');
let n = 1; // already ran one
while (n < 20) { const r = await post({ user: U, preview: true, messages: [{ role: 'user', content: 'another' }] }); if (r.status !== 200) break; n++; }
w = await walletOf();
const maxPreviews = Math.floor(WELCOME / PRICE);
check(`ran ~${maxPreviews} welcome-funded previews then stopped`, n === maxPreviews, `ran=${n}`);
check('welcome ACU are used up (remainder < price)', w.free < PRICE && w.paid === 0, JSON.stringify(w));
res = await post({ user: U, preview: true, messages: [{ role: 'user', content: 'one more' }] });
check('next preview with no paid + insufficient welcome is refused (402)', res.status === 402, `status=${res.status}`);

console.log('— welcome ACU still CANNOT fund a full (non-preview) search —');
const U2 = 'op_' + 'zz3k2m9x1q'.repeat(2); // fresh: 100 welcome, 0 paid
res = await post({ user: U2, messages: [{ role: 'user', content: 'Full niche search' }], jsonSchema: { type: 'object' } });
check('full search on a welcome-only wallet is refused (402, read-only welcome)', res.status === 402, `status=${res.status}`);
const w2 = await (await fetch(`${BASE}/v1/wallet?user=${U2}`)).json();
check('welcome balance untouched by the refused search', w2.free === WELCOME && w2.paid === 0, JSON.stringify(w2));

console.log(failures === 0 ? '\nQUICK PREVIEW: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
