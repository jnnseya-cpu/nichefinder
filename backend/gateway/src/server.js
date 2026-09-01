import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { GatewayError } from './errors.js';
import { route, availableProviders, meterAcu } from './router.js';
import { getWallet, getLedger, charge, credit, grant, summary, deleteWallet, migratePaid, PACKAGES, isFrozen, reserve, settleHold, releaseHold } from './wallet.js';
import { createCheckout, createSubscriptionCheckout, handleWebhook, paymentsConfigured } from './payments.js';
import { createKodaIntent, handleKodaWebhook, kodaConfigured } from './koda.js';
import { summaryFor as referralSummary, listPartners, deleteUserData as deleteReferralData } from './referrals.js';
import { saveDoc, getDoc, listDocs, deleteUserDocs } from './docstore.js';
import { issueChallenge, verifyChallenge } from './human.js';
import { signup, login, logout, sessionFor, requestReset, resetPassword, listUsers, resolveUserId, emailForUserId, setRole, setDisabled, userByEmail, updateProfile, setMedia, changePassword, deleteAccount } from './auth.js';
import { sendMail, mailConfigured } from './mailer.js';
import { publishArticle, unpublishArticle, listArticles, getArticle, recordView, articleStats } from './articles.js';
import { sendEvent as capiSend } from './meta-capi.js';
import { getSearchConsole, gscConfigured } from './search-console.js';
import { startNewsletterScheduler, sendNewsletterOnce, handleUnsubscribe } from './newsletter.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEADS_PATH = process.env.LEADS_STORE || path.join(process.cwd(), 'data', 'leads.jsonl');
// Profile pictures + covers live on disk (not sensitive like money) and are
// served by /v1/media. Kept out of the encrypted store to keep it small.
const AVATAR_DIR = process.env.AVATAR_STORE || path.join(process.cwd(), 'data', 'avatars');
const IMG_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// Maintenance mode: an operator toggle (admin console) that pauses AI generation
// site-wide. Persisted as a flag file so it survives restarts.
const MAINT_FLAG = process.env.MAINT_FLAG || path.join(process.cwd(), 'data', 'maintenance.flag');
let maintenanceOn = false;
try { maintenanceOn = fs.existsSync(MAINT_FLAG); } catch { /* default off */ }
function setMaintenance(on) {
  maintenanceOn = !!on;
  try {
    if (on) { fs.mkdirSync(path.dirname(MAINT_FLAG), { recursive: true }); fs.writeFileSync(MAINT_FLAG, '1'); }
    else fs.rmSync(MAINT_FLAG, { force: true });
  } catch { /* best-effort; in-memory flag still applies */ }
}

/* Per-IP rate limit: cheap, in-memory, resets each minute. Protects the
   public deployment from scripted abuse (human-only access law). */
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 120);
const hits = new Map();

/* Lightweight in-process counters so failures are observable, not silent. Read
   via the admin-gated GET /v1/admin/metrics; the health watchdog (scripts/
   nf-monitor.sh) polls it to catch error/webhook spikes that a plain uptime
   check would miss. Resets on restart — a running total, not a time series. */
const metrics = { startedAt: Date.now(), requests: 0, errors5xx: 0, generationFailures: 0, webhookFailures: 0 };
function metricsView() {
  const total = metrics.requests || 1;
  return {
    upSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
    requests: metrics.requests,
    errors5xx: metrics.errors5xx,
    errorRatePct: Math.round((metrics.errors5xx / total) * 1000) / 10,
    generationFailures: metrics.generationFailures,
    webhookFailures: metrics.webhookFailures,
  };
}
function rateLimited(ip) {
  const now = Date.now();
  const slot = hits.get(ip);
  if (!slot || now > slot.reset) { hits.set(ip, { n: 1, reset: now + 60000 }); return false; }
  slot.n += 1;
  if (hits.size > 50000) hits.clear(); // memory backstop
  return slot.n > RATE_LIMIT;
}

/* PLATFORM LAW: every AI action is metered and gated by available ACUs —
   no free AI action, regardless. Enforcement is the DEFAULT; the only way
   to run an un-gated gateway is the explicit ALLOW_FREE_AI=1 escape hatch
   for keyless local demos and CI. */
const billingEnforced = () => process.env.ALLOW_FREE_AI !== '1';

/* Wallet ids act as bearer capabilities until account auth lands: they must
   be high-entropy client-generated ids (nf-config.js format), never guessable
   names. Enforced only when billing is enforced, so local demos stay easy. */
function requireCapabilityId(user) {
  if (!/^op_[a-z0-9]{10,}$/.test(String(user || ''))) {
    throw new GatewayError('Wallet ids must be platform-issued capability ids.', { status: 403, code: 'invalid_user_id' });
  }
}

/* Bind account wallets to their owner's session — OPT-IN via REQUIRE_WALLET_SESSION=1.

   Default OFF (capability-only, the historical behaviour): the high-entropy op_
   id is the bearer credential, exactly as for guests. This is a deliberately
   SAFE default — turning the session requirement on is a backward-incompatible
   tightening (every client must send its bearer token on billed calls, and no
   stale cached page or expired session may be in flight), so it must be a
   conscious operator action AFTER confirming the frontend that sends the token
   is deployed everywhere. Enabling it too early hard-fails real users' billed
   calls with 403 — which reads to them as "temporarily unavailable".

   When ON: guest wallets stay capability-only (pre-signup flow intact), but a
   wallet that belongs to an ACCOUNT (an email is on file) requires that account's
   bearer session, and the session's userId must equal the wallet id — so knowing
   the id is no longer enough to read or drain an account balance. */
const requireWalletSession = () => process.env.REQUIRE_WALLET_SESSION === '1';
function requireOwner(req, userId) {
  requireCapabilityId(userId);
  if (!requireWalletSession()) return;  // opt-in; default = capability-only (no client breakage)
  if (!emailForUserId(userId)) return;  // guest wallet — capability id is the bearer
  const s = sessionFor(bearer(req));
  if (!s || s.userId !== userId) {
    throw new GatewayError('This wallet belongs to an account — sign in to that account to use it.', { status: 403, code: 'not_wallet_owner' });
  }
}

/* Hard ceiling on output tokens a single /v1/generate call may produce. Both the
   provider cap AND the reservation basis, so a request can never cost more than
   we reserved against the balance. Sized to the flagship workload: adaptive
   thinking at high effort PLUS 3 richly-structured niche reports (scores, 3-year
   financials, risks, roadmap, an 11-field brief each) — because thinking tokens
   count toward max_tokens, an under-sized ceiling truncates the JSON and the
   client's parse fails. 16000 matches config.defaults.maxTokens, which was
   documented for exactly this. */
const MAX_GEN_OUTPUT = Number(process.env.MAX_GEN_OUTPUT || 16000);

/* Default reserve when the caller gives no budget. A structured request
   (jsonSchema present) is a large venture report and needs real room for
   thinking + JSON; a plain chat reply is small. Under-reserving a structured
   call is what silently truncated discovery output and made "0 results" the
   norm. */
const STRUCTURED_DEFAULT_OUTPUT = Number(process.env.STRUCTURED_DEFAULT_OUTPUT || 12000);
const PLAIN_DEFAULT_OUTPUT = 2000;

