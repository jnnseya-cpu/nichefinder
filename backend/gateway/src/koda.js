// KODA mobile-money payments — a second real-money door for ACU packages,
// alongside Stripe. KODA is the operator's own payment engine (kodajnn.com), so
// this adds no new vendor. Zero dependencies: hosted-checkout intents via the
// KODA REST API, webhook verification via HMAC-SHA256.
//
// Activate by setting these environment variables (KODA dashboard → Developers):
//   KODA_SECRET_KEY      sk_live_... (or sk_test_... to rehearse in sandbox)
//   KODA_WEBHOOK_SECRET  the endpoint's signing secret (x-koda-signature)
//   KODA_FX_PER_GBP      how many units of KODA_CURRENCY equal £1 (e.g. CDF/GBP)
// Optional:
//   KODA_API_BASE        default https://kodajnn.com/v1
//   KODA_CURRENCY        default CDF
//   KODA_OPERATORS       default orange_cd,mpesa_cd
// Without the required three, the mobile-money option returns 503 and the client
// simply falls back to the Stripe path — the same build runs pre- and post-setup.
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import { credit, PACKAGES } from './wallet.js';
import { onPaidPurchase } from './referrals.js';
import { sendPurchaseReceipt } from './payments.js';
import { emailForUserId } from './auth.js';
import { sendEvent as capiSend } from './meta-capi.js';

const KEY = process.env.KODA_SECRET_KEY || '';
const WHSEC = process.env.KODA_WEBHOOK_SECRET || '';
const BASE = (process.env.KODA_API_BASE || 'https://kodajnn.com/v1').replace(/\/$/, '');
const OPERATORS = (process.env.KODA_OPERATORS || 'orange_cd,mpesa_cd')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Customer-facing settlement currency for mobile money (default CDF). KODA has no
// FX endpoint — it charges in whatever currency we send — so we convert the GBP
// package price to this currency at a LIVE rate, giving the payer a correct local
// amount that tracks the market. (Set KODA_CURRENCY=GBP to skip conversion.)
const CURRENCY = process.env.KODA_CURRENCY || 'CDF';
// Rate resolution, in precedence order:
//   1. KODA_FX_PER_GBP — manual override / offline fallback (units of CURRENCY per £1).
//   2. Live public FX feed (KODA_RATE_URL; default open.er-api.com — free, no
//      account, covers CDF), cached for KODA_RATE_TTL_MS. Stale cache beats failing.
// The ACU credited is always fixed by the package, so FX only affects the amount
// the customer pays, never what their wallet receives.
const FX_PER_GBP = Number(process.env.KODA_FX_PER_GBP || 0);
const RATE_URL = process.env.KODA_RATE_URL || 'https://open.er-api.com/v6/latest/GBP';
const RATE_TTL_MS = Number(process.env.KODA_RATE_TTL_MS || 3600000);

export const kodaConfigured = () => Boolean(KEY && WHSEC);

