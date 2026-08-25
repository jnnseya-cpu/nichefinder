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
import { credit, PACKAGES, PLANS, peekWallet, creditPlanAllotment, endPlan, clawback } from './wallet.js';
import { onPaidPurchase, onPurchaseReversed } from './referrals.js';
import { emailForUserId } from './auth.js';
import { sendMail } from './mailer.js';
import { sendEvent as capiSend } from './meta-capi.js';

const CAPI_ORIGIN = () => (process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || '';
// Overridable for the full-cycle payment test (points at a local Stripe mock).
const STRIPE_API = process.env.STRIPE_API_BASE || 'https://api.stripe.com';

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
    // Stamp the SAME identity on the PaymentIntent so it flows down to the
    // Charge. Refund and dispute webhooks carry a charge (not the session), so
    // without this we could never map a chargeback back to the wallet to claw
    // the ACU back. This is what makes refund/dispute reversal possible.
    'payment_intent_data[metadata][user]': user,
    'payment_intent_data[metadata][packageId]': packageId,
    success_url: `${base}/frontend/dashboard.html?payment=success&value=${pkg.priceGBP}&currency=GBP&item=${packageId}&sid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/frontend/dashboard.html?payment=cancelled`,
  });
  const res = await fetch(`${STRIPE_API}/v1/checkout/sessions`, {
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

/* Create a hosted Stripe Checkout session for a recurring subscription PLAN.
   mode=subscription with an inline monthly recurring price (no pre-created Stripe
   Price needed). Metadata is stamped on BOTH the session and the subscription, so
   every renewal invoice carries the user + plan for the settlement webhook. */
export async function createSubscriptionCheckout({ user, planId, origin }) {
  if (!paymentsConfigured()) {
    throw new GatewayError(
      'Payments are not configured on this deployment (set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET).',
      { status: 503, code: 'payment_not_configured' },
    );
  }
  const plan = PLANS[planId];
  if (!plan || !plan.selfServe || !plan.priceGBP) {
    throw new GatewayError(`Unknown or non-self-serve plan "${planId}".`, { status: 400, code: 'unknown_plan' });
  }
  if (!user || typeof user !== 'string' || user.length > 128) {
    throw new GatewayError('A "user" id is required.', { status: 400, code: 'user_required' });
  }
  const base = (origin || '').replace(/\/$/, '');
  const body = form({
    mode: 'subscription',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'gbp',
    'line_items[0][price_data][unit_amount]': String(plan.priceGBP * 100),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': `Niche Finder — ${plan.name} plan (${plan.acusPerMonth.toLocaleString('en-US')} ACU/mo)`,
    'metadata[user]': user,
    'metadata[planId]': planId,
    'subscription_data[metadata][user]': user,
    'subscription_data[metadata][planId]': planId,
    success_url: `${base}/frontend/dashboard.html?payment=success&sub=1&value=${plan.priceGBP}&currency=GBP&item=${planId}&sid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/frontend/dashboard.html?payment=cancelled`,
  });
  const res = await fetch(`${STRIPE_API}/v1/checkout/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const session = await res.json();
  if (!res.ok) {
    throw new GatewayError(`Stripe rejected the subscription checkout: ${session.error?.message || res.status}`, {
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

/* Email a receipt after a settled purchase/renewal. Fire-and-forget: never let a
   mail hiccup fail the webhook (the money + ACUs are already settled). Skips
   silently for guest/anonymous wallets with no account email. */
function receiptEmail({ user, heading, subject, rows }) {
  try {
    const email = emailForUserId(user);
    if (!email) return;                    // guest wallet — no account on file
    const origin = (process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '');
    const text = `${heading}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\nOpen your dashboard: ${origin}/dashboard.html\n\n— Niche Finder`;
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1C2233">` +
      `<h2 style="font-family:Georgia,serif;color:#1C2233">${heading}</h2>` +
      `<table style="border-collapse:collapse;width:100%;font-size:14px;margin:14px 0">` +
      rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#5D6575">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600">${v}</td></tr>`).join('') +
      `</table>` +
      `<p><a href="${origin}/dashboard.html" style="display:inline-block;background:#E8A61A;color:#241A02;font-weight:700;text-decoration:none;padding:11px 22px;border-radius:8px">Open your dashboard →</a></p>` +
      `<p style="color:#8A8F9C;font-size:12px;margin-top:18px">Niche Finder — the operating system for venture creation.</p></div>`;
    sendMail({ to: email, subject, text, html }).catch((e) => console.error('[receipt] send failed:', e.message));
  } catch (e) { console.error('[receipt] build failed:', e.message); }
}

/* Receipt for a one-time ACU package (Stripe or KODA). Exported so KODA reuses it. */
export function sendPurchaseReceipt({ user, packageId, method = 'card' }) {
  const pkg = PACKAGES[packageId];
  if (!pkg) return;
  const acu = (pkg.acus || 0) + (pkg.bonus || 0);
  const balance = (peekWallet(user) || {}).paid;
  const rows = [
    ['Package', pkg.name],
    ['Amount paid', `£${pkg.priceGBP} (${method})`],
    ['ACU credited', `${acu}${pkg.bonus ? ` (${pkg.acus} + ${pkg.bonus} bonus)` : ''}`],
  ];
  if (balance != null) rows.push(['New balance', `${balance} ACU`]);
  receiptEmail({ user, heading: 'Payment received', subject: `Your Niche Finder receipt — ${acu} ACU credited`, rows });
}

/* Receipt for a subscription plan's monthly allotment (first payment + renewals). */
export function sendSubscriptionReceipt({ user, planId, method = 'card', renewal = false }) {
  const plan = PLANS[planId];
  if (!plan) return;
  const balance = (peekWallet(user) || {}).paid;
  const rows = [
    ['Plan', `${plan.name} (£${plan.priceGBP}/mo)`],
    [renewal ? 'Renewal' : 'Subscription started', new Date().toISOString().slice(0, 10)],
    ['ACU credited this cycle', `${plan.acusPerMonth}`],
  ];
  if (balance != null) rows.push(['New balance', `${balance} ACU`]);
  receiptEmail({
    user,
    heading: renewal ? 'Subscription renewed' : 'Subscription active',
    subject: `Your ${plan.name} plan — ${plan.acusPerMonth} ACU credited`,
    rows,
  });
}

/* Settlement crediting. Each event credits exactly once (idempotency key), then
   everything else is acknowledged and ignored:
     • checkout.session.completed (mode=payment) → one-time ACU package
     • invoice.paid / invoice.payment_succeeded  → subscription monthly allotment
       (first invoice AND every renewal)
     • customer.subscription.deleted             → mark the plan ended
   Subscription checkout.session.completed is intentionally NOT credited here —
   its first invoice.paid does the crediting, so we never double-count. */
export async function handleWebhook(rawBody, sigHeader) {
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
  const obj = event.data?.object || {};

  if (event.type === 'checkout.session.completed') {
    if (obj.mode === 'subscription') {
      // Crediting happens on invoice.paid; here we only fire the server-side
      // Subscribe conversion (deduped with the browser via the session id).
      const suser = obj.metadata?.user; const splan = obj.metadata?.planId;
      if (suser && PLANS[splan]) {
        capiSend({ eventName: 'Subscribe', eventId: obj.id, eventSourceUrl: `${CAPI_ORIGIN()}/dashboard.html`,
          email: emailForUserId(suser), value: PLANS[splan].priceGBP, currency: 'GBP' });
      }
      return { received: true, ignored: 'subscription_checkout (credited via invoice.paid)' };
    }
    if (obj.payment_status !== 'paid') return { received: true, ignored: 'not_paid' };
    const user = obj.metadata?.user;
    const packageId = obj.metadata?.packageId;
    if (!user || !PACKAGES[packageId]) {
      throw new GatewayError('Webhook session missing user/package metadata.', { status: 400, code: 'bad_metadata' });
    }
    const result = credit({ user, packageId, idempotencyKey: `stripe_${event.id}` });
    if (!result.replayed) {
      // Key the referral on the PaymentIntent (stable across the purchase's whole
      // lifecycle), NOT the webhook event id — so a later refund/chargeback
      // webhook (which carries the charge + its payment_intent, never the
      // original event id) can reverse the exact commission we paid.
      const pi = obj.payment_intent || obj.id;
      try { onPaidPurchase({ user, gbp: PACKAGES[packageId].priceGBP, purchaseKey: `pi_${pi}` }); }
      catch (e) { console.error('[referrals] stripe reward failed:', e.message); }
      sendPurchaseReceipt({ user, packageId, method: 'card' });
      // Server-side Purchase (deduped with the browser via the checkout session id).
      capiSend({ eventName: 'Purchase', eventId: obj.id, eventSourceUrl: `${CAPI_ORIGIN()}/dashboard.html`,
        email: emailForUserId(user), value: PACKAGES[packageId].priceGBP, currency: 'GBP' });
    }
    return { received: true, credited: result.credited, replayed: result.replayed, user };
  }

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    // Metadata rides on the subscription; read it from wherever the API version
    // surfaces it on the invoice.
    const meta = obj.subscription_details?.metadata || obj.lines?.data?.[0]?.metadata || obj.metadata || {};
    const user = meta.user;
    const planId = meta.planId;
    if (!user || !PLANS[planId]) return { received: true, ignored: 'non_plan_invoice' };
    const invId = obj.id || `${obj.subscription}_${obj.period_end || obj.created || event.id}`;
    const result = creditPlanAllotment({ user, planId, idempotencyKey: `stripe_inv_${invId}` });
    if (!result.replayed) {
      // Reward the referrer only on the FIRST invoice of a subscription, never on
      // every renewal (that would over-pay the referrer monthly).
      if (obj.billing_reason === 'subscription_create') {
        try { onPaidPurchase({ user, gbp: PLANS[planId].priceGBP, purchaseKey: `stripe_inv_${invId}` }); }
        catch (e) { console.error('[referrals] subscription reward failed:', e.message); }
      }
      sendSubscriptionReceipt({ user, planId, method: 'card', renewal: obj.billing_reason === 'subscription_cycle' });
      // Renewals have no browser event, so fire the server-side Subscribe here.
      // The first invoice's Subscribe already fired at checkout.session.completed.
      if (obj.billing_reason === 'subscription_cycle') {
        capiSend({ eventName: 'Subscribe', eventId: `inv_${invId}`, eventSourceUrl: `${CAPI_ORIGIN()}/dashboard.html`,
          email: emailForUserId(user), value: PLANS[planId].priceGBP, currency: 'GBP' });
      }
    }
    return { received: true, credited: result.credited, replayed: result.replayed, user, plan: planId };
  }

  if (event.type === 'customer.subscription.deleted') {
    const user = obj.metadata?.user;
    if (!user) return { received: true, ignored: 'no_user_metadata' };
    const r = endPlan({ user });
    return { received: true, planEnded: r.ended, user };
  }

  // ---- money taken back: refunds & disputes → claw the ACU back ----
  // A buyer who tops up, spends, then refunds/charges back would otherwise keep
  // the value for free. On any reversal we debit the granted ACU (clamped at
  // what's left — the spent remainder is a recorded loss, not a silent one),
  // reverse the referral commission, and — for adversarial disputes — freeze the
  // wallet so they can't refund-then-spend a fresh top-up while the case is open.

  // charge.refunded — full or partial. Each refund object has a stable id, so we
  // key idempotency on the refund (not the event) and reverse exactly its slice.
  if (event.type === 'charge.refunded' || event.type === 'refund.created' || event.type === 'refund.updated') {
    const charge = event.type === 'charge.refunded' ? obj : null;
    const piId = obj.payment_intent || charge?.payment_intent;
    // Metadata lives on the PaymentIntent (Stripe does NOT copy it to the
    // Charge). A test may stamp it on the object directly; production reads it
    // from the PI. Either way we never clawback without a confirmed mapping.
    const meta = (obj.metadata && obj.metadata.user) ? obj.metadata : await fetchPaymentIntentMeta(piId);
    const user = meta?.user, packageId = meta?.packageId;
    if (!user || !PACKAGES[packageId]) return { received: true, ignored: 'refund_unmapped' };
    const totalAcu = PACKAGES[packageId].acus + PACKAGES[packageId].bonus;
    const base = Number(charge?.amount) || Number(meta?.amount) || (PACKAGES[packageId].priceGBP * 100);
    // Prefer the individual refund slice for a correct partial amount + a stable
    // idempotency id; fall back to the charge's cumulative amount_refunded.
    const slice = charge?.refunds?.data?.[charge.refunds.data.length - 1];
    const refundId = (event.type === 'charge.refunded' ? slice?.id : obj.id) || `${event.id}`;
    const refundedMinor = (event.type === 'charge.refunded' ? (slice?.amount ?? charge?.amount_refunded) : obj.amount) || 0;
    const reverseAcu = base > 0 ? Math.round(totalAcu * Math.min(refundedMinor, base) / base) : totalAcu;
    if (reverseAcu <= 0) return { received: true, ignored: 'zero_refund' };
    const r = clawback({ user, amount: reverseAcu, reason: `Stripe refund ${packageId}`, idempotencyKey: `stripe_refund_${refundId}` });
    if (!r.replayed) {
      if (piId) { try { onPurchaseReversed({ user, purchaseKey: `pi_${piId}` }); } catch (e) { console.error('[referrals] reversal failed:', e.message); } }
      console.warn(`[payments] refund reversed ${r.clawedBack}/${reverseAcu} ACU user=${String(user).slice(-8)} shortfall=${r.shortfall}`);
    }
    return { received: true, reversed: r.clawedBack, shortfall: r.shortfall, replayed: r.replayed, user };
  }

  // Chargeback/dispute — adversarial. Map via the PaymentIntent, claw the FULL
  // package back, and FREEZE the wallet until the dispute resolves so they can't
  // refund-then-spend a fresh top-up while the case is open.
  if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.funds_withdrawn') {
    const piId = obj.payment_intent;
    const meta = (obj.metadata && obj.metadata.user) ? obj.metadata : await fetchPaymentIntentMeta(piId);
    const user = meta?.user, packageId = meta?.packageId;
    if (!user || !PACKAGES[packageId]) return { received: true, ignored: 'dispute_unmapped' };
    const totalAcu = PACKAGES[packageId].acus + PACKAGES[packageId].bonus;
    const r = clawback({ user, amount: totalAcu, reason: `Chargeback ${packageId}`, idempotencyKey: `stripe_dispute_${obj.charge || piId}`, freeze: true });
    if (!r.replayed) {
      if (piId) { try { onPurchaseReversed({ user, purchaseKey: `pi_${piId}` }); } catch (e) { console.error('[referrals] reversal failed:', e.message); } }
      console.warn(`[payments] CHARGEBACK reversed ${r.clawedBack}/${totalAcu} ACU + froze wallet user=${String(user).slice(-8)} shortfall=${r.shortfall}`);
    }
    return { received: true, reversed: r.clawedBack, shortfall: r.shortfall, frozen: r.frozen, replayed: r.replayed, user };
  }

  return { received: true, ignored: event.type };
}

/* Read the {user, packageId} we stamped on a PaymentIntent's metadata. Refund
   and dispute webhooks don't echo our metadata (it lives on the PI, and Stripe
   never copies it onto the Charge), so we fetch the PI by id. Returns null on
   any failure — the caller then treats the event as 'unmapped' and does NOTHING,
   which is the safe default (a wrong clawback would be worse than a missed one,
   and Stripe retries the webhook so a transient fetch error is recoverable). */
export async function fetchPaymentIntentMeta(piId) {
  if (!piId || !KEY) return null;
  try {
    const res = await fetch(`${STRIPE_API}/v1/payment_intents/${encodeURIComponent(piId)}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) { console.error(`[payments] PI fetch ${piId} failed: ${res.status}`); return null; }
    const pi = await res.json();
    const m = pi.metadata || {};
    if (!m.user) return null;
    return { user: m.user, packageId: m.packageId, amount: pi.amount };
  } catch (e) {
    console.error(`[payments] PI fetch ${piId} error: ${e.message}`);
    return null;
  }
}
