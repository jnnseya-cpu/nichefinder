import './isolate-stores.js'; // never touch the live data/ files (must be first)
// BITRIPAY PAYMENT test — the third money door.
// Boots the gateway with BitriPay configured (test key + local mock), then walks
// the path: hosted checkout intent → signed payment.succeeded webhook
// (BitriPay-Signature t=,v1= HMAC) → exactly-once ACU credit → replay safety →
// forged-signature rejection → STALE-timestamp rejection → server-set price.
// Run: node test/bitripay.js
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18797';
process.env.BITRIPAY_SECRET_KEY = 'bp_test_key';
process.env.BITRIPAY_WEBHOOK_SECRET = 'bp_whsec_test_secret';
process.env.BITRIPAY_API_BASE = 'http://127.0.0.1:18798/v1';
process.env.BITRIPAY_CURRENCY = 'GBP';
process.env.WALLET_STORE = '/tmp/bitripay-wallets.json';
process.env.WALLET_STORE_KEY = 'ab'.repeat(32);
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

// local BitriPay mock: accepts checkout intent creation like the real API
let lastIntentBody = null;
const mock = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    lastIntentBody = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'bpi_123', checkout_url: 'https://pay.bitripay.com/c/bpi_123', qr_payload: '00020101...' }));
  });
});
await new Promise((r) => mock.listen(18798, r));

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (p, b, h = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: typeof b === 'string' ? b : JSON.stringify(b) });
const wallet = async (u) => (await fetch(`${BASE}/v1/wallet?user=${u}`)).json();
const U = 'op_bitripaytest01';

// health reflects bitripay configured
let r = await fetch(BASE + '/v1/health'); let hb = await r.json();
check('health reports bitripay: true when configured', hb.bitripay === true, JSON.stringify(hb.bitripay));

// 1) create a hosted intent — price is server-set from the package
r = await post('/v1/payments/bitripay-intent', { user: U, packageId: 'builder_10' });
let intent = await r.json();
check('intent returns a hosted checkout URL + QR', r.status === 200 && /pay.bitripay.com/.test(intent.url) && intent.qr, JSON.stringify(intent).slice(0, 80));
check('amount is the server-set package price (£10, not client-chosen)', lastIntentBody && lastIntentBody.amount === 10 && lastIntentBody.currency === 'GBP', JSON.stringify(lastIntentBody && { a: lastIntentBody.amount, c: lastIntentBody.currency }));
const orderId = lastIntentBody.metadata.order_id;

// helper: build a correctly-signed webhook
function sign(body, secret = 'bp_whsec_test_secret', t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=` + crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}
const evtBody = JSON.stringify({ type: 'payment.succeeded', id: 'evt_bp_1', data: { object: { metadata: { user: U, packageId: 'builder_10', order_id: orderId } } } });

// 2) forged signature rejected
r = await post('/v1/payments/bitripay-webhook', evtBody, { 'bitripay-signature': 't=' + Math.floor(Date.now() / 1000) + ',v1=deadbeef' });
check('forged signature rejected (400)', r.status === 400, 'got ' + r.status);
check('no credit from a forged webhook', (await wallet(U)).paid === 0);

// 3) stale timestamp rejected (older than tolerance)
r = await post('/v1/payments/bitripay-webhook', evtBody, { 'bitripay-signature': sign(evtBody, 'bp_whsec_test_secret', Math.floor(Date.now() / 1000) - 10000) });
check('stale-timestamp delivery rejected (replay window)', r.status === 400, 'got ' + r.status);
check('no credit from a stale webhook', (await wallet(U)).paid === 0);

// 4) valid webhook credits exactly once (builder_10 = 1,000 + 100 bonus = 1,100)
r = await post('/v1/payments/bitripay-webhook', evtBody, { 'bitripay-signature': sign(evtBody) });
let body = await r.json();
check('valid payment.succeeded credits 1,100 ACU', body.credited === 1100 && body.replayed === false, JSON.stringify(body));
check('wallet shows 1,100 paid', (await wallet(U)).paid === 1100);

// 5) replay is idempotent (same order_id)
r = await post('/v1/payments/bitripay-webhook', evtBody, { 'bitripay-signature': sign(evtBody) });
body = await r.json();
check('replayed webhook is idempotent (no double-credit)', body.replayed === true, JSON.stringify(body));
check('wallet still 1,100 after replay', (await wallet(U)).paid === 1100);

// 6) non-crediting events acknowledged, never credit
r = await post('/v1/payments/bitripay-webhook', JSON.stringify({ type: 'dispute.opened', id: 'evt_bp_d', data: {} }),
  { 'bitripay-signature': sign(JSON.stringify({ type: 'dispute.opened', id: 'evt_bp_d', data: {} })) });
body = await r.json();
check('dispute.opened acknowledged, not credited', body.ignored === 'dispute.opened', JSON.stringify(body));
check('wallet unchanged by non-payment event', (await wallet(U)).paid === 1100);

mock.close();
console.log(failures === 0 ? '\nBITRIPAY: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
