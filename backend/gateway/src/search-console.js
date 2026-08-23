// Google Search Console — real organic performance per article (impressions,
// clicks, average position) merged onto the SEO console. Zero dependencies:
// a service-account JWT is signed with Node crypto (RS256), exchanged for an
// access token, and used against the Search Analytics API. Results are cached
// (GSC data lags ~2 days and the API is rate-limited).
//
// Activate (all from the environment — no secrets in the repo):
//   GSC_SITE_URL          the verified property, e.g. "sc-domain:nichefinderhq.com"
//                         or "https://nichefinderhq.com/"
//   GSC_SA_EMAIL          the service account email (added as a user in Search
//                         Console → Settings → Users and permissions)
//   GSC_SA_PRIVATE_KEY    that service account's private key (PEM; \n escaped is fine)
// Inert (configured=false) until all three are set.
import crypto from 'node:crypto';

const SITE = process.env.GSC_SITE_URL || '';
const SA_EMAIL = process.env.GSC_SA_EMAIL || '';
const SA_KEY = (process.env.GSC_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const TOKEN_URL = process.env.GSC_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.GSC_API_BASE || 'https://searchconsole.googleapis.com';
const CACHE_MS = Number(process.env.GSC_CACHE_MS || 6 * 3600 * 1000);

export function gscConfigured() { return Boolean(SITE && SA_EMAIL && SA_KEY); }

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function ymd(d) { return d.toISOString().slice(0, 10); }

let tokenCache = { token: null, exp: 0 };
async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(SA_KEY));
  const jwt = `${header}.${claim}.${sig}`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('gsc_token: ' + (d.error_description || d.error || res.status));
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// Map a result page URL to an article slug. Article pages carry ?s=<slug>.
function slugOf(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const s = u.searchParams.get('s');
    if (s) return s.toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    return seg.endsWith('.html') ? '' : seg.toLowerCase();
  } catch { return ''; }
}

async function queryByPage() {
  const token = await accessToken();
  const end = new Date(Date.now() - 3 * 864e5);   // GSC lags ~2-3 days
  const start = new Date(Date.now() - 30 * 864e5);
  const res = await fetch(`${API_BASE}/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), dimensions: ['page'], rowLimit: 1000 }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('gsc_query: ' + (d.error && d.error.message ? d.error.message : res.status));
  return { rows: d.rows || [], range: { start: ymd(start), end: ymd(end) } };
}

let cache = { at: 0, data: null };

// Per-slug + total organic metrics for the admin SEO console. Cached; returns a
// safe empty shape when not configured or on error (never throws to the caller).
export async function getSearchConsole({ force } = {}) {
  if (!gscConfigured()) return { configured: false, bySlug: {}, totals: { impressions: 0, clicks: 0, avgPosition: 0 } };
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    const { rows, range } = await queryByPage();
    const bySlug = {};
    let tImp = 0, tClk = 0, posW = 0;
    for (const r of rows) {
      const slug = slugOf(r.keys && r.keys[0]);
      if (!slug) continue;
      const e = bySlug[slug] || (bySlug[slug] = { impressions: 0, clicks: 0, _pw: 0 });
      const imp = r.impressions || 0;
      e.impressions += imp; e.clicks += r.clicks || 0; e._pw += (r.position || 0) * imp;
      tImp += imp; tClk += r.clicks || 0; posW += (r.position || 0) * imp;
    }
    for (const s in bySlug) {
      const e = bySlug[s];
      e.position = e.impressions ? Number((e._pw / e.impressions).toFixed(1)) : 0;
      e.ctr = e.impressions ? Number((e.clicks / e.impressions * 100).toFixed(1)) : 0;
      delete e._pw;
    }
    const data = {
      configured: true, bySlug, range,
      totals: { impressions: tImp, clicks: tClk, avgPosition: tImp ? Number((posW / tImp).toFixed(1)) : 0, ctr: tImp ? Number((tClk / tImp * 100).toFixed(1)) : 0 },
      updatedAt: Date.now(),
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.error('[gsc] query failed:', err.message);
    return { configured: true, error: err.message, bySlug: {}, totals: { impressions: 0, clicks: 0, avgPosition: 0 } };
  }
}
