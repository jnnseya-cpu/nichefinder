// BitriPay payment door — a third real-money provider for ACU packages, alongside
// Stripe (cards) and KODA (mobile money). Hosted-checkout intents via the BitriPay
// REST API; webhook settlement verified with a Stripe-style timestamped HMAC
// (t=<ts>,v1=<hmac>), which adds replay-window protection.
//
// Activate by setting (BitriPay dashboard → Developers):
//   BITRIPAY_SECRET_KEY      bp_live_... (or bp_test_... to rehearse in sandbox)
//   BITRIPAY_WEBHOOK_SECRET  the endpoint's signing secret (BitriPay-Signature)
// Optional:
//   BITRIPAY_API_BASE        default https://api.bitripay.com/v1
//   BITRIPAY_CURRENCY        settlement currency (default GBP; set a local code to convert)
//   BITRIPAY_FX_PER_GBP      units of BITRIPAY_CURRENCY per £1 (manual FX override)
//   BITRIPAY_WEBHOOK_TOLERANCE_SEC  default 300 (reject deliveries older than this)
// Without the required two, the BitriPay option returns 503 and the client falls
// back to Stripe/KODA — the same build runs pre- and post-setup.
//
// ⚠ HONEST NOTE — like koda.js, the exact endpoint paths, request/response field
// names, signature header and event-type strings MUST be confirmed against
// BitriPay's live API docs before go-live. They are centralised + env-overridable
// here, and the first live payment logs amount+currency+ids so a mismatch is
// visible immediately, not weeks later. The money-safety invariants below
// (server-set price, idempotent crediting, signature+timestamp verification) are
// provider-independent and fully tested.
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import { credit, PACKAGES } from './wallet.js';
import { onPaidPurchase } from './referrals.js';
import { sendPurchaseReceipt } from './payments.js';
import { emailForUserId } from './auth.js';
import { sendEvent as capiSend } from './meta-capi.js';

const KEY = process.env.BITRIPAY_SECRET_KEY || '';
const WHSEC = process.env.BITRIPAY_WEBHOOK_SECRET || '';
const BASE = (process.env.BITRIPAY_API_BASE || 'https://api.bitripay.com/v1').replace(/\/$/, '');
const CURRENCY = process.env.BITRIPAY_CURRENCY || 'GBP';
const FX_PER_GBP = Number(process.env.BITRIPAY_FX_PER_GBP || 0);
const RATE_URL = process.env.BITRIPAY_RATE_URL || 'https://open.er-api.com/v6/latest/GBP';
const RATE_TTL_MS = Number(process.env.BITRIPAY_RATE_TTL_MS || 3600000);
const TOLERANCE_SEC = Math.max(30, Number(process.env.BITRIPAY_WEBHOOK_TOLERANCE_SEC || 300));
const MINOR_UNITS = process.env.BITRIPAY_MINOR_UNITS === '1';
const ZERO_DECIMAL = new Set(['CDF', 'XAF', 'XOF', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'RWF', 'GNF', 'BIF', 'KMF', 'MGA', 'PYG', 'DJF', 'VUV']);
function toChargeUnits(major, currency) {
  return (MINOR_UNITS && !ZERO_DECIMAL.has(currency)) ? Math.round(major * 100) : Math.round(major);
}

export const bitriPayConfigured = () => Boolean(KEY && WHSEC);

