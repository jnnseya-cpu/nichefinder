// MONEY-LEAK test — the financial-integrity proofs for the audit fixes.
// Boots the gateway with billing ENFORCED and walks the loss vectors a bad
// actor would try:
//   F1  idempotency-key replay can no longer yield free AI generation
//   F2  the reserved output length (and therefore the reserved cost) is driven
//       by maxTokens and can't be lowballed below the floor or above the ceiling
//   F3  refunds and chargebacks claw the credited ACU back (clamped, never
//       negative), disputes FREEZE the wallet, and referral commission on a
//       reversed purchase is reversed too
//   F5  referral commission is capped per referrer (bounds self-referral abuse)
// Run: node test/moneyleaks.js   (exits non-zero on any failure)
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18811';
process.env.STRIPE_SECRET_KEY = 'sk_test_leak';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_leak_secret';
process.env.STRIPE_API_BASE = 'http://127.0.0.1:18812';
process.env.WALLET_STORE = '/tmp/leak-wallets.json';
process.env.WALLET_STORE_KEY = 'cd'.repeat(32);
process.env.AUTH_STORE = '/tmp/leak-auth.json';
process.env.REFERRALS_STORE = '/tmp/leak-referrals.json';
process.env.LEADS_STORE = '/tmp/leak-leads.jsonl';
process.env.DOCS_STORE = '/tmp/leak-docs.json';
process.env.ADMIN_API_KEY = 'adm_leak';
process.env.REFERRAL_RATE = '0.1';
process.env.REFERRAL_LIFETIME_CAP_ACU = '150'; // small, so the cap is exercised
process.env.REQUIRE_WALLET_SESSION = '1';      // exercise the opt-in wallet-ownership binding (F11)
for (const f of [process.env.WALLET_STORE, process.env.AUTH_STORE, process.env.REFERRALS_STORE, process.env.DOCS_STORE]) { try { fs.unlinkSync(f); } catch {} }

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

// local Stripe mock — checkout-session creation only (needed on boot)
const stripeMock = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'cs_leak', url: 'https://checkout.stripe.com/c/pay/cs_leak' })); });
});
await new Promise((r) => stripeMock.listen(18812, r));

