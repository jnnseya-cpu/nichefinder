// Stripe payments — the real-money door for ACU packages. Zero dependencies:
// Checkout Sessions via the Stripe REST API, webhook verification via HMAC.
//
// Activate by setting two environment variables (Stripe Dashboard → Developers):
//   STRIPE_SECRET_KEY      sk_live_... (or sk_test_... to rehearse)
//   STRIPE_WEBHOOK_SECRET  whsec_...   (from the webhook endpoint you create,
//                                       pointed at POST /v1/payments/stripe-webhook)
// Without them, checkout returns 503 payment_not_configured and the client
// falls back to demo crediting — so the same build runs pre- and post-launch.
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import { credit, PACKAGES } from './wallet.js';

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || '';

export const paymentsConfigured = () => Boolean(KEY && WHSEC);

function form(data) {
  return Object.entries(data)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

/* Create a hosted Stripe Checkout session for a canonical ACU package.
   Price comes from shared/nf-economy.js via wallet PACKAGES — the client can
   never name its own price. */
export async function createCheckout({ user, packageId, origin }) {
  if (!paymentsConfigured()) {
    throw new GatewayError(
      'Payments are not configured on this deployment (set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET).',
      { status: 503, code: 'payment_not_configured' },
    );
  }
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new GatewayError(`Unknown package "${packageId}".`, { status: 400, code: 'unknown_package' });
  if (!user || typeof user !== 'string' || user.length > 128) {
    throw new GatewayError('A "user" id is required.', { status: 400, code: 'user_required' });
  }
  const base = (origin || '').replace(/\/$/, '');
  const total = pkg.acus + pkg.bonus;
  const body = form({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'gbp',
    'line_items[0][price_data][unit_amount]': String(pkg.priceGBP * 100),
    'line_items[0][price_data][product_data][name]': `Niche Finder — ${pkg.name} package (${total.toLocaleString('en-US')} ACU)`,
    'metadata[user]': user,
    'metadata[packageId]': packageId,
    success_url: `${base}/frontend/dashboard.html?payment=success`,
    cancel_url: `${base}/frontend/dashboard.html?payment=cancelled`,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const session = await res.json();
  if (!res.ok) {
    throw new GatewayError(`Stripe rejected the checkout: ${session.error?.message || res.status}`, {
      status: 502,
      code: 'stripe_error',
    });
  }
  return { url: session.url, sessionId: session.id };
}

/* Verify Stripe's signature scheme: header "t=...,v1=..." where
   v1 = HMAC-SHA256(whsec, `${t}.${rawBody}`). 5-minute replay tolerance. */
export function verifySignature(rawBody, sigHeader, secret = WHSEC, toleranceSec = 300) {
  const parts = Object.fromEntries(
    String(sigHeader || '')
      .split(',')
      .map((p) => p.split('=').map((s) => s.trim()))
      .filter((p) => p.length === 2),
  );
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Settlement-only crediting: ACUs land exactly once per Stripe event
   (event.id is the idempotency key), only on checkout.session.completed
   with payment_status=paid. Everything else is acknowledged and ignored. */
export function handleWebhook(rawBody, sigHeader) {
  if (!paymentsConfigured()) {
    throw new GatewayError('Payments not configured.', { status: 503, code: 'payment_not_configured' });
  }
  if (!verifySignature(rawBody, sigHeader)) {
    throw new GatewayError('Invalid webhook signature.', { status: 400, code: 'invalid_signature' });
  }
  let event;
  try { event = JSON.parse(rawBody); } catch {
    throw new GatewayError('Webhook body must be JSON.', { status: 400, code: 'invalid_json' });
  }
  if (event.type !== 'checkout.session.completed') return { received: true, ignored: event.type };
  const session = event.data?.object || {};
  if (session.payment_status !== 'paid') return { received: true, ignored: 'not_paid' };
  const user = session.metadata?.user;
  const packageId = session.metadata?.packageId;
  if (!user || !PACKAGES[packageId]) {
    throw new GatewayError('Webhook session missing user/package metadata.', { status: 400, code: 'bad_metadata' });
  }
  const result = credit({ user, packageId, idempotencyKey: `stripe_${event.id}` });
  return { received: true, credited: result.credited, replayed: result.replayed, user };
}
