import './isolate-stores.js'; // never touch the live data/ files (must be first)
// KODA MOBILE-MONEY PAYMENT test — the second money door.
// Boots the gateway with KODA configured (test key + local KODA mock), then
// walks the mobile-money path: hosted intent creation → signed payment.verified
// webhook (x-koda-signature HMAC) → exactly-once ACU credit → replay safety →
// forged-signature rejection.
// Run: node test/koda.js   (exits non-zero on any failure)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18795';
process.env.KODA_SECRET_KEY = 'sk_test_koda';
process.env.KODA_WEBHOOK_SECRET = 'koda_whsec_test_secret';
process.env.KODA_API_BASE = 'http://127.0.0.1:18796/v1';
process.env.KODA_RATE_URL = 'http://127.0.0.1:18796/rate'; // mock live FX feed (no fixed KODA_FX_PER_GBP)
process.env.WALLET_STORE = '/tmp/koda-wallets.json';
process.env.WALLET_STORE_KEY = 'ab'.repeat(32);
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

// ---- local KODA mock: accepts intent creation like the real API ----
let lastIntentBody = null;
const kodaMock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') { // mock FX feed (open.er-api.com shape)
      res.end(JSON.stringify({ result: 'success', base_code: 'GBP', rates: { CDF: 2900 } }));
      return;
    }
    lastIntentBody = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    res.end(JSON.stringify({
      intent_id: 'int_koda_test',
      client_secret: 'cs_koda_test',
      checkout_url: 'https://kodajnn.com/pay/int_koda_test?cs=cs_koda_test',
    }));
  });
});
await new Promise((r) => kodaMock.listen(18796, r));

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const USER = 'op_' + 'k9f3m1x7q2'.repeat(2); // capability-format test id
const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

console.log('— KODA configured: capability flag flips on —');
let res = await fetch(`${BASE}/v1/health`);
check('health reports koda configured', (await res.json()).koda === true);

console.log('— step 1: customer opens the mobile-money checkout —');
res = await post('/v1/payments/koda-intent', { user: USER, packageId: 'builder_10' });
let body = await res.json();
check('intent created, hosted checkout_url returned', res.status === 200 && body.url.includes('kodajnn.com/pay/'), JSON.stringify(body));
check('live-rate: £10 converted to CDF at fetched rate 2900 → 29000 CDF', lastIntentBody && lastIntentBody.amount === 29000 && lastIntentBody.currency === 'CDF', JSON.stringify(lastIntentBody));
check('metadata carries user + package for settlement', lastIntentBody && lastIntentBody.metadata.user === USER && lastIntentBody.metadata.packageId === 'builder_10', JSON.stringify(lastIntentBody && lastIntentBody.metadata));

console.log('— step 2: customer pays; KODA fires the signed payment.verified webhook —');
const event = JSON.stringify({
  id: 'evt_koda_1', type: 'payment.verified',
  data: { object: { id: 'int_koda_test', receipt_id: 'rcpt_1', metadata: { user: USER, packageId: 'builder_10', acu: 1100 } } },
});
const sign = (payload, secret = process.env.KODA_WEBHOOK_SECRET) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');
res = await fetch(`${BASE}/v1/payments/koda-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-koda-signature': sign(event) }, body: event,
});
body = await res.json();
check('settlement credits 1,100 ACU', res.status === 200 && body.credited === 1100, JSON.stringify(body));

res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
body = await res.json();
check('wallet shows 1,100 paid after settlement', body.paid === 1100, JSON.stringify(body));

console.log('— step 3: KODA retries the webhook (network flake) —');
res = await fetch(`${BASE}/v1/payments/koda-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-koda-signature': sign(event) }, body: event,
});
body = await res.json();
check('replayed settlement does NOT double-credit', body.replayed === true, JSON.stringify(body));
res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
check('balance still exactly 1,100 paid', (await res.json()).paid === 1100);

console.log('— step 4: forged & tampered webhooks bounce —');
res = await fetch(`${BASE}/v1/payments/koda-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-koda-signature': 'deadbeef' }, body: event,
});
check('forged signature rejected (400)', res.status === 400);
const tampered = event.replace('1100', '999999');
res = await fetch(`${BASE}/v1/payments/koda-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-koda-signature': sign(event) }, body: tampered,
});
check('tampered body (valid sig for different payload) rejected', res.status === 400);

console.log('— step 5: non-verified events are acknowledged and ignored —');
const pending = JSON.stringify({ id: 'evt_koda_2', type: 'intent.created', data: { object: { metadata: { user: USER, packageId: 'builder_10' } } } });
res = await fetch(`${BASE}/v1/payments/koda-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-koda-signature': sign(pending) }, body: pending,
});
body = await res.json();
check('intent.created ignored, no credit', res.status === 200 && body.ignored === 'intent.created', JSON.stringify(body));

kodaMock.close();
console.log(failures === 0 ? '\nKODA PAYMENT: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
