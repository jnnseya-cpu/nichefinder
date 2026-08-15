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

const KEY = process.env.KODA_SECRET_KEY || '';
const WHSEC = process.env.KODA_WEBHOOK_SECRET || '';
const BASE = (process.env.KODA_API_BASE || 'https://kodajnn.com/v1').replace(/\/$/, '');
const CURRENCY = process.env.KODA_CURRENCY || 'CDF';
const OPERATORS = (process.env.KODA_OPERATORS || 'orange_cd,mpesa_cd')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Units of KODA_CURRENCY per £1. The ACU credited is fixed by the package, so
// this only sets the amount the customer is charged in local currency — the
// wallet always receives exactly the package's ACU regardless of FX drift.
const FX_PER_GBP = Number(process.env.KODA_FX_PER_GBP || 0);

export const kodaConfigured = () => Boolean(KEY && WHSEC && FX_PER_GBP > 0);

/* Create a hosted KODA checkout intent for a canonical ACU package. Price is
   derived server-side from shared/nf-economy.js via wallet PACKAGES — the client
   can never name its own price. Returns the hosted checkout_url to redirect to. */
export async function createKodaIntent({ user, packageId, origin }) {
  if (!kodaConfigured()) {
    throw new GatewayError(
      'Mobile-money payments are not configured on this deployment (set KODA_SECRET_KEY, KODA_WEBHOOK_SECRET, KODA_FX_PER_GBP).',
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
  const amount = Math.round(pkg.priceGBP * FX_PER_GBP);
  const orderId = `nf_${packageId}_${user.slice(-8)}_${Date.now().toString(36)}`;
  let res;
  try {
    res = await fetch(`${BASE}/intents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount,
        currency: CURRENCY,
        operators: OPERATORS,
        // The webhook credits ACU from packageId (authoritative); user + acu are
        // carried for reconciliation. order_id is KODA's fulfilment handle.
        metadata: { user, packageId, order_id: orderId, acu: total, product: 'nichefinder_acu' },
        success_url: `${base}/frontend/dashboard.html?payment=success`,
      }),
    });
  } catch (err) {
    throw new GatewayError(`Could not reach KODA: ${err.message}`, { status: 502, code: 'koda_unreachable' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GatewayError(`KODA rejected the intent: ${data.error?.message || data.message || res.status}`, {
      status: 502,
      code: 'koda_error',
    });
  }
  const url = data.checkout_url || data.checkoutUrl;
  if (!url) throw new GatewayError('KODA did not return a checkout URL.', { status: 502, code: 'koda_error' });
  return { url, intentId: data.intent_id || data.id, currency: CURRENCY, amount };
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
  const evId = event.id || obj.receipt_id || obj.intent_id || obj.id || meta.order_id;
  const result = credit({ user, packageId, idempotencyKey: `koda_${evId}` });
  // Reward the referrer once, only on the first (non-replayed) settlement.
  if (!result.replayed) {
    try { onPaidPurchase({ user, gbp: PACKAGES[packageId].priceGBP, purchaseKey: `koda_${evId}` }); }
    catch (e) { console.error('[referrals] koda reward failed:', e.message); }
  }
  return { received: true, credited: result.credited, replayed: result.replayed, user };
}