let _rate = { at: 0, value: 0 };
// Units of `to` currency per £1, from the manual override or the live feed.
async function ratePerGbp(to) {
  if (FX_PER_GBP > 0) return FX_PER_GBP; // manual override — no network
  const now = Date.now();
  if (_rate.value > 0 && now - _rate.at < RATE_TTL_MS) return _rate.value; // fresh cache
  try {
    const res = await fetch(RATE_URL, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    const r = Number(data?.rates?.[to]);
    if (res.ok && r > 0) { _rate = { at: now, value: r }; return r; }
    console.error(`[koda] rate feed returned no ${to} rate (status=${res.status})`);
  } catch (err) {
    console.error(`[koda] rate feed unreachable: ${err.message}`);
  }
  return _rate.value > 0 ? _rate.value : 0; // stale-but-usable, else 0 → caller errors
}

/* Create a hosted KODA checkout intent for a canonical ACU package. Price is
   derived server-side from shared/nf-economy.js via wallet PACKAGES — the client
   can never name its own price. Returns the hosted checkout_url to redirect to. */
export async function createKodaIntent({ user, packageId, origin }) {
  if (!kodaConfigured()) {
    throw new GatewayError(
      'Mobile-money payments are not configured on this deployment (set KODA_SECRET_KEY and KODA_WEBHOOK_SECRET).',
      { status: 503, code: 'koda_not_configured' },
    );
  }
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new GatewayError(`Unknown package "${packageId}".`, { status: 400, code: 'unknown_package' });
  if (!user || typeof user !== 'string' || user.length > 128) {
    throw new GatewayError('A "user" id is required.', { status: 400, code: 'user_required' });
  }
  const base = (origin || '').replace(/\/$/, '');
  const total = pkg.acus + pkg.bonus;
  // Convert the GBP price to the payer's local currency at a live rate so the
  // mobile-money customer sees a correct amount to send. KODA_CURRENCY=GBP skips
  // conversion (quote in GBP).
  let amount, currency;
  if (CURRENCY === 'GBP') {
    amount = pkg.priceGBP;
    currency = 'GBP';
  } else {
    const rate = await ratePerGbp(CURRENCY);
    if (!(rate > 0)) {
      throw new GatewayError(
        'Could not determine the live mobile-money exchange rate. Set KODA_FX_PER_GBP as a fallback.',
        { status: 503, code: 'koda_no_rate' },
      );
    }
    amount = Math.round(pkg.priceGBP * rate);
    currency = CURRENCY;
  }
  const orderId = `nf_${packageId}_${user.slice(-8)}_${Date.now().toString(36)}`;
  let res;
  try {
    res = await fetch(`${BASE}/intents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount,
        currency,
        operators: OPERATORS,
        // The webhook credits ACU from packageId (authoritative); user + acu are
        // carried for reconciliation. order_id is KODA's fulfilment handle.
        metadata: { user, packageId, order_id: orderId, acu: total, product: 'nichefinder_acu' },
        success_url: `${base}/frontend/dashboard.html?payment=success`,
      }),
    });
  } catch (err) {
    console.error(`[koda] intent request could not reach ${BASE}/intents :: ${err.message}`);
    throw new GatewayError(`Could not reach KODA: ${err.message}`, { status: 502, code: 'koda_unreachable' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[koda] intent rejected: status=${res.status} body=${JSON.stringify(data).slice(0, 400)}`);
    throw new GatewayError(`KODA rejected the intent: ${data.error?.message || data.message || res.status}`, {
      status: 502,
      code: 'koda_error',
    });
  }
  const url = data.checkout_url || data.checkoutUrl;
  if (!url) {
    console.error(`[koda] intent accepted (status=${res.status}) but no checkout_url in response; keys=${Object.keys(data).join(',')} body=${JSON.stringify(data).slice(0, 400)}`);
    throw new GatewayError('KODA did not return a checkout URL.', { status: 502, code: 'koda_error' });
  }
  console.log(`[koda] intent created: ${data.intent_id || data.id} amount=${amount} ${currency}`);
  return { url, intentId: data.intent_id || data.id, currency, amount };
}

/* Verify KODA's webhook signature: x-koda-signature = HMAC-SHA256(rawBody,
   webhook_secret) as lowercase hex. Constant-time compare. */
export function verifyKodaSignature(rawBody, sigHeader, secret = WHSEC) {
  const sig = String(sigHeader || '').trim();
  if (!sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  let b;
  try { b = Buffer.from(sig); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Settlement-only crediting: ACUs land exactly once per verified payment (the
   event/receipt id is the idempotency key), only on payment.verified. Everything
   else is acknowledged and ignored. Metadata shape is handled defensively across
   a few nesting levels so we're robust to the exact payload envelope. */
export function handleKodaWebhook(rawBody, sigHeader) {
  if (!kodaConfigured()) {
    throw new GatewayError('Mobile-money payments not configured.', { status: 503, code: 'koda_not_configured' });
  }
  if (!verifyKodaSignature(rawBody, sigHeader)) {
    throw new GatewayError('Invalid webhook signature.', { status: 400, code: 'invalid_signature' });
  }
  let event;
  try { event = JSON.parse(rawBody); } catch {
    throw new GatewayError('Webhook body must be JSON.', { status: 400, code: 'invalid_json' });
  }
  const type = event.type || event.event;
  if (type !== 'payment.verified') return { received: true, ignored: type || 'unknown' };
  const obj = event.data?.object || event.data || event;
  const meta = obj.metadata || event.metadata || {};
  const user = meta.user;
  const packageId = meta.packageId;
  if (!user || !PACKAGES[packageId]) {
    throw new GatewayError('Webhook missing user/package metadata.', { status: 400, code: 'bad_metadata' });
  }
  // Idempotency key: prefer the order_id WE minted in the intent (guaranteed
  // present + unique per purchase, and echoed back in metadata) so replays are
  // caught even if KODA's own event id shifts. Fall back to KODA's ids. If none
  // resolve, refuse rather than credit under `koda_undefined` (which would
  // collapse distinct payments onto one key).
  const evId = meta.order_id || event.id || obj.receipt_id || obj.intent_id || obj.id;
  if (!evId) {
    throw new GatewayError('Webhook missing a settlement id for idempotency.', { status: 400, code: 'bad_metadata' });
  }
  const result = credit({ user, packageId, idempotencyKey: `koda_${evId}` });
  // Reward the referrer once, and email the buyer a receipt — only on the first
  // (non-replayed) settlement.
  if (!result.replayed) {
    try { onPaidPurchase({ user, gbp: PACKAGES[packageId].priceGBP, purchaseKey: `koda_${evId}` }); }
    catch (e) { console.error('[referrals] koda reward failed:', e.message); }
    sendPurchaseReceipt({ user, packageId, method: 'mobile money' });
    // Server-side Purchase (mobile-money has no browser pixel event to dedup with).
    capiSend({
      eventName: 'Purchase', eventId: `koda_${evId}`,
      eventSourceUrl: `${(process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '')}/dashboard.html`,
      email: emailForUserId(user), value: PACKAGES[packageId].priceGBP, currency: 'GBP',
    });
  }
  return { received: true, credited: result.credited, replayed: result.replayed, user };
}