/* How many output tokens this generation is ALLOWED (and therefore RESERVED) to
   produce. The client's own cap is honoured; absent one we reserve a default
   sized to the request shape. The same number caps the provider (below), so
   metered cost ≤ reserved cost — a client can't lowball the estimate and make
   us eat the overrun. */
export function reservedOutputTokens(body) {
  const dflt = body && body.jsonSchema ? STRUCTURED_DEFAULT_OUTPUT : PLAIN_DEFAULT_OUTPUT;
  let out = Number.isInteger(body.maxTokens) && body.maxTokens > 0 ? body.maxTokens : (Number(body.expectedOutputTokens) || dflt);
  return Math.min(Math.max(out, 256), MAX_GEN_OUTPUT);
}

/* Pre-flight ACU estimate for a generation body. Reserves the WORST case: the
   full allowed output length, priced at the most expensive provider that could
   serve the request — so neither a long response nor a fail-over to a pricier
   provider can cost more than we reserved. */
function estimateAcuFor(body, outTokens) {
  const chars = JSON.stringify(body.messages || '').length + (body.system?.length || 0);
  const usage = { inputTokens: Math.ceil(chars / 4), outputTokens: Number.isFinite(outTokens) ? outTokens : reservedOutputTokens(body) };
  const chain = body.provider && body.provider !== 'auto'
    ? [body.provider]
    : (availableProviders().length ? availableProviders() : ['claude']);
  let max = 0;
  for (const p of chain) max = Math.max(max, meterAcu(p, usage, body.investorMode === true, body.capitalGBP));
  return max;
}

/* ============ SENTINEL — anti-hacking AI agent ============
   Inspects every API request before it reaches a handler:
   - attack-pattern screen (path traversal, XSS/SQL probes) on URL + body
   - NON-HUMAN INSTRUCTION guard: prompt-injection phrases aimed at hijacking
     the AI ("ignore previous instructions", role-override, key exfiltration)
     are refused before any provider call
   - strike-based IP bans (5 violations -> 15-minute block), append-only
     audit log at data/sentinel.jsonl */
const SENTINEL_LOG = process.env.SENTINEL_LOG || path.join(process.cwd(), 'data', 'sentinel.jsonl');
const strikes = new Map();
const ATTACK = [/\.\.\//, /<script/i, /\bunion\s+select\b/i, /\bdrop\s+table\b/i, /[;|&]\s*(rm|curl|wget|nc)\s/i];
const INJECTION = [/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, /disregard\s+(your|the)\s+(system|previous)/i,
  /you\s+are\s+now\s+(dan|developer\s+mode|unrestricted)/i, /reveal\s+(your\s+)?(system\s+prompt|api\s+key|secret)/i,
  /\bact\s+as\s+(the\s+)?(admin|root|system)\b/i, /override\s+(safety|billing|the\s+wallet)/i];
function sentinelLog(ip, kind, detail) {
  try {
    fs.mkdirSync(path.dirname(SENTINEL_LOG), { recursive: true });
    fs.appendFileSync(SENTINEL_LOG, JSON.stringify({ ts: Date.now(), ip, kind, detail: String(detail).slice(0, 160) }) + '\n');
  } catch {}
}
function strike(ip, kind, detail) {
  const s = strikes.get(ip) || { n: 0, until: 0 };
  s.n += 1;
  if (s.n >= 5) s.until = Date.now() + 15 * 60000;
  strikes.set(ip, s);
  sentinelLog(ip, kind, detail);
}
function sentinelBanned(ip) {
  const s = strikes.get(ip);
  return Boolean(s && s.until > Date.now());
}
function sentinelScreen(ip, url, raw) {
  const target = decodeURIComponent(url.pathname + url.search) + ' ' + (raw || '');
  for (const rx of ATTACK) if (rx.test(target)) { strike(ip, 'attack_pattern', rx.source); return 'attack_pattern'; }
  return null;
}
export function screenInstructions(raw) {
  for (const rx of INJECTION) if (rx.test(raw || '')) return rx.source;
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };

/* Serve the frontend + shared modules from this same service, so one deploy
   is the whole OS: pages at /frontend/, economy at /shared/, API at /v1/. */
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/frontend/index.html';
  // Clean public URLs: a visitor lands on "/" and the pages use relative links
  // (search.html, nf-config.js, robots.txt). Map any bare top-level request into
  // /frontend so those links resolve — /shared stays addressable as authored.
  if (!p.startsWith('/frontend/') && !p.startsWith('/shared/')) p = '/frontend' + p;
  const abs = path.normalize(path.join(REPO_ROOT, p));
  // Strict boundary: only files genuinely under frontend/ or shared/ are served.
  const FRONT = path.join(REPO_ROOT, 'frontend');
  const SHARED = path.join(REPO_ROOT, 'shared');
  if (!(abs.startsWith(FRONT + path.sep) || abs.startsWith(SHARED + path.sep))) {
    return json(res, 404, { error: 'not_found' });
  }
  // Operator cockpits stay off the public deploy until real admin auth lands.
  // Set EXPOSE_ADMIN=1 only on an internal/private deployment.
  if (process.env.EXPOSE_ADMIN !== '1' && /\/(admin|comms)\.html$/.test(p)) {
    return json(res, 404, { error: 'not_found' });
  }
  let file = abs;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch { /* fall through to 404 */ }
  const ext = path.extname(file);
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { ...SEC_HEADERS, 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    return res.end(body);
  } catch {
    return json(res, 404, { error: 'not_found', message: `No file at ${p}` });
  }
}

/* Security response headers applied to every response. Deliberately safe for a
   site with inline scripts/styles + third-party tags (GTM, Meta Pixel, Google
   Fonts): the CSP restricts only framing, <base>, and plugins — it does NOT
   constrain script/style/connect sources, so nothing breaks — while HSTS,
   nosniff, frame-options, referrer and permissions close the common holes. */
const SEC_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'cross-origin-opener-policy': 'same-origin-allow-popups',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SEC_HEADERS,
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new GatewayError('Request body too large (2 MB limit).', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Bearer token from the Authorization header (accounts / admin session auth).
function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  return m ? m[1].trim() : null;
}

