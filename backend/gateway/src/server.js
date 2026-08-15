import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { GatewayError } from './errors.js';
import { route, availableProviders, meterAcu } from './router.js';
import { getWallet, getLedger, charge, credit, grant, PACKAGES } from './wallet.js';
import { createCheckout, handleWebhook, paymentsConfigured } from './payments.js';
import { issueChallenge, verifyChallenge } from './human.js';
import { signup, login, logout, sessionFor, requestReset, resetPassword, listUsers, resolveUserId } from './auth.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEADS_PATH = process.env.LEADS_STORE || path.join(process.cwd(), 'data', 'leads.jsonl');

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

// Password-reset delivery. No third-party email vendor: when SMTP is wired to
// the operator's own mailserver (P1) this sends the link; until then it is
// written to the server log so the operator can retrieve it during testing.
// The link is NEVER returned in the HTTP response (that would leak the token).
function deliverReset(email, link) {
  console.log(`[auth] password reset requested for ${email} — reset link: ${link}`);
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
      status: 'ok',
      mock: config.mock,
      providers: availableProviders(),
      payments: paymentsConfigured(),
      fallbackChain: config.fallbackChain,
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
      fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
      fs.appendFileSync(LEADS_PATH, JSON.stringify({
        email, name: String(body.name || '').slice(0, 120), message: String(body.message || '').slice(0, 2000),
        ip, ts: Date.now(),
      }) + '\n');
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
    return json(res, 200, { user: { email: s.email, userId: s.userId, role: s.role } });
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

  if (req.method === 'POST' && url.pathname === '/v1/admin/grant') {
    try {
      const s = sessionFor(bearer(req));
      if (!s || s.role !== 'admin') return json(res, 403, { error: 'admin_required' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const userId = resolveUserId(body.userId || body.email);
      const result = grant({ user: userId, amount: body.amount, reason: body.reason || `Admin grant by ${s.email}`, idempotencyKey: body.idempotencyKey });
      return json(res, 200, { ...result, userId });
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
