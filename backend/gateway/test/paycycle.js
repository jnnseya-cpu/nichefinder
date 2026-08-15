// FULL PAYMENT CYCLE test — the launch-night proof.
// Boots the gateway with billing ENFORCED (test Stripe keys + local Stripe
// mock), then walks the entire money path a real customer takes:
//   checkout session → Stripe settlement webhook (HMAC-signed) → exactly-once
//   ACU credit → server-metered generation debits → overdraft refusal →
//   client-credit lockout → encrypted store on disk.
// Run: node test/paycycle.js   (exits non-zero on any failure)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18790';
process.env.STRIPE_SECRET_KEY = 'sk_test_paycycle';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_paycycle_secret';
process.env.STRIPE_API_BASE = 'http://127.0.0.1:18791';
process.env.WALLET_STORE = '/tmp/paycycle-wallets.json';
process.env.WALLET_STORE_KEY = 'cd'.repeat(32);
process.env.ADMIN_API_KEY = 'adm_paycycle';
process.env.LEADS_STORE = '/tmp/paycycle-leads.jsonl';
process.env.DOCS_STORE = '/tmp/paycycle-docs.json';
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}
try { fs.unlinkSync(process.env.DOCS_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

// ---- local Stripe mock: accepts checkout-session creation like the real API ----
const stripeMock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const params = new URLSearchParams(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      metadata: { user: params.get('metadata[user]'), packageId: params.get('metadata[packageId]') },
      amount_total: Number(params.get('line_items[0][price_data][unit_amount]')),
    }));
  });
});
await new Promise((r) => stripeMock.listen(18791, r));

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const USER = 'op_' + 'k9f3m1x7q2'.repeat(2); // capability-format test id
const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

console.log('— payments live: enforcement flips on —');
let res = await fetch(`${BASE}/v1/health`);
check('health reports payments configured', (await res.json()).payments === true);

console.log('— step 1: customer opens checkout —');
res = await post('/v1/payments/checkout', { user: USER, packageId: 'builder_10' });
let body = await res.json();
check('checkout session created for Builder £10', res.status === 200 && body.url.includes('checkout.stripe.com'), JSON.stringify(body));

console.log('— step 2: card charged; Stripe fires the settlement webhook —');
const event = JSON.stringify({
  id: 'evt_paycycle_1', type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_123', payment_status: 'paid', metadata: { user: USER, packageId: 'builder_10' } } },
});
const t = Math.floor(Date.now() / 1000);
const sig = `t=${t},v1=${crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${event}`).digest('hex')}`;
res = await fetch(`${BASE}/v1/payments/stripe-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: event,
});
body = await res.json();
check('settlement credits 1,100 ACU', res.status === 200 && body.credited === 1100, JSON.stringify(body));

res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
body = await res.json();
check('wallet shows 1,100 paid after settlement', body.paid === 1100 && body.free === 100, JSON.stringify(body));

console.log('— step 3: Stripe retries the webhook (network flake) —');
res = await fetch(`${BASE}/v1/payments/stripe-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: event,
});
body = await res.json();
check('replayed settlement does NOT double-credit', body.replayed === true, JSON.stringify(body));
res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
check('balance still exactly 1,100 paid', (await res.json()).paid === 1100);

console.log('— step 4: forged & tampered webhooks bounce —');
res = await fetch(`${BASE}/v1/payments/stripe-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: event,
});
check('forged signature rejected', res.status === 400);

console.log('— step 5: the customer generates; the SERVER meters and debits —');
res = await post('/v1/generate', { user: USER, messages: [{ role: 'user', content: 'Find niches in DR Congo' }], capitalGBP: 10000 });
body = await res.json();
check('generation succeeds and is server-billed', res.status === 200 && typeof body.charged === 'number' && body.charged >= 1,
  `charged=${body.charged}`);
check('wallet debited to match', body.wallet.paid === 1100 - body.charged, JSON.stringify(body.wallet));