let _rate = { at: 0, value: 0 };
async function ratePerGbp(to) {
  if (FX_PER_GBP > 0) return FX_PER_GBP;
  const now = Date.now();
  if (_rate.value > 0 && now - _rate.at < RATE_TTL_MS) return _rate.value;
  try {
    const res = await fetch(RATE_URL, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    const r = Number(data?.rates?.[to]);
    if (res.ok && r > 0) { _rate = { at: now, value: r }; return r; }
    console.error(`[bitripay] rate feed returned no ${to} rate (status=${res.status})`);
  } catch (err) {
    console.error(`[bitripay] rate feed unreachable: ${err.message}`);
  }
  return _rate.value > 0 ? _rate.value : 0;
}

/* Create a hosted BitriPay checkout intent for a canonical ACU package. Price is
   derived server-side from wallet PACKAGES — the client can never name its own
   price. Returns the hosted checkout_url (and QR payload if the API supplies one). */
export async function createBitriPayIntent({ user, packageId, origin }) {
  if (!bitriPayConfigured()) {
    throw new GatewayError(
      'BitriPay payments are not configured on this deployment (set BITRIPAY_SECRET_KEY and BITRIPAY_WEBHOOK_SECRET).',
      { status: 503, code: 'bitripay_not_configured' },
    );
  }
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new GatewayError(`Unknown package "${packageId}".`, { status: 400, code: 'unknown_package' });
  if (!user || typeof user !== 'string' || user.length > 128) {
    throw new GatewayError('A "user" id is required.', { status: 400, code: 'user_required' });
  }
  const base = (origin || '').replace(/\/$/, '');
  const total = pkg.acus + pkg.bonus;
  let amount, currency;
  if (CURRENCY === 'GBP') {
    currency = 'GBP';
    amount = toChargeUnits(pkg.priceGBP, currency);
  } else {
    const rate = await ratePerGbp(CURRENCY);
    if (!(rate > 0)) {
      throw new GatewayError('Could not determine the live BitriPay exchange rate. Set BITRIPAY_FX_PER_GBP as a fallback.', { status: 503, code: 'bitripay_no_rate' });
    }
    currency = CURRENCY;
    amount = toChargeUnits(pkg.priceGBP * rate, currency);
  }
  const orderId = `nf_${packageId}_${user.slice(-8)}_${Date.now().toString(36)}`;
  let res;
  try {
    res = await fetch(`${BASE}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount, currency,
        // The webhook credits ACU from packageId (authoritative); user + acu carried
        // for reconciliation. order_id is our fulfilment handle + idempotency anchor.
        metadata: { user, packageId, order_id: orderId, acu: total, product: 'nichefinder_acu' },
        success_url: `${base}/frontend/dashboard.html?payment=success`,
        cancel_url: `${base}/frontend/dashboard.html?payment=cancelled`,
      }),
    });
  } catch (err) {
    console.error(`[bitripay] intent request could not reach ${BASE}/checkout :: ${err.message}`);
    throw new GatewayError(`Could not reach BitriPay: ${err.message}`, { status: 502, code: 'bitripay_unreachable' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[bitripay] intent rejected: status=${res.status} body=${JSON.stringify(data).slice(0, 400)}`);
    throw new GatewayError(`BitriPay rejected the intent: ${data.error?.message || data.message || res.status}`, { status: 502, code: 'bitripay_error' });
  }
  const url = data.checkout_url || data.checkoutUrl || data.url;
  if (!url) {
    console.error(`[bitripay] intent accepted (status=${res.status}) but no checkout_url; keys=${Object.keys(data).join(',')}`);
    throw new GatewayError('BitriPay did not return a checkout URL.', { status: 502, code: 'bitripay_error' });
  }
  console.log(`[bitripay] intent created: ${data.intent_id || data.id} amount=${amount} ${currency}`);
  return { url, qr: data.qr || data.qr_payload || null, intentId: data.intent_id || data.id, currency, amount };
}

/* Verify BitriPay's webhook signature: header BitriPay-Signature: t=<ts>,v1=<hex>
   where hex = HMAC-SHA256(`${t}.${rawBody}`, webhook_secret). Rejects stale
   deliveries (> TOLERANCE_SEC) to blunt replay, and uses constant-time compare.
   HMAC is checked BEFORE the clock so a forged stale stamp can't leak timing. */
export function verifyBitriPaySignature(rawBody, sigHeader, secret = WHSEC, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(sigHeader || '').split(',').map((p) => p.trim());
  let t = null, v1 = null;
  for (const p of parts) {
    const [k, val] = p.split('=');
    if (k === 't') t = val;
    if (k === 'v1') v1 = val;
  }
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  let b;
  try { b = Buffer.from(v1); } catch { return false; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TOLERANCE_SEC) return false; // stale/replayed
  return true;
}

/* Settlement-only crediting: ACUs land exactly once per verified payment (order_id
   is the idempotency key). Credits only on payment.succeeded; refund/dispute/
   settlement events are acknowledged (and routed to ops) but never credit. */
export function handleBitriPayWebhook(rawBody, sigHeader) {
  if (!bitriPayConfigured()) {
    throw new GatewayError('BitriPay payments not configured.', { status: 503, code: 'bitripay_not_configured' });
  }
  if (!verifyBitriPaySignature(rawBody, sigHeader)) {
    throw new GatewayError('Invalid or stale webhook signature.', { status: 400, code: 'invalid_signature' });
  }
  let event;
  try { event = JSON.parse(rawBody); } catch {
    throw new GatewayError('Webhook body must be JSON.', { status: 400, code: 'invalid_json' });
  }
  const type = event.type || event.event;
  // Non-crediting events: acknowledge so BitriPay stops retrying; real handling
  // (refund claw-back, dispute case) is the Finance desk's job — logged here.
  if (type !== 'payment.succeeded') {
    if (['refund.settled', 'dispute.opened', 'payment.failed', 'settlement.posted'].includes(type)) {
      console.log(`[bitripay] received ${type} (acknowledged; routed to ops)`);
    }
    return { received: true, ignored: type || 'unknown' };
  }
  const obj = event.data?.object || event.data || event;
  const meta = obj.metadata || event.metadata || {};
  const user = meta.user;
  const packageId = meta.packageId;
  if (!user || !PACKAGES[packageId]) {
    throw new GatewayError('Webhook missing user/package metadata.', { status: 400, code: 'bad_metadata' });
  }
  const evId = meta.order_id || event.id || obj.receipt_id || obj.intent_id || obj.id;
  if (!evId) {
    throw new GatewayError('Webhook missing a settlement id for idempotency.', { status: 400, code: 'bad_metadata' });
  }
  const result = credit({ user, packageId, idempotencyKey: `bitripay_${evId}` });
  if (!result.replayed) {
    try { onPaidPurchase({ user, gbp: PACKAGES[packageId].priceGBP, purchaseKey: `bitripay_${evId}` }); }
    catch (e) { console.error('[referrals] bitripay reward failed:', e.message); }
    sendPurchaseReceipt({ user, packageId, method: 'BitriPay' });
    capiSend({
      eventName: 'Purchase', eventId: `bitripay_${evId}`,
      eventSourceUrl: `${(process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '')}/dashboard.html`,
      email: emailForUserId(user), value: PACKAGES[packageId].priceGBP, currency: 'GBP',
    });
  }
  return { received: true, credited: result.credited, replayed: result.replayed, user };
}
