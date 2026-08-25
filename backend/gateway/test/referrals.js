// REFERRALS test — the Growth Partner programme, end to end.
//   referrer signs up → gets a stable invite code → referee signs up with that
//   code (counts as a referral, earns nothing yet) → referee makes a REAL paid
//   purchase (Stripe settlement) → referral qualifies and the referrer is
//   credited commission ACU → webhook replay does not double-pay → self/bad
//   codes are ignored.
// Run: node test/referrals.js   (exits non-zero on any failure)
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18799';
process.env.STRIPE_SECRET_KEY = 'sk_test_ref';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_ref_secret';
process.env.STRIPE_API_BASE = 'http://127.0.0.1:18800';
process.env.WALLET_STORE = '/tmp/ref-wallets.json';
process.env.WALLET_STORE_KEY = 'cd'.repeat(32);
process.env.AUTH_STORE = '/tmp/ref-auth.json';
process.env.REFERRALS_STORE = '/tmp/ref-referrals.json';
process.env.LEADS_STORE = '/tmp/ref-leads.jsonl';
process.env.REFERRAL_RATE = '0.1';
for (const f of [process.env.WALLET_STORE, process.env.AUTH_STORE, process.env.REFERRALS_STORE]) { try { fs.unlinkSync(f); } catch {} }

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

// local Stripe mock (checkout-session creation) — not exercised here but needed on boot
const stripeMock = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'cs_x', url: 'https://checkout.stripe.com/c/pay/cs_x' })); });
});
await new Promise((r) => stripeMock.listen(18800, r));

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function lzbits(hex) { let bits = 0; for (const ch of hex) { const v = parseInt(ch, 16); if (v === 0) { bits += 4; continue; } bits += Math.clz32(v) - 28; break; } return bits; }
async function humanProof() {
  const ch = await (await fetch(BASE + '/v1/human/challenge')).json();
  let n = 0;
  for (;;) { if (lzbits(crypto.createHash('sha256').update(ch.challenge + n).digest('hex')) >= ch.difficulty) break; n++; }
  return { challenge: ch.challenge, nonce: String(n) };
}
const summary = async (user) => (await fetch(`${BASE}/v1/referrals/summary?user=${encodeURIComponent(user)}`)).json();

console.log('— referrer signs up and gets a stable invite code —');
let res = await post('/v1/auth/signup', { email: 'referrer@nf.test', password: 'partnerpass1', ...(await humanProof()) });
let body = await res.json();
const REFERRER = body.user.userId;
const REFERRER_TOKEN = body.token; // account wallets require the owner's session to read/spend
check('referrer account created with op_ id', res.status === 200 && /^op_[a-z0-9]{10,}$/.test(REFERRER), JSON.stringify(body));
let s = await summary(REFERRER);
check('invite code issued (NF-XXXXXXXX)', /^NF-[A-Z0-9]{8}$/.test(s.code), JSON.stringify(s));
check('referral link points at the public origin', typeof s.link === 'string' && s.link.includes('?ref=' + s.code));
const CODE = s.code;
check('code is stable across calls', (await summary(REFERRER)).code === CODE);

console.log('— referee signs up WITH the invite code —');
res = await post('/v1/auth/signup', { email: 'referee@nf.test', password: 'refereepass1', ref: CODE, ...(await humanProof()) });
body = await res.json();
const REFEREE = body.user.userId;
check('referee account created', res.status === 200 && /^op_/.test(REFEREE));
s = await summary(REFERRER);
check('referral recorded (total=1), not yet qualified (qualified=0)', s.totalReferrals === 1 && s.qualifiedReferrals === 0, JSON.stringify(s));
check('no commission before any paid usage', s.acuEarned === 0 && s.gbpEarned === 0, JSON.stringify(s));

console.log('— referee makes a real paid purchase (Stripe settlement) —');
const event = JSON.stringify({
  id: 'evt_ref_1', type: 'checkout.session.completed',
  data: { object: { id: 'cs_ref', payment_status: 'paid', metadata: { user: REFEREE, packageId: 'builder_10' } } },
});
const t = Math.floor(Date.now() / 1000);
const sig = `t=${t},v1=${crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${event}`).digest('hex')}`;
res = await fetch(`${BASE}/v1/payments/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: event });
check('settlement accepted', res.status === 200 && (await res.json()).credited === 1100);

s = await summary(REFERRER);
// builder_10 is a £10 package → 10% = £1 = 100 ACU commission
check('referral now qualified (qualified=1)', s.qualifiedReferrals === 1, JSON.stringify(s));
check('commission credited: 100 ACU', s.acuEarned === 100, JSON.stringify(s));
check('commission £ value tracked: £1', s.gbpEarned === 1, JSON.stringify(s));

res = await fetch(`${BASE}/v1/wallet?user=${REFERRER}`, { headers: { authorization: 'Bearer ' + REFERRER_TOKEN } });
body = await res.json();
check('referrer wallet actually received the 100 ACU (spendable)', body.paid === 100, JSON.stringify(body));

console.log('— Stripe retries the webhook (network flake) —');
res = await fetch(`${BASE}/v1/payments/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: event });
await res.json();
s = await summary(REFERRER);
check('replay does NOT double-pay commission (still 100 ACU)', s.acuEarned === 100 && s.qualifiedReferrals === 1, JSON.stringify(s));

console.log('— abuse guards —');
res = await post('/v1/auth/signup', { email: 'selfref@nf.test', password: 'selfpass1234', ref: 'NF-ZZZZZZZZ', ...(await humanProof()) });
body = await res.json();
check('signup with an unknown code still succeeds (ignored)', res.status === 200 && /^op_/.test(body.user.userId));
check('unknown code creates no phantom referral', (await summary(REFERRER)).totalReferrals === 1);

stripeMock.close();
console.log(failures === 0 ? '\nREFERRALS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