const srv = await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const wallet = async (user, token) => (await fetch(`${BASE}/v1/wallet?user=${encodeURIComponent(user)}`, token ? { headers: { authorization: 'Bearer ' + token } } : {})).json();
const admin = { 'x-admin-key': process.env.ADMIN_API_KEY };
function signedWebhook(obj) {
  const event = JSON.stringify(obj);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${event}`).digest('hex')}`;
  return fetch(`${BASE}/v1/payments/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: event });
}
function lzbits(hex) { let bits = 0; for (const ch of hex) { const v = parseInt(ch, 16); if (v === 0) { bits += 4; continue; } bits += Math.clz32(v) - 28; break; } return bits; }
async function humanProof() {
  const ch = await (await fetch(BASE + '/v1/human/challenge')).json();
  let n = 0; for (;;) { if (lzbits(crypto.createHash('sha256').update(ch.challenge + n).digest('hex')) >= ch.difficulty) break; n++; }
  return { challenge: ch.challenge, nonce: String(n) };
}

// ───────────────────────── F1: replay ≠ free AI ─────────────────────────
console.log('— F1: a pinned idempotency key can no longer buy unlimited free AI —');
const U1 = 'op_' + 'leakf1aaaa0001';
let res = await post('/v1/wallet/credit', { user: U1, amount: 10 }, admin);
check('admin funded the wallet with 10 ACU', res.status === 200 && (await res.json()).wallet.paid === 10);

const REPLAY = { user: U1, messages: [{ role: 'user', content: 'same request every time' }], idempotencyKey: 'PINNED-KEY' };
res = await post('/v1/generate', REPLAY); const g1 = await res.json();
const after1 = (await wallet(U1)).paid;
res = await post('/v1/generate', REPLAY); const g2 = await res.json();
const after2 = (await wallet(U1)).paid;
res = await post('/v1/generate', REPLAY); await res.json();
const after3 = (await wallet(U1)).paid;
check('first generation billed', g1.charged >= 1 && after1 === 10 - g1.charged, `charged=${g1.charged} after1=${after1}`);
check('SECOND call with the SAME key is billed again (not replayed-free)', after2 < after1, `after1=${after1} after2=${after2}`);
check('THIRD call with the SAME key is billed again', after3 < after2, `after2=${after2} after3=${after3}`);
check('each same-key call debited exactly once (monotonic drain)', (after1 - after2) === g1.charged && (after2 - after3) === g1.charged, `${after1}->${after2}->${after3}`);

// ───────────────────────── F2: reservation clamp ────────────────────────
console.log('— F2: reserved output length is driven by maxTokens, floored + capped —');
check('default (no hint) reserves 2000 output tokens', srv.reservedOutputTokens({}) === 2000);
check('client maxTokens honoured as the reservation basis', srv.reservedOutputTokens({ maxTokens: 500 }) === 500);
check('reservation floored at 256 (a lowball of 1 cannot underprice)', srv.reservedOutputTokens({ maxTokens: 1 }) === 256);
check('reservation hard-capped at 8000 (no runaway bill)', srv.reservedOutputTokens({ maxTokens: 50000 }) === 8000);
check('expectedOutputTokens no longer sets the reservation when maxTokens is present', srv.reservedOutputTokens({ maxTokens: 3000, expectedOutputTokens: 1 }) === 3000);

// ───────────────────── F3: refund / chargeback claw-back ────────────────
console.log('— F3a: a full refund claws the whole package back —');
const U2 = 'op_' + 'leakf3aaaa0002';
await signedWebhook({ id: 'evt_f3_buy', type: 'checkout.session.completed',
  data: { object: { id: 'cs_f3', payment_status: 'paid', payment_intent: 'pi_f3', metadata: { user: U2, packageId: 'builder_10' } } } });
check('purchase credited 1,100 ACU', (await wallet(U2)).paid === 1100);
res = await signedWebhook({ id: 'evt_f3_refund', type: 'charge.refunded',
  data: { object: { id: 'ch_f3', payment_intent: 'pi_f3', amount: 1000, amount_refunded: 1000, metadata: { user: U2, packageId: 'builder_10' }, refunds: { data: [{ id: 're_f3', amount: 1000 }] } } } });
let body = await res.json();
check('refund reversed the full 1,100 ACU', body.reversed === 1100 && body.shortfall === 0, JSON.stringify(body));
check('wallet drained to 0 after full refund', (await wallet(U2)).paid === 0);
res = await signedWebhook({ id: 'evt_f3_refund2', type: 'charge.refunded',
  data: { object: { id: 'ch_f3', payment_intent: 'pi_f3', amount: 1000, amount_refunded: 1000, metadata: { user: U2, packageId: 'builder_10' }, refunds: { data: [{ id: 're_f3', amount: 1000 }] } } } });
check('replayed refund does NOT double-claw', (await res.json()).replayed === true);

console.log('— F3b: a partial refund reverses only its proportional slice —');
const U3 = 'op_' + 'leakf3bbbb0003';
await signedWebhook({ id: 'evt_f3b_buy', type: 'checkout.session.completed',
  data: { object: { id: 'cs_f3b', payment_status: 'paid', payment_intent: 'pi_f3b', metadata: { user: U3, packageId: 'builder_10' } } } });
res = await signedWebhook({ id: 'evt_f3b_refund', type: 'charge.refunded',
  data: { object: { id: 'ch_f3b', payment_intent: 'pi_f3b', amount: 1000, amount_refunded: 500, metadata: { user: U3, packageId: 'builder_10' }, refunds: { data: [{ id: 're_f3b', amount: 500 }] } } } });
body = await res.json();
check('half refund reverses ~half the ACU (550)', body.reversed === 550, JSON.stringify(body));
check('wallet left with the un-refunded remainder (550)', (await wallet(U3)).paid === 550);

console.log('— F3c: spend-then-refund records the unrecoverable shortfall —');
const U4 = 'op_' + 'leakf3cccc0004';
await signedWebhook({ id: 'evt_f3c_buy', type: 'checkout.session.completed',
  data: { object: { id: 'cs_f3c', payment_status: 'paid', payment_intent: 'pi_f3c', metadata: { user: U4, packageId: 'starter_5' } } } });
// starter_5 = 500 ACU. Spend most of it, then refund the whole purchase.
const startBal = (await wallet(U4)).paid;
// admin-deduct 480 to simulate spend
res = await post('/v1/wallet/charge', { user: U4, amount: 480, label: 'sim spend' }, admin);
const spentBal = (await wallet(U4)).paid;
res = await signedWebhook({ id: 'evt_f3c_refund', type: 'charge.refunded',
  data: { object: { id: 'ch_f3c', payment_intent: 'pi_f3c', amount: 500, amount_refunded: 500, metadata: { user: U4, packageId: 'starter_5' }, refunds: { data: [{ id: 're_f3c', amount: 500 }] } } } });
body = await res.json();
check('reversal recovers only what remains and reports the shortfall', body.reversed === spentBal && body.shortfall === 500 - spentBal, `start=${startBal} spent=${spentBal} ${JSON.stringify(body)}`);
check('wallet cannot go negative on reversal', (await wallet(U4)).paid === 0);

console.log('— F3d: a chargeback claws back AND freezes the wallet —');
const U5 = 'op_' + 'leakf3dddd0005';
await signedWebhook({ id: 'evt_f3d_buy', type: 'checkout.session.completed',
  data: { object: { id: 'cs_f3d', payment_status: 'paid', payment_intent: 'pi_f3d', metadata: { user: U5, packageId: 'builder_10' } } } });
res = await signedWebhook({ id: 'evt_f3d_dispute', type: 'charge.dispute.created',
  data: { object: { id: 'dp_f3d', charge: 'ch_f3d', payment_intent: 'pi_f3d', metadata: { user: U5, packageId: 'builder_10' } } } });
body = await res.json();
check('dispute reversed the package and froze the wallet', body.reversed === 1100 && body.frozen === true, JSON.stringify(body));
// fund the frozen wallet, then prove it cannot spend
await post('/v1/wallet/credit', { user: U5, amount: 500 }, admin);
res = await post('/v1/generate', { user: U5, messages: [{ role: 'user', content: 'spend while frozen?' }] });
body = await res.json();
check('a frozen wallet is refused at spend time (402 wallet_frozen)', res.status === 402 && body.error === 'wallet_frozen', `${res.status} ${JSON.stringify(body)}`);

// ───────────── F3e + F5: referral reversal and lifetime cap ──────────────
console.log('— F3e/F5: referral commission reverses on refund, and is capped —');
res = await post('/v1/auth/signup', { email: 'refr@leak.test', password: 'partnerpass1', ...(await humanProof()) });
let sj = await res.json(); const REFERRER = sj.user.userId; const REFERRER_TOKEN = sj.token;
const scode = await (await fetch(`${BASE}/v1/referrals/summary?user=${REFERRER}`)).json();
res = await post('/v1/auth/signup', { email: 'refe@leak.test', password: 'refereepass1', ref: scode.code, ...(await humanProof()) });
const REFEREE = (await res.json()).user.userId;
await signedWebhook({ id: 'evt_ref_buy', type: 'checkout.session.completed',
  data: { object: { id: 'cs_ref', payment_status: 'paid', payment_intent: 'pi_ref', metadata: { user: REFEREE, packageId: 'builder_10' } } } });
check('referrer earned 100 ACU commission', (await wallet(REFERRER, REFERRER_TOKEN)).paid === 100);
// refund the referee's purchase → the referrer's commission must be clawed back
res = await signedWebhook({ id: 'evt_ref_refund', type: 'charge.refunded',
  data: { object: { id: 'ch_ref', payment_intent: 'pi_ref', amount: 1000, amount_refunded: 1000, metadata: { user: REFEREE, packageId: 'builder_10' }, refunds: { data: [{ id: 're_ref', amount: 1000 }] } } } });
await res.json();
check('referrer commission reversed on refund (back to 0)', (await wallet(REFERRER, REFERRER_TOKEN)).paid === 0);

// F5 cap: with the £10 purchase reversed, re-buy twice to push past the 150 cap.
await signedWebhook({ id: 'evt_cap_1', type: 'checkout.session.completed',
  data: { object: { id: 'cs_cap1', payment_status: 'paid', payment_intent: 'pi_cap1', metadata: { user: REFEREE, packageId: 'builder_10' } } } });
await signedWebhook({ id: 'evt_cap_2', type: 'checkout.session.completed',
  data: { object: { id: 'cs_cap2', payment_status: 'paid', payment_intent: 'pi_cap2', metadata: { user: REFEREE, packageId: 'builder_10' } } } });
const capped = (await wallet(REFERRER, REFERRER_TOKEN)).paid;
check('referral commission is capped at the lifetime limit (150 ACU)', capped === 150, `paid=${capped}`);

// ───────────── F7: concurrency TOCTOU — no over-spend under a burst ─────────
console.log('— F7: N concurrent generations cannot out-spend one balance —');
const U6 = 'op_' + 'leakf7aaaa0006';
await post('/v1/wallet/credit', { user: U6, amount: 3 }, admin); // only 3 ACU → 3 generations max
// Fire 12 concurrent generations at a 3-ACU wallet. Each costs the 1-ACU floor.
const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
  post('/v1/generate', { user: U6, messages: [{ role: 'user', content: 'burst ' + i }] }).then((r) => r.status)));
const ok = burst.filter((s) => s === 200).length;
const refused = burst.filter((s) => s === 402).length;
const endBal = (await wallet(U6)).paid;
check('at most 3 of the 12 concurrent calls succeeded', ok <= 3, `ok=${ok} refused=${refused}`);
check('the rest were refused (402), not served free', ok + refused === 12, `ok=${ok} refused=${refused}`);
check('wallet never went negative (held-based reservation held the line)', endBal >= 0 && endBal === 3 - ok, `endBal=${endBal} ok=${ok}`);

// ───────────── F8: subscription proration is not credited ────────────────
console.log('— F8: a plan-change proration invoice does not mint a full allotment —');
const U7 = 'op_' + 'leakf8aaaa0007';
// first real cycle credits the plan allotment (starter = 200 ACU/mo)
await signedWebhook({ id: 'evt_sub_create', type: 'invoice.paid',
  data: { object: { id: 'in_create', billing_reason: 'subscription_create', subscription: 'sub_1', subscription_details: { metadata: { user: U7, planId: 'starter' } } } } });
check('first cycle credited the 200-ACU allotment', (await wallet(U7)).paid === 200);
// a proration invoice from an upgrade must NOT credit again
let r = await signedWebhook({ id: 'evt_sub_proration', type: 'invoice.paid',
  data: { object: { id: 'in_proration', billing_reason: 'subscription_update', subscription: 'sub_1', subscription_details: { metadata: { user: U7, planId: 'pro' } } } } });
body = await r.json();
check('proration invoice ignored (not credited)', body.ignored && body.ignored.startsWith('non_period_invoice'), JSON.stringify(body));
check('balance unchanged after proration', (await wallet(U7)).paid === 200);
// the next genuine renewal cycle DOES credit
await signedWebhook({ id: 'evt_sub_cycle', type: 'invoice.paid',
  data: { object: { id: 'in_cycle', billing_reason: 'subscription_cycle', subscription: 'sub_1', subscription_details: { metadata: { user: U7, planId: 'pro' } } } } });
check('genuine renewal credits the new plan allotment (+600)', (await wallet(U7)).paid === 800);

// ───────────── F9: client idempotency key can't poison a settlement key ──
console.log('— F9: a client-chosen idempotency key cannot pre-occupy a settlement key —');
const U8 = 'op_' + 'leakf9aaaa0008';
await post('/v1/wallet/credit', { user: U8, amount: 100 }, admin);
// attacker tries to pre-seed the exact settlement key a future webhook will use
await post('/v1/wallet/charge', { user: U8, amount: 1, label: 'poison', idempotencyKey: 'stripe_evt_poison_1' }, admin);
// the webhook for that event id must still credit (its key was namespaced away)
r = await signedWebhook({ id: 'evt_poison_1', type: 'checkout.session.completed',
  data: { object: { id: 'cs_poison', payment_status: 'paid', payment_intent: 'pi_poison', metadata: { user: U8, packageId: 'starter_5' } } } });
body = await r.json();
check('the real settlement still credited despite the pre-seeded key', body.credited === 500 && !body.replayed, JSON.stringify(body));

// ───────────── F10: amount mismatch is refused ───────────────────────────
console.log('— F10: a settlement whose amount is short is not credited —');
const U9 = 'op_' + 'leakf10aaa0009';
r = await signedWebhook({ id: 'evt_short', type: 'checkout.session.completed',
  data: { object: { id: 'cs_short', payment_status: 'paid', payment_intent: 'pi_short', amount_total: 1, currency: 'gbp', metadata: { user: U9, packageId: 'investor_50' } } } });
body = await r.json();
check('underpaid session refused (amount_mismatch)', body.ignored === 'amount_mismatch', JSON.stringify(body));
check('no ACU credited for the underpayment', ((await wallet(U9)).paid || 0) === 0);

// ───────────── F11: a user can only touch the wallet they own ────────────
console.log('— F11: account wallets are locked to their owner; guests stay tokenless —');
res = await post('/v1/auth/signup', { email: 'victim@leak.test', password: 'victimpass1', ...(await humanProof()) });
sj = await res.json(); const VICTIM = sj.user.userId; const VICTIM_TOKEN = sj.token;
await post('/v1/wallet/credit', { user: VICTIM, amount: 500 }, admin); // fund the account wallet
// read without the owner session → refused
res = await fetch(`${BASE}/v1/wallet?user=${VICTIM}`);
check('reading an account wallet without its session is refused (403)', res.status === 403 && (await res.json()).error === 'not_wallet_owner', `status=${res.status}`);
// read with a DIFFERENT account's session → refused
res = await fetch(`${BASE}/v1/wallet?user=${VICTIM}`, { headers: { authorization: 'Bearer ' + REFERRER_TOKEN } });
check('reading it with someone else’s session is refused (403)', res.status === 403);
// read with the owner's own session → allowed
res = await fetch(`${BASE}/v1/wallet?user=${VICTIM}`, { headers: { authorization: 'Bearer ' + VICTIM_TOKEN } });
check('the owner reads their own wallet (200, 500 paid)', res.status === 200 && (await res.json()).paid === 500);
// spend attempts without the owner session → refused, no provider spend
res = await post('/v1/generate', { user: VICTIM, messages: [{ role: 'user', content: 'drain you' }] });
check('generating on an account wallet without its session is refused (403)', res.status === 403 && (await res.json()).error === 'not_wallet_owner');
res = await post('/v1/wallet/charge', { user: VICTIM, amount: 50, label: 'steal' });
check('charging an account wallet without its session is refused (403)', res.status === 403);
check('the victim balance is untouched by the attempts', (await wallet(VICTIM, VICTIM_TOKEN)).paid === 500);
// a GUEST wallet (no account) still works with no token — the pre-signup flow
const GUEST = 'op_' + 'leakguest0011';
await post('/v1/wallet/credit', { user: GUEST, amount: 5 }, admin);
res = await fetch(`${BASE}/v1/wallet?user=${GUEST}`);
check('a guest wallet is still readable without a token', res.status === 200 && (await res.json()).paid === 5);
res = await post('/v1/generate', { user: GUEST, messages: [{ role: 'user', content: 'guest run' }] });
check('a guest can still spend without a token (pre-signup flow intact)', res.status === 200 && res.ok);

// ───────────── F12: webhook signature verification is correct ────────────
console.log('— F12: webhook signatures verify against the right secret only —');
const { verifySignature } = await import('../src/payments.js'); // after env is set
function signWith(secret, bodyStr) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest('hex')}`;
}
const wbBody = JSON.stringify({ id: 'evt_sig', type: 'ping' });
check('a signature made with the endpoint secret verifies', verifySignature(wbBody, signWith('whsec_A', wbBody), 'whsec_A') === true);
check('a signature made with a DIFFERENT secret is rejected', verifySignature(wbBody, signWith('whsec_B', wbBody), 'whsec_A') === false);
check('a stale timestamp (>5 min) is rejected', (() => {
  const t = Math.floor(Date.now() / 1000) - 400;
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_A').update(`${t}.${wbBody}`).digest('hex')}`;
  return verifySignature(wbBody, sig, 'whsec_A') === false;
})());
check('a garbage signature header is rejected', verifySignature(wbBody, 'not-a-signature', 'whsec_A') === false);

stripeMock.close();
console.log(failures === 0 ? '\nMONEY LEAKS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