console.log('— step 5b: fixed-price document generation (deep AI asset) —');
const DOC_SCHEMA = { type: 'object', properties: {
  title: { type: 'string' },
  sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['heading', 'body'], additionalProperties: false } },
}, required: ['title', 'sections'], additionalProperties: false };
const beforeDoc = (await (await fetch(`${BASE}/v1/wallet?user=${USER}`)).json()).paid;
res = await post('/v1/document', { user: USER, docType: 'validation', project: 'proj-alpha', system: 'Generate a market validation report.', messages: [{ role: 'user', content: 'Detailed report for DR Congo.' }], jsonSchema: DOC_SCHEMA, capitalGBP: 10000 });
body = await res.json();
check('document generated with structured content', res.status === 200 && body.content && typeof body.content.title === 'string', JSON.stringify(body).slice(0, 160));
check('document charged the fixed catalogue price (250 ACU)', body.charged === 250, `charged=${body.charged}`);
const afterDoc = (await (await fetch(`${BASE}/v1/wallet?user=${USER}`)).json()).paid;
check('wallet debited by exactly the fixed price', beforeDoc - afterDoc === 250, `${beforeDoc}->${afterDoc}`);
// durability: the generated document is retrievable server-side (survives cache clears)
res = await fetch(`${BASE}/v1/document?user=${USER}&project=proj-alpha&type=validation`);
body = await res.json();
check('generated document persists and re-fetches', res.status === 200 && body.content && typeof body.content.title === 'string', JSON.stringify(body).slice(0, 120));
res = await fetch(`${BASE}/v1/documents?user=${USER}&project=proj-alpha`);
body = await res.json();
check('project document list includes it', res.status === 200 && Array.isArray(body.documents) && body.documents.some((d) => d.type === 'validation'), JSON.stringify(body).slice(0, 120));
res = await post('/v1/document', { user: USER, docType: 'nonsense', system: 'x', messages: [{ role: 'user', content: 'x' }], jsonSchema: DOC_SCHEMA });
check('unknown document type refused (400)', res.status === 400);

console.log('— step 6: anonymous / guessable callers are refused —');
res = await post('/v1/generate', { messages: [{ role: 'user', content: 'free ride?' }] });
check('generation without a wallet id refused', res.status === 403);
res = await post('/v1/generate', { user: 'admin', messages: [{ role: 'user', content: 'guessed id' }] });
check('guessable wallet id refused', res.status === 403);

console.log('— step 7: broke wallets are stopped BEFORE provider spend —');
const POOR = 'op_' + 'zz11xx22yy33aa44';
res = await post('/v1/generate', { user: POOR, messages: [{ role: 'user', content: 'no funds' }] });
body = await res.json();
check('empty wallet → 402 before generation', res.status === 402 && body.platformCode === 4001, JSON.stringify(body));

console.log('— step 8: self-crediting is locked out in production —');
res = await post('/v1/wallet/credit', { user: POOR, packageId: 'investor_50' });
check('client credit refused (403 credit_disabled)', res.status === 403 && (await res.json()).error === 'credit_disabled');
res = await post('/v1/wallet/credit', { user: POOR, packageId: 'starter_5' }, { 'x-admin-key': 'adm_paycycle' });
check('admin-keyed credit still works (support/refund path)', res.status === 200 && (await res.json()).credited === 500);

console.log('— step 8b: admin arbitrary-amount grant (custom comp) —');
res = await post('/v1/wallet/credit', { user: POOR, amount: 250, reason: 'launch comp' });
check('grant without admin key refused (403 admin_required)', res.status === 403 && (await res.json()).error === 'admin_required');
res = await post('/v1/wallet/credit', { user: POOR, amount: 250, reason: 'launch comp' }, { 'x-admin-key': 'adm_paycycle' });
body = await res.json();
check('admin grant credits 250 usable (paid) ACU', res.status === 200 && body.granted === 250 && body.wallet.paid === 750, JSON.stringify(body));

console.log('— step 9: money data is encrypted on disk —');
await new Promise((r) => setTimeout(r, 400));
check('wallet store on disk is an AES-256-GCM envelope', fs.readFileSync(process.env.WALLET_STORE, 'utf8').startsWith('NFE1:'));

stripeMock.close();
console.log(failures === 0 ? '\nFULL PAYMENT CYCLE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
