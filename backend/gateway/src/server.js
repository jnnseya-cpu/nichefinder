import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { GatewayError } from './errors.js';
import { route, availableProviders, meterAcu } from './router.js';
import { getWallet, getLedger, charge, credit, grant, summary, deleteWallet, PACKAGES } from './wallet.js';
import { createCheckout, handleWebhook, paymentsConfigured } from './payments.js';
import { issueChallenge, verifyChallenge } from './human.js';
import { signup, login, logout, sessionFor, requestReset, resetPassword, listUsers, resolveUserId, emailForUserId, setRole, setDisabled, userByEmail, updateProfile, setMedia, changePassword, deleteAccount } from './auth.js';
import { sendMail, mailConfigured } from './mailer.js';

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

/* Pre-flight ACU estimate for a generation body (same math as /v1/estimate). */
function estimateAcuFor(body) {
  const chars = JSON.stringify(body.messages || '').length + (body.system?.length || 0);
  const usage = { inputTokens: Math.ceil(chars / 4), outputTokens: body.expectedOutputTokens || 2000 };
  const provider = body.provider && body.provider !== 'auto' ? body.provider : availableProviders()[0] || 'claude';
  return meterAcu(provider, usage, body.investorMode === true, body.capitalGBP);
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
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    return res.end(body);
  } catch {
    return json(res, 404, { error: 'not_found', message: `No file at ${p}` });
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
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
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
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

  if (req.method === 'POST' && url.pathname === '/v1/payments/stripe-webhook') {
    try {
      const raw = await readBody(req);
      return json(res, 200, handleWebhook(raw, req.headers['stripe-signature']));
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
      return json(res, 200, signup({ email: body.email, password: body.password }));
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
      try { deleteWallet(r.userId); } catch { /* wallet may not exist */ }
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
  if (method === 'GET' && url.pathname === '/v1/wallet') {
    try {
      return json(res, 200, getWallet(url.searchParams.get('user')));
    } catch (err) { return handleError(res, err); }
  }

  // /transactions is the spec-facing alias (§10.2 GET /wallet/transactions);
  // /ledger remains for existing clients. Same enriched entries either way.
  if (method === 'GET' && (url.pathname === '/v1/wallet/ledger' || url.pathname === '/v1/wallet/transactions')) {
    try {
      return json(res, 200, { ledger: getLedger(url.searchParams.get('user'), url.searchParams.get('limit')) });
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
        requireCapabilityId(body.user);
      }
      body.idempotencyKey = body.idempotencyKey || req.headers['idempotency-key'];
      const result = url.pathname.endsWith('charge') ? charge(body)
        : isGrant ? grant(body) : credit(body);
      return json(res, 200, result);
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/generate') {
    try {
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
      // Production billing law: with payments live (or REQUIRE_WALLET=1), the
      // SERVER meters and debits every generation — the client never bills
      // itself and anonymous calls can't burn provider spend.
      let debit = null;
      if (billingEnforced()) {
        requireCapabilityId(body.user);
        const est = estimateAcuFor(body);
        const w = getWallet(body.user);
        if (w.paid < est) {
          throw new GatewayError(`Insufficient paid ACU for this generation: estimated ${est}, balance ${w.paid}.`, {
            status: 402, code: 'insufficient_acu', platformCode: 4001,
          });
        }
        debit = { user: body.user, estimate: est };
      }
      const started = Date.now();
      const result = await route(body);
      if (debit) {
        const metered = Math.max(config.acu.minimumCharge, Math.min(result.acu || 0, getWallet(debit.user).paid));
        const charged = charge({
          user: debit.user, amount: metered, label: `generation · ${result.provider}`,
          action: 'generation', bracketFactor: result.bracketFactor || 1,
          idempotencyKey: body.idempotencyKey || `gen_${started}_${debit.user.slice(-8)}`,
        });
        return json(res, 200, { ...result, latencyMs: Date.now() - started, charged: charged.charged, wallet: charged.wallet });
      }
      return json(res, 200, { ...result, latencyMs: Date.now() - started });
    } catch (err) {
      // Every generation failure is logged with its full reason — including
      // GatewayErrors (no_provider, insufficient_acu, provider 4xx) that
      // handleError does not log — so live discovery failures are never silent.
      const attempts = err && err.attempts ? JSON.stringify(err.attempts) : '';
      console.error(`[generate] failed: code=${err?.code || err?.name || '?'} status=${err?.status ?? '?'} :: ${err?.message || err} ${attempts}`);
      return handleError(res, err);
    }
  }

  return json(res, 404, { error: 'not_found', message: `No route for ${req.method} ${url.pathname}` });
});

function handleError(res, err) {
  if (err instanceof GatewayError) {
    return json(res, err.status >= 400 && err.status < 600 ? err.status : 502, { ...err.toJSON(), attempts: err.attempts });
  }
  console.error('[gateway] unhandled error:', err);
  return json(res, 500, { error: 'internal_error', message: 'Unexpected gateway error.' });
}

server.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} (mock=${config.mock}) providers=${availableProviders().join(',') || 'none'}`);
});
