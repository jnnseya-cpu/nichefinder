// Meta Conversions API (server-side pixel). Fires the money events (Purchase,
// Subscribe, Lead) from the gateway so tracking survives ad-blockers and iOS
// ITP. Deduplicated against the browser pixel by a shared event_id, so an event
// is counted once even when both fire. Zero dependencies (Graph REST + Node
// crypto), same hand-rolled style as the Stripe integration.
//
// Activate with (Meta Events Manager → Settings → Conversions API):
//   META_CAPI_TOKEN        the CAPI access token (required to send)
//   META_PIXEL_ID          defaults to the site pixel 1322395659736364
//   META_TEST_EVENT_CODE   optional — routes events to Test Events (e.g. TEST64707)
// Inert (no-op) until META_CAPI_TOKEN is set, so the same build runs pre/post setup.
import crypto from 'node:crypto';

const PIXEL_ID = process.env.META_PIXEL_ID || '1322395659736364';
const TOKEN = process.env.META_CAPI_TOKEN || '';
const TEST_CODE = process.env.META_TEST_EVENT_CODE || '';
const GRAPH = process.env.META_GRAPH_BASE || 'https://graph.facebook.com';
const API_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';

export function capiConfigured() { return Boolean(TOKEN && PIXEL_ID); }

// Meta requires SHA-256 hex of normalised (trimmed, lowercased) PII.
function hash(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s ? crypto.createHash('sha256').update(s).digest('hex') : null;
}

/* Fire one server-side event. Fire-and-forget: never throw into the caller (the
   money is already settled). `eventId` MUST match the browser pixel's eventID
   for the same action so Meta deduplicates. */
export async function sendEvent({
  eventName, eventId, eventSourceUrl, actionSource = 'website',
  email, clientIp, userAgent, fbp, fbc,
  value, currency, custom,
}) {
  if (!capiConfigured()) return { sent: false, reason: 'not_configured' };
  try {
    const userData = {};
    const em = hash(email);
    if (em) userData.em = [em];
    if (clientIp) userData.client_ip_address = String(clientIp);
    if (userAgent) userData.client_user_agent = String(userAgent);
    if (fbp) userData.fbp = String(fbp);
    if (fbc) userData.fbc = String(fbc);

    const customData = Object.assign({}, custom || {});
    if (value != null) customData.value = Number(value);
    if (currency) customData.currency = String(currency);

    const event = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: actionSource,
      user_data: userData,
    };
    if (eventId) event.event_id = String(eventId);
    if (eventSourceUrl) event.event_source_url = eventSourceUrl;
    if (Object.keys(customData).length) event.custom_data = customData;

    const body = { data: [event] };
    if (TEST_CODE) body.test_event_code = TEST_CODE;

    const res = await fetch(`${GRAPH}/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(`[capi] ${eventName} rejected: ${res.status} ${t.slice(0, 300)}`);
      return { sent: false, status: res.status };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[capi] ${eventName} failed: ${err.message}`);
    return { sent: false, error: err.message };
  }
}