// Password-reset delivery. Sends via the operator's own mail host (SMTP_*) when
// configured; otherwise logs the link so it's recoverable during testing. Fire
// and forget — never blocks the HTTP response, and the link is NEVER returned in
// the response body (that would leak the single-use token).
function deliverReset(email, link) {
  if (!mailConfigured()) {
    console.log(`[auth] password reset for ${email} — (SMTP not configured) reset link: ${link}`);
    return;
  }
  sendMail({
    to: email,
    subject: 'Reset your Niche Finder password',
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0b1220">
      <h2 style="font-weight:600">Reset your password</h2>
      <p>We received a request to reset the password for your Niche Finder account.</p>
      <p><a href="${link}" style="display:inline-block;background:#E8A61A;color:#241a02;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px">Choose a new password</a></p>
      <p style="color:#5a6472;font-size:13px">This link expires in 1 hour. If you didn't request it, you can safely ignore this email — your password won't change.</p>
      <p style="color:#98a1b0;font-size:12px">Or paste this link into your browser:<br>${link}</p>
    </div>`,
    text: `Reset your Niche Finder password:\n${link}\n\nThis link expires in 1 hour. If you didn't request it, ignore this email.`,
  }).then(() => console.log(`[auth] reset email sent to ${email}`))
    .catch((e) => console.error(`[auth] reset email FAILED for ${email}: ${e.message} — reset link: ${link}`));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (url.pathname.startsWith('/v1/')) metrics.requests += 1;

  // HEAD is a bodyless GET: uptime monitors and health-checkers use it. Node's
  // HTTP server strips the body from HEAD responses automatically, so routing
  // HEAD through the GET handlers yields correct headers-only replies.
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (sentinelBanned(ip)) return json(res, 403, { error: 'sentinel_block', message: 'This address is temporarily blocked by the platform security agent.' });
  if (sentinelScreen(ip, url, '')) return json(res, 403, { error: 'sentinel_block', message: 'Request refused by the platform security agent.' });
  if (url.pathname.startsWith('/v1/') && rateLimited(ip)) {
    return json(res, 429, { error: 'rate_limited', message: 'Too many requests — try again in a minute.' });
  }

  // Serve nf-config.js with the live gateway origin injected from PUBLIC_ORIGIN.
  // The committed file stays offline-safe (NF_GATEWAY_URL = ''), so the deployed
  // box needs NO local edit — git pulls never conflict, which makes clean
  // automatic deployment possible. Falls back to the file as-is if unset.
  if (method === 'GET' && (url.pathname === '/nf-config.js' || url.pathname === '/frontend/nf-config.js')) {
    try {
      let src = fs.readFileSync(path.join(REPO_ROOT, 'frontend', 'nf-config.js'), 'utf8');
      const origin = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
      if (origin) src = src.replace(/window\.NF_GATEWAY_URL\s*=\s*['"][^'"]*['"];/, `window.NF_GATEWAY_URL = '${origin}';`);
      res.writeHead(200, { ...SEC_HEADERS, 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
      return res.end(src);
    } catch { /* fall through to normal static handling / 404 */ }
  }

  if (method === 'GET' && !url.pathname.startsWith('/v1/')) return serveStatic(req, res, url);

  if (method === 'GET' && url.pathname === '/v1/health') {
    return json(res, 200, {
      status: maintenanceOn ? 'maintenance' : 'ok',
      mock: config.mock,
      providers: availableProviders(),
      payments: paymentsConfigured(),
      koda: kodaConfigured(),
      fallbackChain: config.fallbackChain,
      maintenance: maintenanceOn,
    });
  }

  // ---- payments: the real-money door (Stripe Checkout + settlement webhook) ----
  if (req.method === 'POST' && url.pathname === '/v1/payments/checkout') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const origin = process.env.PUBLIC_ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      return json(res, 200, await createCheckout({ user: body.user, packageId: body.packageId, origin }));
    } catch (err) { return handleError(res, err); }
  }

  // Recurring subscription checkout — hosted Stripe session for a monthly PLAN.
  if (req.method === 'POST' && url.pathname === '/v1/payments/subscribe') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const origin = process.env.PUBLIC_ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      return json(res, 200, await createSubscriptionCheckout({ user: body.user, planId: body.planId, origin }));
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/payments/stripe-webhook') {
    try {
      const raw = await readBody(req);
      return json(res, 200, await handleWebhook(raw, req.headers['stripe-signature']));
    } catch (err) { metrics.webhookFailures += 1; return handleError(res, err); }
  }

  // ---- payments: KODA mobile-money door (hosted intent + settlement webhook) ----
  if (req.method === 'POST' && url.pathname === '/v1/payments/koda-intent') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const origin = process.env.PUBLIC_ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      return json(res, 200, await createKodaIntent({ user: body.user, packageId: body.packageId, origin }));
    } catch (err) {
      console.error(`[koda-intent] failed: code=${err?.code || '?'} status=${err?.status ?? '?'} :: ${err?.message || err}`);
      return handleError(res, err);
    }
  }

  if (req.method === 'POST' && url.pathname === '/v1/payments/koda-webhook') {
    try {
      const raw = await readBody(req);
      return json(res, 200, handleKodaWebhook(raw, req.headers['x-koda-signature']));
    } catch (err) { metrics.webhookFailures += 1; return handleError(res, err); }
  }

  // ---- newsletter: one-click unsubscribe (public; signed token, no login) ----
  // Handles both GET (the link) and POST (RFC 8058 List-Unsubscribe-Post).
  if ((method === 'GET' || req.method === 'POST') && url.pathname === '/v1/newsletter/unsubscribe') {
    const u = url.searchParams.get('u');
    const t = url.searchParams.get('t');
    let ok = true;
    try { handleUnsubscribe(u, t); } catch { ok = false; }
    const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Niche Finder — ${ok ? 'Unsubscribed' : 'Link invalid'}</title>
      <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:12vh auto;padding:0 22px;color:#0b1220;text-align:center">
        <h1 style="font-size:22px">${ok ? 'You’re unsubscribed' : 'This link is invalid'}</h1>
        <p style="color:#5a6472">${ok
          ? 'You will no longer receive the weekly Niche Finder product email. Changed your mind? Just reply to any earlier email or contact us and we’ll turn it back on.'
          : 'We couldn’t process this unsubscribe request. Please use the link from a recent email, or update your preferences in your account.'}</p>
        <p><a href="/settings.html" style="color:#8A6300;font-weight:700;text-decoration:none">Go to your account &rsaquo;</a></p>
      </div>`;
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
    return res.end(page);
  }

  // ---- referrals: Growth Partner programme summary for one account ----
  if (method === 'GET' && url.pathname === '/v1/referrals/summary') {
    try {
      const user = url.searchParams.get('user');
      requireCapabilityId(user);
      return json(res, 200, referralSummary(user));
    } catch (err) { return handleError(res, err); }
  }

  // ---- documents: durable retrieval (survives cache clears / new devices) ----
  if (method === 'GET' && url.pathname === '/v1/documents') {
    try {
      const user = url.searchParams.get('user');
      requireOwner(req, user);
      return json(res, 200, { documents: listDocs({ user, project: url.searchParams.get('project') }) });
    } catch (err) { return handleError(res, err); }
  }
  if (method === 'GET' && url.pathname === '/v1/document') {
    try {
      const user = url.searchParams.get('user');
      requireOwner(req, user);
      const doc = getDoc({ user, project: url.searchParams.get('project'), type: url.searchParams.get('type') });
      if (!doc) return json(res, 404, { error: 'not_found' });
      return json(res, 200, doc);
    } catch (err) { return handleError(res, err); }
  }

  // ---- documents: fixed-price, deep AI generation of an investor-grade asset ----
  // Unlike /v1/generate (metered by tokens), a document is charged the canonical
  // catalogue price (shared/nf-economy.js), adjusted for capital bracket and
  // Investor Mode. Price is resolved server-side so the client can never set it.
  if (req.method === 'POST' && url.pathname === '/v1/document') {
    let hold = null; // outstanding ACU reservation — released on any failure path (catch-visible)
    try {
      if (maintenanceOn) {
        return json(res, 503, { error: 'maintenance', message: 'Niche Finder is briefly paused for maintenance. Please try again shortly.' });
      }
      let clientGone = false;
      res.on('close', () => { if (!res.writableEnded) clientGone = true; });
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { throw new GatewayError('Body must be valid JSON.', { status: 400, code: 'invalid_json' }); }
      const inj = screenInstructions(raw);
      if (inj) { strike(ip, 'prompt_injection', inj); throw new GatewayError('Instruction blocked by the platform security agent.', { status: 400, code: 'non_human_instruction' }); }

      const ECO = globalThis.NF_ECONOMY;
      const PRICE_KEY = { validation: 'validation', forecast: 'forecast', pnl: 'pnl', riskmap: 'riskmap', bizplan: 'bizplan', pitch: 'pitch', export: 'excel_model', gtm: 'gtm' };
      const key = PRICE_KEY[body.docType];
      if (!key || !ECO.COSTS[key]) throw new GatewayError(`Unknown document type "${body.docType}".`, { status: 400, code: 'unknown_document' });
      const price = Math.round(ECO.COSTS[key] * ECO.bracketFor(body.capitalGBP).factor * (body.investorMode === true ? ECO.COSTS.investor_multiplier : 1));

      let debit = null;
      if (billingEnforced()) {
        requireOwner(req, body.user);
        if (isFrozen(body.user)) {
          throw new GatewayError('This wallet is temporarily frozen pending a payment dispute. Contact support.', { status: 402, code: 'wallet_frozen', platformCode: 4002 });
        }
        debit = { user: body.user, price };
      }
      // Fixed price → bound provider spend, AND keep generation inside a live
      // request window: a too-large budget runs past the provider timeout, fails
      // over, and the page spins for minutes. 14k fits a deep, detailed document;
      // the GTM Blueprint is far larger (17 sections incl. marketing engine +
      // 30/60/90 roadmap), so it gets a higher ceiling.
      const tokenCap = body.docType === 'gtm' ? 24000 : 18000;
      const genBody = { ...body, maxTokens: Math.min(Number(body.maxTokens) || 14000, tokenCap) };
      const started = Date.now();

      // The Export Pack is assembled deterministically on the client (xlsx
      // financial model + the already-generated documents) — it uses NO AI. Bill
      // the catalogue price but skip the provider call and the discarded-document
      // persist. Previously this ran a full deep generation whose "overview"
      // output the export page never rendered: pure wasted spend every click.
      if (body.docType === 'export') {
        // No AI, no await → a direct charge is already atomic (no TOCTOU). It
        // still checks spendable, so it respects any other in-flight hold.
        if (clientGone) { console.log('[document] export: client disconnected — no charge'); return; }
        if (debit) {
          const charged = charge({
            user: debit.user, amount: debit.price, label: 'document · export', action: 'generation',
            bracketFactor: 1, idempotencyKey: `doc_export_${started}_${crypto.randomUUID()}`,
          });
          console.log(`[document] export packaged (no AI) price=${price} user=${debit.user.slice(-8)}`);
          return json(res, 200, { docType: 'export', charged: charged.charged, wallet: charged.wallet });
        }
        return json(res, 200, { docType: 'export', charged: 0 });
      }

      // RESERVE the fixed price before the provider call (atomic hold → no TOCTOU
      // across the await). Released on malformed output, client-gone, or error;
      // settled at the fixed price on a delivered document.
      if (debit) {
        const holdKey = `doc_${body.docType}_${started}_${crypto.randomUUID()}`;
        reserve({ user: debit.user, amount: debit.price, key: holdKey });
        hold = { user: debit.user, price: debit.price, key: holdKey };
      }
      console.log(`[document] start type=${body.docType} price=${price} effort=${body.effort || 'high'} billed=${!!hold}`);
      const result = await route(genBody);
      let content;
      try { content = JSON.parse(result.text); } catch {
        if (hold) releaseHold({ user: hold.user, key: hold.key }); // malformed → not charged
        throw new GatewayError('The document engine returned malformed content — you were not charged. Please try again.', { status: 502, code: 'bad_document' });
      }
      console.log(`[document] ok type=${body.docType} provider=${result.provider} latencyMs=${Date.now() - started} sections=${(content.sections || []).length}`);
      if (clientGone) {
        if (hold) releaseHold({ user: hold.user, key: hold.key });
        console.log('[document] client disconnected before result — hold released, no bill');
        return;
      }
      // Persist the generated document server-side so it survives cache clears /
      // private windows and follows the account across devices.
      if (body.user && body.project) {
        try { saveDoc({ user: body.user, project: body.project, type: body.docType, content, version: body.version || 1, title: content.title || '' }); }
        catch (e) { console.error('[document] persist failed:', e.message); }
      }
      if (hold) {
        const s = settleHold({
          user: hold.user, key: hold.key, actual: hold.price,
          label: `document · ${body.docType}`, action: 'generation', bracketFactor: result.bracketFactor || 1,
        });
        return json(res, 200, { docType: body.docType, content, charged: s.charged, wallet: s.wallet, provider: result.provider, latencyMs: Date.now() - started });
      }
      return json(res, 200, { docType: body.docType, content, provider: result.provider, latencyMs: Date.now() - started });
    } catch (err) {
      if (hold) { try { releaseHold({ user: hold.user, key: hold.key }); } catch {} } // never strand a reservation
      console.error(`[document] failed: code=${err?.code || '?'} status=${err?.status ?? '?'} :: ${err?.message || err}`);
      return handleError(res, err);
    }
  }

  // ---- public: server-published blog articles (SEO). Visible to every visitor. ----
  if (method === 'GET' && url.pathname === '/v1/articles') {
    try {
      const slug = url.searchParams.get('slug');
      if (slug) { const a = getArticle(slug); return a ? json(res, 200, a) : json(res, 404, { error: 'not_found' }); }
      return json(res, 200, { articles: listArticles(url.searchParams.get('limit')) });
    } catch (err) { return handleError(res, err); }
  }

  // Record one blog view (any article slug, static or published). Public; the
  // client throttles per session so a reload doesn't inflate the count.
  if (req.method === 'POST' && url.pathname === '/v1/articles/view') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.slug) return json(res, 400, { error: 'slug_required' });
      return json(res, 200, recordView(body.slug));
    } catch (err) { return handleError(res, err); }
  }

  // ---- leads: waitlist / contact capture (human-paced only; honeypot server-side too) ----
  if (req.method === 'POST' && url.pathname === '/v1/leads') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.website) return json(res, 200, { received: true }); // honeypot filled → swallow silently
      const email = String(body.email || '').slice(0, 200);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new GatewayError('A valid email is required.', { status: 400, code: 'invalid_email' });
      }
      const name = String(body.name || '').slice(0, 120);
      const message = String(body.message || '').slice(0, 2000);
      fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
      fs.appendFileSync(LEADS_PATH, JSON.stringify({ email, name, message, ip, ts: Date.now() }) + '\n');
      // Notify the operator inbox (CONTACT_INBOX, defaults to the SMTP mailbox) so
      // contact/waitlist submissions land in email, not just the leads log.
      if (mailConfigured()) {
        const inbox = process.env.CONTACT_INBOX || process.env.SMTP_USER;
        sendMail({
          to: inbox,
          subject: `New Niche Finder enquiry from ${name || email}`,
          text: `From: ${name || '(no name)'} <${email}>\n\n${message || '(no message)'}\n\n— sent ${new Date().toUTCString()}`,
        }).catch((e) => console.error(`[leads] notify email failed: ${e.message}`));
      }
      // Server-side Lead conversion (deduped with the browser via body.eventId;
      // fbp/fbc forwarded from the client for match quality).
      capiSend({
        eventName: 'Lead', eventId: body.eventId,
        eventSourceUrl: (process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '') + '/',
        email, clientIp: ip, userAgent: req.headers['user-agent'], fbp: body.fbp, fbc: body.fbc,
      });
      return json(res, 200, { received: true });
    } catch (err) { return handleError(res, err); }
  }

  // ---- in-house human verification (no third-party vendor) ----
  if (method === 'GET' && url.pathname === '/v1/human/challenge') {
    return json(res, 200, issueChallenge(ip));
  }
  if (req.method === 'POST' && url.pathname === '/v1/human/verify') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = verifyChallenge(ip, body.challenge, body.nonce);
      if (!result.human) strike(ip, 'human_challenge_failed', result.reason);
      return json(res, result.human ? 200 : 403, result);
    } catch (err) { return handleError(res, err); }
  }

  // ---- accounts: in-house signup / login / session (no third-party vendor) ----
  // Bot-sensitive endpoints (signup, forgot) require a solved proof-of-work
  // challenge — the same in-house anti-bot layer used elsewhere.
  const requireHuman = (body) => {
    const proof = verifyChallenge(ip, body.challenge, body.nonce);
    if (!proof.human) {
      strike(ip, 'human_challenge_failed', proof.reason);
      throw new GatewayError('Human verification failed — please try again.', { status: 403, code: 'human_required' });
    }
  };

  if (req.method === 'POST' && url.pathname === '/v1/auth/signup') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      requireHuman(body);
      return json(res, 200, signup({ email: body.email, password: body.password, ref: body.ref }));
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, login({ email: body.email, password: body.password }));
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
    try { return json(res, 200, logout(bearer(req))); } catch (err) { return handleError(res, err); }
  }

  if (method === 'GET' && url.pathname === '/v1/auth/me') {
    const s = sessionFor(bearer(req));
    if (!s) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { user: userByEmail(s.email) || { email: s.email, userId: s.userId, role: s.role } });
  }

  // Serve a stored profile picture / cover. Filename is basename-sanitised and
  // must resolve inside the avatars dir (no traversal).
  if (method === 'GET' && url.pathname === '/v1/media') {
    const f = path.basename(url.searchParams.get('f') || '');
    const abs = path.join(AVATAR_DIR, f);
    if (!f || !abs.startsWith(AVATAR_DIR + path.sep)) return json(res, 404, { error: 'not_found' });
    try {
      const buf = fs.readFileSync(abs);
      res.writeHead(200, { 'content-type': EXT_MIME[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=60' });
      return res.end(buf);
    } catch { return json(res, 404, { error: 'not_found' }); }
  }

  // ---- account self-service: profile, avatar/cover, password, delete ----
  if (req.method === 'POST' && url.pathname === '/v1/auth/profile') {
    try {
      const s = sessionFor(bearer(req));
      if (!s) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, { user: updateProfile(s.email, body) });
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/avatar') {
    try {
      const s = sessionFor(bearer(req));
      if (!s) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const kind = body.kind === 'cover' ? 'cover' : 'avatar';
      const m = /^data:(image\/\w+);base64,(.+)$/s.exec(body.dataUrl || '');
      if (!m || !IMG_MIME_EXT[m[1]]) throw new GatewayError('Upload a PNG, JPEG, WebP or GIF image.', { status: 400, code: 'bad_image' });
      const buf = Buffer.from(m[2], 'base64');
      const cap = kind === 'cover' ? 1_000_000 : 500_000;
      if (buf.length > cap) throw new GatewayError(`Image too large (max ${cap / 1000}KB).`, { status: 400, code: 'image_too_large' });
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const file = `${s.userId}_${kind}.${IMG_MIME_EXT[m[1]]}`;
      fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
      const user = setMedia(s.email, kind, file);
      return json(res, 200, { url: `/v1/media?f=${encodeURIComponent(file)}`, user });
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/password') {
    try {
      const s = sessionFor(bearer(req));
      if (!s) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, changePassword(s.email, body.currentPassword, body.newPassword));
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/delete') {
    try {
      const s = sessionFor(bearer(req));
      if (!s) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = deleteAccount(s.email, body.currentPassword);
      // Right-to-erasure cascade: remove the user's data from EVERY store, not
      // just auth — wallet + ledger, generated documents, and referral records.
      // (Newsletter recipients are derived from the auth store, so deleting the
      // account removes them there too.)
      try { deleteWallet(r.userId); } catch (e) { console.error('[delete] wallet:', e.message); }
      try { deleteUserDocs(r.userId); } catch (e) { console.error('[delete] docs:', e.message); }
      try { deleteReferralData(r.userId); } catch (e) { console.error('[delete] referrals:', e.message); }
      return json(res, 200, { ok: true });
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/forgot') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      requireHuman(body);
      const r = requestReset({ email: body.email });
      if (r.sent) {
        const origin = process.env.PUBLIC_ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
        deliverReset(r.email, `${origin}/reset.html?email=${encodeURIComponent(r.email)}&token=${r.token}`);
      }
      return json(res, 200, { ok: true }); // never reveal whether the email exists
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/reset') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, resetPassword({ email: body.email, token: body.token, password: body.password }));
    } catch (err) { return handleError(res, err); }
  }

  // ---- admin: role-gated via session; NEVER exposes the raw admin key ----
  if (method === 'GET' && url.pathname === '/v1/admin/users') {
    const s = sessionFor(bearer(req));
    if (!s || s.role !== 'admin') return json(res, 403, { error: 'admin_required' });
    return json(res, 200, { users: listUsers() });
  }

  // Admin session guard: returns the session if it's an admin, else null.
  const adminOf = () => { const s = sessionFor(bearer(req)); return s && s.role === 'admin' ? s : null; };
  const readJsonl = (file, cap = 200) => {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw) return [];
      return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, cap);
    } catch { return []; }
  };

  // Admin: send the newsletter now, or preview one to a single address.
  //   body { to?: "someone@example.com" }  — with `to`, sends a single preview
  //   (any account) without advancing the weekly clock. Auth: admin session OR
  //   the x-admin-key header (so a script/cron can trigger it too).
  if (req.method === 'POST' && url.pathname === '/v1/admin/newsletter/send') {
    try {
      const keyOk = req.headers['x-admin-key'] && req.headers['x-admin-key'] === process.env.ADMIN_API_KEY;
      if (!adminOf() && !keyOk) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = await sendNewsletterOnce({ force: true, to: body.to || null });
      return json(res, 200, result);
    } catch (err) { return handleError(res, err); }
  }

  // Admin: send a notification-template preview to the signed-in admin's own
  // email — the real "send test" behind the Comms console. Body { subject, html }
  // is the preview the client already renders; the server dispatches it via the
  // real mailer to the admin's address only (never an arbitrary recipient).
  if (req.method === 'POST' && url.pathname === '/v1/admin/test-email') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      if (!mailConfigured()) return json(res, 503, { error: 'mail_not_configured', message: 'SMTP is not configured on this deployment.' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const subject = String(body.subject || 'Niche Finder — test notification').slice(0, 200);
      const html = String(body.html || '').slice(0, 100000);
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'Test notification from Niche Finder.';
      await sendMail({ to: s.email, subject: `[TEST] ${subject}`, text, html });
      return json(res, 200, { sent: true, to: s.email });
    } catch (err) { return handleError(res, err); }
  }

  // Admin: Growth Partner overview — real referral/commission data. Commission
  // is auto-paid as ACU at qualification (no manual payout step), so this is a
  // read-only reporting surface.
  if (method === 'GET' && url.pathname === '/v1/admin/referrals') {
    const s = adminOf();
    if (!s) return json(res, 403, { error: 'admin_required' });
    const data = listPartners();
    data.rows = data.rows.map((r) => ({ ...r, email: emailForUserId(r.userId) || null }));
    return json(res, 200, data);
  }

  // Admin: SEO console stats — real published count, total views, avg SEO score.
  if (method === 'GET' && url.pathname === '/v1/admin/articles/stats') {
    const s = adminOf();
    if (!s) return json(res, 403, { error: 'admin_required' });
    return json(res, 200, articleStats());
  }

  // Admin: real Google Search Console performance (impressions/clicks/position),
  // per article + totals. Returns { configured:false } until GSC env is set.
  if (method === 'GET' && url.pathname === '/v1/admin/search-console') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      const data = await getSearchConsole({ force: url.searchParams.get('force') === '1' });
      return json(res, 200, data);
    } catch (err) { return handleError(res, err); }
  }

  // Admin: publish / unpublish a blog article to the public server store.
  if (req.method === 'POST' && url.pathname === '/v1/admin/articles') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, publishArticle({ title: body.title, category: body.category, format: body.format, slug: body.slug, auto: body.auto }));
    } catch (err) { return handleError(res, err); }
  }
  if (req.method === 'POST' && url.pathname === '/v1/admin/articles/unpublish') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, unpublishArticle(body.slug));
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/grant') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const userId = resolveUserId(body.userId || body.email);
      const result = grant({ user: userId, amount: body.amount, reason: body.reason || `Admin grant by ${s.email}`, idempotencyKey: body.idempotencyKey });
      return json(res, 200, { ...result, userId });
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/deduct') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const userId = resolveUserId(body.userId || body.email);
      const result = charge({ user: userId, amount: body.amount, label: body.reason || `Admin deduction by ${s.email}`, action: 'admin_deduct' });
      return json(res, 200, { ...result, userId });
    } catch (err) { return handleError(res, err); }
  }

  if (method === 'GET' && url.pathname === '/v1/admin/ledger') {
    try {
      if (!adminOf()) return json(res, 403, { error: 'admin_required' });
      const userId = resolveUserId(url.searchParams.get('user'));
      return json(res, 200, { userId, email: emailForUserId(userId), ledger: getLedger(userId, url.searchParams.get('limit') || 100) });
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/role') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, setRole(body.email, body.role));
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/disable') {
    try {
      const s = adminOf();
      if (!s) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const sameEmail = String(body.email || '').trim().toLowerCase() === String(s.email).toLowerCase();
      if (sameEmail && body.disabled !== false) {
        throw new GatewayError('You cannot disable your own admin account.', { status: 400, code: 'self_disable' });
      }
      return json(res, 200, setDisabled(body.email, body.disabled !== false));
    } catch (err) { return handleError(res, err); }
  }

  // Machine-readable health/error metrics for the uptime watchdog (scripts/
   // nf-monitor.sh). Admin-gated by session OR the admin key (so an unattended
   // monitor can poll with x-admin-key without a login). Never public — it
   // reveals failure counts and revenue.
  if (method === 'GET' && url.pathname === '/v1/admin/metrics') {
    const keyOk = req.headers['x-admin-key'] === process.env.ADMIN_API_KEY && Boolean(process.env.ADMIN_API_KEY);
    if (!adminOf() && !keyOk) return json(res, 403, { error: 'admin_required' });
    const sum = summary();
    return json(res, 200, {
      ...metricsView(),
      payments: paymentsConfigured(),
      koda: kodaConfigured(),
      providers: availableProviders(),
      maintenance: maintenanceOn,
      walletCount: sum.walletCount,
      revenueGBP: sum.revenueGBP,
    });
  }

  // Launch-readiness self-diagnosis. One curl tells you exactly what is or
  // isn't wired for real money + generation, WITHOUT reading server logs and
  // WITHOUT leaking any secret value (only presence + counts). Admin-gated by
  // session OR x-admin-key so it can be scripted. This is the answer to "why is
  // it failing in production" when you don't have shell access to the box.
  if (method === 'GET' && url.pathname === '/v1/admin/diag') {
    // Header OR ?key= query param (diag reports only presence/counts, never a
    // secret value, so a plain browser URL on a phone is an acceptable way in).
    const givenKey = req.headers['x-admin-key'] || url.searchParams.get('key');
    const keyOk = Boolean(process.env.ADMIN_API_KEY) && givenKey === process.env.ADMIN_API_KEY;
    if (!adminOf() && !keyOk) return json(res, 403, { error: 'admin_required', message: 'Open /v1/admin/diag?key=YOUR_ADMIN_API_KEY' });
    const present = (v) => Boolean(v && String(v).trim());
    const providers = {
      claude: present(process.env.ANTHROPIC_API_KEY),
      gemini: present(process.env.GEMINI_API_KEY),
      openai: present(process.env.OPENAI_API_KEY),
    };
    const whsecs = (process.env.STRIPE_WEBHOOK_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
    const problems = [];
    if (!config.mock && !Object.values(providers).some(Boolean)) problems.push('NO AI PROVIDER KEY set — every /v1/generate will fail. Set ANTHROPIC_API_KEY (or GEMINI/OPENAI), or MOCK_AI=1 for a demo.');
    if (!present(process.env.STRIPE_SECRET_KEY)) problems.push('STRIPE_SECRET_KEY missing — Checkout cannot be created.');
    if (!whsecs.length) problems.push('STRIPE_WEBHOOK_SECRET missing — every Stripe webhook will be rejected (no crediting).');
    if (!kodaConfigured()) problems.push('KODA not fully configured — mobile-money door is off (this is fine if you only take card).');
    if (!mailConfigured()) problems.push('SMTP not configured — receipts, password resets and lead notifications will not send.');
    return json(res, 200, {
      status: problems.length ? 'attention' : 'ready',
      time: { serverIso: new Date().toISOString(), serverUnix: Math.floor(Date.now() / 1000), note: 'compare serverUnix to real UTC now; a skew > 300s breaks Stripe webhook signatures' },
      generation: { mock: config.mock, providerKeys: providers, fallbackChain: config.fallbackChain, active: config.mock ? ['mock'] : availableProviders(), model: config.providers.claude.model, maxOutputTokens: MAX_GEN_OUTPUT, structuredDefaultTokens: STRUCTURED_DEFAULT_OUTPUT },
      payments: { configured: paymentsConfigured(), stripeSecretKey: present(process.env.STRIPE_SECRET_KEY), webhookSecrets: whsecs.length, webhookToleranceSec: Math.max(30, Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300)), webhookPath: '/v1/payments/stripe-webhook' },
      koda: { configured: kodaConfigured(), webhookPath: '/v1/payments/koda-webhook' },
      mail: { configured: mailConfigured() },
      maintenance: maintenanceOn,
      problems,
    });
  }

  if (method === 'GET' && url.pathname === '/v1/admin/overview') {
    if (!adminOf()) return json(res, 403, { error: 'admin_required' });
    const sum = summary();
    const users = listUsers();
    return json(res, 200, {
      users: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      disabled: users.filter((u) => u.disabled).length,
      revenueGBP: sum.revenueGBP,
      acusSold: sum.acusSold,
      grantsTotal: sum.grantsTotal,
      purchases: sum.purchases.length,
      paidOutstanding: sum.paidTotal,
      leads: readJsonl(LEADS_PATH, 100000).length,
      payments: paymentsConfigured(),
      mailConfigured: mailConfigured(),
      searchConsole: gscConfigured(),
      providers: availableProviders(),
      fallbackChain: config.fallbackChain,
      mock: config.mock,
      maintenance: maintenanceOn,
    });
  }

  if (method === 'GET' && url.pathname === '/v1/admin/revenue') {
    if (!adminOf()) return json(res, 403, { error: 'admin_required' });
    const sum = summary();
    const byPackage = {};
    for (const p of sum.purchases) {
      const name = (/·\s*([^(]+?)\s*\(/.exec(p.label) || [])[1] || 'Purchase';
      byPackage[name] = byPackage[name] || { name, count: 0, gbp: 0, acus: 0 };
      byPackage[name].count += 1; byPackage[name].gbp += p.gbp; byPackage[name].acus += p.acus;
    }
    return json(res, 200, {
      revenueGBP: sum.revenueGBP,
      acusSold: sum.acusSold,
      grantsTotal: sum.grantsTotal,
      count: sum.purchases.length,
      byPackage: Object.values(byPackage).sort((a, b) => b.gbp - a.gbp),
      purchases: sum.purchases.map((p) => ({ ...p, email: emailForUserId(p.userId) || p.userId })),
    });
  }

  if (method === 'GET' && url.pathname === '/v1/admin/leads') {
    if (!adminOf()) return json(res, 403, { error: 'admin_required' });
    return json(res, 200, { leads: readJsonl(LEADS_PATH) });
  }

  if (method === 'GET' && url.pathname === '/v1/admin/security') {
    if (!adminOf()) return json(res, 403, { error: 'admin_required' });
    const now = Date.now();
    const bans = [];
    for (const [banIp, st] of strikes) if (st.until > now) bans.push({ ip: banIp, until: st.until, strikes: st.n });
    return json(res, 200, {
      log: readJsonl(SENTINEL_LOG),
      bans,
      providers: availableProviders(),
      fallbackChain: config.fallbackChain,
      payments: paymentsConfigured(),
      mock: config.mock,
      maintenance: maintenanceOn,
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/admin/maintenance') {
    try {
      if (!adminOf()) return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      setMaintenance(!!body.on);
      return json(res, 200, { maintenance: maintenanceOn });
    } catch (err) { return handleError(res, err); }
  }

  if (method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, {
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([name, p]) => [name, { model: p.model, configured: Boolean(process.env[p.apiKeyEnv]) }]),
      ),
    });
  }

  // Pre-flight cost estimate for the "every paid action displays its ACU cost
  // before you commit" product rule. Rough character-based token estimate.
  if (req.method === 'POST' && url.pathname === '/v1/estimate') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const chars = JSON.stringify(body.messages || '') .length + (body.system?.length || 0);
      const usage = { inputTokens: Math.ceil(chars / 4), outputTokens: body.expectedOutputTokens || 2000 };
      const provider = body.provider && body.provider !== 'auto' ? body.provider : availableProviders()[0] || 'claude';
      return json(res, 200, { provider, estimatedAcu: meterAcu(provider, usage, body.investorMode === true, body.capitalGBP), usage });
    } catch (err) {
      return handleError(res, err);
    }
  }

  // ---- P0 wallet: server-side ACU system of record ----
  // Reads require a platform-issued capability id (same contract as the billed
  // paths). Without it, an arbitrary/guessable string (e.g. user=admin) would
  // both read a wallet AND mint its welcome grant as a side effect of getWallet.
  if (method === 'GET' && url.pathname === '/v1/wallet') {
    try {
      requireOwner(req, url.searchParams.get('user'));
      return json(res, 200, getWallet(url.searchParams.get('user')));
    } catch (err) { return handleError(res, err); }
  }

  // /transactions is the spec-facing alias (§10.2 GET /wallet/transactions);
  // /ledger remains for existing clients. Same enriched entries either way.
  if (method === 'GET' && (url.pathname === '/v1/wallet/ledger' || url.pathname === '/v1/wallet/transactions')) {
    try {
      requireOwner(req, url.searchParams.get('user'));
      return json(res, 200, { ledger: getLedger(url.searchParams.get('user'), url.searchParams.get('limit')) });
    } catch (err) { return handleError(res, err); }
  }

  // Guest→account wallet migration on first login/signup. Requires the ACCOUNT's
  // bearer session (moves ONLY into the authenticated account), and `from` must
  // be a capability-grade guest id that is NOT already an account wallet — so it
  // can never be used to pull ACU out of another user's account. Idempotent.
  if (req.method === 'POST' && url.pathname === '/v1/wallet/migrate') {
    try {
      const s = sessionFor(bearer(req));
      if (!s) return json(res, 401, { error: 'auth_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const from = String(body.from || '');
      if (!/^op_[a-z0-9]{10,}$/.test(from)) return json(res, 400, { error: 'invalid_from' });
      if (emailForUserId(from)) return json(res, 400, { error: 'not_a_guest_wallet' });
      return json(res, 200, migratePaid({ from, to: s.userId }));
    } catch (err) { return handleError(res, err); }
  }

  if (method === 'GET' && url.pathname === '/v1/wallet/packages') {
    return json(res, 200, { packages: PACKAGES });
  }

  if (req.method === 'POST' && (url.pathname === '/v1/wallet/charge' || url.pathname === '/v1/wallet/credit')) {
    try {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        throw new GatewayError('Body must be valid JSON.', { status: 400, code: 'invalid_json' });
      }
      // An admin grant is a /credit call carrying an explicit ACU "amount"
      // (no packageId): it MINTS usable ACUs, so it ALWAYS requires the admin
      // key — regardless of billing mode — and can never be client-initiated.
      const isCredit = url.pathname.endsWith('credit');
      const isGrant = isCredit && body.amount != null && body.packageId == null;
      const adminOk = req.headers['x-admin-key'] === process.env.ADMIN_API_KEY;
      if (isGrant && !adminOk) {
        throw new GatewayError('Admin grants require a valid admin key.', { status: 403, code: 'admin_required' });
      }
      // Production wallet law: when real money is on (or REQUIRE_WALLET=1),
      // client-initiated package credits are DISABLED — ACUs enter only via the
      // Stripe settlement webhook or an admin key. Charges/grants require a
      // capability-grade user id (high-entropy, never displayed), so balances
      // can't be guessed at.
      if (billingEnforced()) {
        if (isCredit && !isGrant && !adminOk) {
          throw new GatewayError('Direct crediting is disabled in production — ACUs are credited by payment settlement only.', {
            status: 403, code: 'credit_disabled',
          });
        }
        // A direct charge spends a wallet — enforce ownership (account wallets
        // require the matching session). Admin grants are exempt (admin-keyed).
        if (isGrant && adminOk) requireCapabilityId(body.user);
        else requireOwner(req, body.user);
      }
      // Namespace any client-supplied idempotency key so it can NEVER collide
      // with an internal settlement/generation key (stripe_/koda_/stripe_inv_/
      // ref_/gen_/doc_). Without this, a client could pre-occupy a settlement
      // key and make a real payment's webhook replay-skip its credit — the
      // customer pays, no ACU lands. Admin grants keep their own explicit key.
      const rawKey = body.idempotencyKey || req.headers['idempotency-key'];
      if (rawKey && !(isGrant && adminOk)) {
        body.idempotencyKey = `client_${String(rawKey).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100)}`;
      } else {
        body.idempotencyKey = rawKey;
      }
      const result = url.pathname.endsWith('charge') ? charge(body)
        : isGrant ? grant(body) : credit(body);
      return json(res, 200, result);
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/generate') {
    let hold = null; // outstanding ACU reservation — released on any failure path (catch-visible)
    try {
      // If the browser gives up (its request timeout) before the model returns,
      // don't bill the wallet for a result the user never received.
      let clientGone = false;
      res.on('close', () => { if (!res.writableEnded) clientGone = true; });
      if (maintenanceOn) {
        return json(res, 503, { error: 'maintenance', message: 'Niche Finder is briefly paused for maintenance. Please try again shortly.' });
      }
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        throw new GatewayError('Body must be valid JSON.', { status: 400, code: 'invalid_json' });
      }
      // SENTINEL: block non-human instructions — prompt-injection attempts
      // aimed at hijacking the AI never reach a provider.
      const inj = screenInstructions(raw);
      if (inj) {
        strike(ip, 'prompt_injection', inj);
        throw new GatewayError('Instruction blocked by the platform security agent.', { status: 400, code: 'non_human_instruction' });
      }

      // QUICK PREVIEW — a cheap teaser (one short niche) that WELCOME (free) ACU
      // may fund, unlike the full paid search. Fixed low price (quick_preview ×
      // capital bracket) and a hard-capped output budget so it's cheap to serve;
      // the small size + fixed price bound any free-account farming. allowFree
      // lets welcome ACU pay (free drawn first). This never touches the paid-only
      // metered path below.
      if (body.preview === true) {
        const previewStarted = Date.now();
        const ECO = globalThis.NF_ECONOMY;
        const price = Math.max(config.acu.minimumCharge, Math.round(ECO.COSTS.quick_preview * ECO.bracketFor(body.capitalGBP).factor));
        const previewBody = { ...body, effort: 'low', maxTokens: Math.min(Number(process.env.QUICK_PREVIEW_TOKENS || 1400), MAX_GEN_OUTPUT) };
        if (billingEnforced()) {
          requireOwner(req, body.user);
          if (isFrozen(body.user)) throw new GatewayError('This wallet is temporarily frozen pending a payment dispute. Contact support.', { status: 402, code: 'wallet_frozen', platformCode: 4002 });
          const holdKey = `preview_${previewStarted}_${crypto.randomUUID()}`;
          reserve({ user: body.user, amount: price, key: holdKey, allowFree: true });
          hold = { user: body.user, key: holdKey }; // the catch releases it on failure
        }
        console.log(`[preview] start price=${price} maxOut=${previewBody.maxTokens} billed=${!!hold}`);
        const presult = await route(previewBody);
        if (clientGone) { if (hold) releaseHold({ user: hold.user, key: hold.key }); return; }
        if (hold) {
          const s = settleHold({ user: hold.user, key: hold.key, actual: price, label: 'quick preview', action: 'preview', bracketFactor: presult.bracketFactor || 1, allowFree: true });
          return json(res, 200, { ...presult, preview: true, latencyMs: Date.now() - previewStarted, charged: s.charged, fromFree: s.fromFree, wallet: s.wallet });
        }
        return json(res, 200, { ...presult, preview: true, latencyMs: Date.now() - previewStarted });
      }

      // Production billing law: with payments live (or REQUIRE_WALLET=1), the
      // SERVER meters and debits every generation — the client never bills
      // itself and anonymous calls can't burn provider spend.
      // Bound the provider's output to what we reserve, so a prompt engineered to
      // elicit a huge response can't run up a bill beyond the reserved estimate.
      const reservedOut = reservedOutputTokens(body);
      const genBody = { ...body, maxTokens: reservedOut };
      const started = Date.now();
      let debit = null;
      if (billingEnforced()) {
        requireOwner(req, body.user);
        // RESERVE the worst-case cost up front — an atomic hold, so concurrent
        // requests can't all pass one balance check and make us pay the provider
        // many times for one balance's worth (TOCTOU across the await below).
        // reserve() throws 402 (insufficient / frozen); the hold is released on
        // every failure path and settled to the real cost on success.
        const est = Math.max(config.acu.minimumCharge, estimateAcuFor(body, reservedOut));
        const holdKey = `gen_${started}_${crypto.randomUUID()}`;
        reserve({ user: body.user, amount: est, key: holdKey });
        hold = { user: body.user, estimate: est, key: holdKey };
      }
      console.log(`[generate] start effort=${body.effort || 'default'} schema=${body.jsonSchema ? 'yes' : 'no'} maxOut=${reservedOut} billed=${!!hold}`);
      const result = await route(genBody);
      console.log(`[generate] ok provider=${result.provider} latencyMs=${Date.now() - started} acu=${result.acu ?? 0} textLen=${(result.text || '').length}`);
      if (clientGone) {
        if (hold) releaseHold({ user: hold.user, key: hold.key });
        console.log('[generate] client disconnected before result — hold released, no bill');
        return; // socket already closed; do not bill undelivered work
      }
      if (hold) {
        // Settle the hold at the metered cost (bounded ≤ reserved by the output
        // cap), releasing any unused reservation back to the balance.
        const metered = Math.max(config.acu.minimumCharge, Math.min(result.acu || 0, hold.estimate));
        const s = settleHold({
          user: hold.user, key: hold.key, actual: metered,
          label: `generation · ${result.provider}`, action: 'generation', bracketFactor: result.bracketFactor || 1,
        });
        if ((result.acu || 0) > hold.estimate) {
          console.warn(`[generate] cost overrun capped: metered ${result.acu} > reserved ${hold.estimate} user=${hold.user.slice(-8)} — collected ${s.charged}`);
        }
        return json(res, 200, { ...result, latencyMs: Date.now() - started, charged: s.charged, wallet: s.wallet });
      }
      return json(res, 200, { ...result, latencyMs: Date.now() - started });
    } catch (err) {
      if (hold) { try { releaseHold({ user: hold.user, key: hold.key }); } catch {} } // never strand a reservation

      // Every generation failure is logged with its full reason — including
      // GatewayErrors (no_provider, insufficient_acu, provider 4xx) that
      // handleError does not log — so live discovery failures are never silent.
      const attempts = err && err.attempts ? JSON.stringify(err.attempts) : '';
      // Count server/provider-side failures (5xx / no-provider), not normal
      // business rejections (402 insufficient, 403 auth) — so the metric tracks
      // real breakage the watchdog should alert on.
      if (!(err instanceof GatewayError) || (err.status ?? 500) >= 500) metrics.generationFailures += 1;
      console.error(`[generate] failed: code=${err?.code || err?.name || '?'} status=${err?.status ?? '?'} :: ${err?.message || err} ${attempts}`);
      return handleError(res, err);
    }
  }

  return json(res, 404, { error: 'not_found', message: `No route for ${req.method} ${url.pathname}` });
});

function handleError(res, err) {
  if (err instanceof GatewayError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    if (status >= 500) metrics.errors5xx += 1;
    return json(res, status, { ...err.toJSON(), attempts: err.attempts });
  }
  metrics.errors5xx += 1;
  console.error('[gateway] unhandled error:', err);
  return json(res, 500, { error: 'internal_error', message: 'Unexpected gateway error.' });
}

server.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} (mock=${config.mock}) providers=${availableProviders().join(',') || 'none'}`);
  startNewsletterScheduler();
});
