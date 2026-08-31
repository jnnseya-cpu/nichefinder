import './isolate-stores.js'; // never touch the live data/ files (must be first)
// SUBSCRIPTION CYCLE test — recurring Stripe plans → monthly ACU allotment.
// Boots the gateway with billing ENFORCED (test Stripe keys + a local Stripe
// mock), then walks the subscription money path:
//   subscribe checkout → first invoice.paid credits the allotment → replay is
//   idempotent → renewal invoice.paid credits again → subscription checkout.session
//   is NOT double-credited → subscription.deleted ends the plan.
// Run: node test/subscriptions.js   (exits non-zero on any failure)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18890';
process.env.STRIPE_SECRET_KEY = 'sk_test_subs';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_subs_secret';
process.env.STRIPE_API_BASE = 'http://127.0.0.1:18891';
process.env.WALLET_STORE = '/tmp/subs-wallets.json';
process.env.WALLET_STORE_KEY = 'ab'.repeat(32);
process.env.ADMIN_API_KEY = 'adm_subs';
process.env.LEADS_STORE = '/tmp/subs-leads.jsonl';
process.env.DOCS_STORE = '/tmp/subs-docs.json';
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

// ---- local Stripe mock: accepts subscription checkout-session creation ----
const stripeMock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const params = new URLSearchParams(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'sub_cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/sub_cs_test_1',
      mode: params.get('mode'),
      metadata: { user: params.get('metadata[user]'), planId: params.get('metadata[planId]') },
    }));
  });
});
await new Promise((r) => stripeMock.listen(18891, r));

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const USER = 'op_' + 'sub7plan42'.repeat(2);
const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const sign = (event) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${event}`).digest('hex')}`;
};
const hook = (obj) => fetch(`${BASE}/v1/payments/stripe-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(JSON.stringify(obj)) }, body: JSON.stringify(obj),
});
const invoice = (id, reason) => ({
  id: 'evt_' + id, type: 'invoice.paid',
  data: { object: { id, billing_reason: reason, subscription: 'sub_123', subscription_details: { metadata: { user: USER, planId: 'starter' } } } },
});

let res, body;

console.log('— payments live —');
res = await fetch(`${BASE}/v1/health`);
check('health reports payments configured', (await res.json()).payments === true);

console.log('— step 1: customer subscribes to Starter (£19/mo, 200 ACU) —');
res = await post('/v1/payments/subscribe', { user: USER, planId: 'starter' });
body = await res.json();
check('subscription checkout session created', res.status === 200 && String(body.url).includes('checkout.stripe.com'), JSON.stringify(body));

console.log('— step 2: subscription checkout.session.completed is NOT credited (invoice does it) —');
res = await hook({ id: 'evt_cs', type: 'checkout.session.completed', data: { object: { id: 'sub_cs_test_1', mode: 'subscription', payment_status: 'paid', metadata: { user: USER, planId: 'starter' } } } });
body = await res.json();
check('subscription checkout is ignored for crediting', res.status === 200 && /subscription_checkout/.test(body.ignored || ''), JSON.stringify(body));

console.log('— step 3: first invoice.paid credits the monthly allotment —');
res = await hook(invoice('in_1', 'subscription_create'));
body = await res.json();
check('first invoice credits 200 ACU', res.status === 200 && body.credited === 200 && body.plan === 'starter', JSON.stringify(body));
res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
body = await res.json();
check('wallet shows 200 paid + active starter plan', body.paid === 200 && body.plan && body.plan.id === 'starter' && body.plan.status === 'active', JSON.stringify(body));

console.log('— step 4: Stripe replays the invoice webhook —');
res = await hook(invoice('in_1', 'subscription_create'));
body = await res.json();
check('replayed invoice does NOT double-credit', body.replayed === true, JSON.stringify(body));
res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
check('balance still exactly 200 paid', (await res.json()).paid === 200);

console.log('— step 5: next month renews → another 200 ACU —');
res = await hook(invoice('in_2', 'subscription_cycle'));
body = await res.json();
check('renewal invoice credits another 200 ACU', body.credited === 200 && body.replayed === false, JSON.stringify(body));
res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
check('balance now 400 paid (2 cycles)', (await res.json()).paid === 400);

console.log('— step 6: forged webhook bounces —');
res = await fetch(`${BASE}/v1/payments/stripe-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: JSON.stringify(invoice('in_x', 'subscription_cycle')),
});
check('forged signature rejected', res.status === 400);

console.log('— step 7: cancellation ends the plan (ACUs kept) —');
res = await hook({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_123', metadata: { user: USER, planId: 'starter' } } } });
body = await res.json();
check('subscription.deleted ends the plan', res.status === 200 && body.planEnded === true, JSON.stringify(body));
res = await fetch(`${BASE}/v1/wallet?user=${USER}`);
body = await res.json();
check('plan marked canceled, 400 ACU retained', body.plan && body.plan.status === 'canceled' && body.paid === 400, JSON.stringify(body));

console.log('— unknown/non-self-serve plan rejected —');
res = await post('/v1/payments/subscribe', { user: USER, planId: 'ent' });
check('enterprise (non-self-serve) subscribe rejected', res.status === 400);
res = await post('/v1/payments/subscribe', { user: USER, planId: 'nope' });
check('unknown plan subscribe rejected', res.status === 400);

stripeMock.close();
console.log(failures === 0 ? '\nSUBSCRIPTIONS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
