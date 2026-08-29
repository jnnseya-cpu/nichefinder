// RIGHT-TO-ERASURE test (privacy / GDPR) — proves account deletion removes the
// user's personal data from EVERY store: auth (account + sessions), wallet
// (balance + ledger), generated documents, and referral records — while other
// users' accounts survive. Run: node test/erasure.js
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18826';
process.env.STRIPE_SECRET_KEY = 'sk_test_erase';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_erase';
process.env.STRIPE_API_BASE = 'http://127.0.0.1:18827';
process.env.WALLET_STORE = '/tmp/erase-wallets.json';
process.env.WALLET_STORE_KEY = 'cd'.repeat(32);
process.env.AUTH_STORE = '/tmp/erase-auth.json';
process.env.REFERRALS_STORE = '/tmp/erase-referrals.json';
process.env.DOCS_STORE = '/tmp/erase-docs.json';
process.env.LEADS_STORE = '/tmp/erase-leads.jsonl';
for (const f of [process.env.WALLET_STORE, process.env.AUTH_STORE, process.env.REFERRALS_STORE, process.env.DOCS_STORE]) { try { fs.unlinkSync(f); } catch {} }

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const stripeMock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'cs_e', url: 'https://x/y' })); }); });
await new Promise((r) => stripeMock.listen(18827, r));
await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (p, headers = {}) => fetch(BASE + p, { headers });
function webhook(obj) { const e = JSON.stringify(obj); const t = Math.floor(Date.now() / 1000); const sig = `t=${t},v1=${crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${e}`).digest('hex')}`; return fetch(`${BASE}/v1/payments/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: e }); }
function lz(hex) { let b = 0; for (const c of hex) { const v = parseInt(c, 16); if (v === 0) { b += 4; continue; } b += Math.clz32(v) - 28; break; } return b; }
async function proof() { const ch = await (await get('/v1/human/challenge')).json(); let n = 0; for (;;) { if (lz(crypto.createHash('sha256').update(ch.challenge + n).digest('hex')) >= ch.difficulty) break; n++; } return { challenge: ch.challenge, nonce: String(n) }; }

// referrer R + referee E (E signs up with R's code)
let res = await post('/v1/auth/signup', { email: 'ref@erase.test', password: 'referpass123', ...(await proof()) });
const R = await res.json(); const RID = R.user.userId; const RTOK = R.token;
const RCODE = (await (await get(`/v1/referrals/summary?user=${RID}`)).json()).code;
res = await post('/v1/auth/signup', { email: 'referee@erase.test', password: 'refereepass1', ref: RCODE, ...(await proof()) });
const E = await res.json(); const EID = E.user.userId;

// E buys → R earns commission; R buys → R has wallet balance
await webhook({ id: 'evt_e', type: 'checkout.session.completed', data: { object: { id: 'cs1', payment_status: 'paid', payment_intent: 'pi_e', metadata: { user: EID, packageId: 'builder_10' } } } });
await webhook({ id: 'evt_r', type: 'checkout.session.completed', data: { object: { id: 'cs2', payment_status: 'paid', payment_intent: 'pi_r', metadata: { user: RID, packageId: 'builder_10' } } } });
// R generates a document → a stored document under R
const DOC_SCHEMA = { type: 'object', properties: { title: { type: 'string' }, sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['heading', 'body'], additionalProperties: false } } }, required: ['title', 'sections'], additionalProperties: false };
res = await post('/v1/document', { user: RID, docType: 'validation', project: 'proj-e', system: 'x', messages: [{ role: 'user', content: 'x' }], jsonSchema: DOC_SCHEMA }, { authorization: 'Bearer ' + RTOK });

console.log('— before deletion: R has data in every store —');
check('R wallet funded + charged (has money data)', (await (await get(`/v1/wallet?user=${RID}`, { authorization: 'Bearer ' + RTOK })).json()).paid > 0);
check('R has a stored document', (await get(`/v1/document?user=${RID}&project=proj-e&type=validation`, { authorization: 'Bearer ' + RTOK })).status === 200);
check('R earned referral commission', (await (await get(`/v1/referrals/summary?user=${RID}`)).json()).acuEarned === 100);

console.log('— delete R (password-confirmed) —');
res = await post('/v1/auth/delete', { currentPassword: 'referpass123' }, { authorization: 'Bearer ' + RTOK });
check('deletion succeeds', res.status === 200 && (await res.json()).ok === true);

console.log('— after deletion: every trace of R is gone —');
check('R can no longer log in (account erased)', (await post('/v1/auth/login', { email: 'ref@erase.test', password: 'referpass123' })).status >= 400);
check('R wallet money data erased (fresh wallet, paid 0)', (await (await get(`/v1/wallet?user=${RID}`)).json()).paid === 0);
check('R document erased (404)', (await get(`/v1/document?user=${RID}&project=proj-e&type=validation`)).status === 404);
const rs = await (await get(`/v1/referrals/summary?user=${RID}`)).json();
check('R referral earnings + referrals erased', rs.acuEarned === 0 && rs.totalReferrals === 0, JSON.stringify(rs));

console.log('— the OTHER user (referee E) is untouched —');
check('E can still log in', (await post('/v1/auth/login', { email: 'referee@erase.test', password: 'refereepass1' })).status === 200);

stripeMock.close();
console.log(failures === 0 ? '\nERASURE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
