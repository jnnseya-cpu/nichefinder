// In-house accounts + sessions — NO third-party auth vendor.
//   Passwords: scrypt with a per-user random salt; only the derived hash is
//     stored, compared in constant time.
//   Sessions: opaque 256-bit bearer tokens; only their SHA-256 is stored, so a
//     leaked store cannot be replayed as a live session.
//   Reset: single-use, hashed, 1-hour tokens; using one rotates the salt and
//     invalidates every existing session for that account.
// The store is encrypted at rest with WALLET_STORE_KEY (same AES-256-GCM
// envelope as the wallet store), and admin is a role, never a client claim.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import { encryptStore, decryptStore, getWallet } from './wallet.js';

const STORE_PATH = process.env.AUTH_STORE || path.join(process.cwd(), 'data', 'auth.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TTL_MS = 60 * 60 * 1000;             // 1 hour
const SCRYPT_KEYLEN = 64;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STORE_KEY = (() => {
  const hex = process.env.WALLET_STORE_KEY || '';
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
})();

let store = load();

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    if (raw.startsWith('NFE1:')) {
      if (!STORE_KEY) throw new Error('auth store is encrypted but WALLET_STORE_KEY is not set');
      return JSON.parse(decryptStore(raw, STORE_KEY));
    }
    return JSON.parse(raw);
  } catch (err) {
    if (String(err.message).includes('WALLET_STORE_KEY')) throw err; // loud: never silently reset an encrypted store
    return { users: {}, sessions: {} };
  }
}

// Synchronous atomic write (tmp + rename): auth mutations are infrequent and
// must be durable before a token is handed back, so no debounce here.
function persist() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  const json = JSON.stringify(store);
  fs.writeFileSync(tmp, STORE_KEY ? encryptStore(json, STORE_KEY) : json);
  fs.renameSync(tmp, STORE_PATH);
}

const normEmail = (email) => String(email || '').trim().toLowerCase();
const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
// Capability-grade wallet id matching the gateway's ^op_[a-z0-9]{10,}$ contract.
const newUserId = () => 'op_' + Array.from(crypto.randomBytes(16), (b) => (b % 36).toString(36)).join('');
const publicUser = (u) => ({ email: u.email, userId: u.userId, role: u.role, createdAt: u.createdAt, disabled: !!u.disabled });

function timingEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    throw new GatewayError('Password must be at least 8 characters.', { status: 400, code: 'weak_password' });
  }
  if (pw.length > 200) throw new GatewayError('Password is too long (max 200 characters).', { status: 400, code: 'weak_password' });
}

function pruneSessions() {
  const now = Date.now();
  for (const [h, s] of Object.entries(store.sessions)) if (s.exp < now) delete store.sessions[h];
}

function createSession(u) {
  const token = newToken();
  store.sessions[tokenHash(token)] = { email: u.email, userId: u.userId, role: u.role, exp: Date.now() + SESSION_TTL_MS };
  pruneSessions();
  persist();
  return token;
}

export function signup({ email, password }) {
  const em = normEmail(email);
  if (!EMAIL_RE.test(em)) throw new GatewayError('Enter a valid email address.', { status: 400, code: 'invalid_email' });
  validatePassword(password);
  if (store.users[em]) throw new GatewayError('An account with this email already exists.', { status: 409, code: 'email_taken' });
  const salt = crypto.randomBytes(16).toString('hex');
  const role = em === normEmail(process.env.ADMIN_EMAIL) ? 'admin' : 'user';
  const u = { email: em, userId: newUserId(), salt, hash: hashPassword(password, salt), role, createdAt: Date.now(), reset: null };
  store.users[em] = u;
  const token = createSession(u);
  return { token, user: publicUser(u) };
}

export function login({ email, password }) {
  const em = normEmail(email);
  const u = store.users[em];
  const fail = new GatewayError('Incorrect email or password.', { status: 401, code: 'bad_credentials' });
  if (!u) { hashPassword(password || '', '0'.repeat(32)); throw fail; } // equalise timing for unknown emails
  if (!timingEqualHex(hashPassword(password, u.salt), u.hash)) throw fail;
  if (u.disabled) throw new GatewayError('This account has been disabled. Contact support.', { status: 403, code: 'account_disabled' });
  const token = createSession(u);
  return { token, user: publicUser(u) };
}

export function logout(token) {
  if (token) { delete store.sessions[tokenHash(token)]; persist(); }
  return { ok: true };
}

export function sessionFor(token) {
  if (!token) return null;
  const h = tokenHash(token);
  const s = store.sessions[h];
  if (!s) return null;
  if (s.exp < Date.now()) { delete store.sessions[h]; persist(); return null; }
  return s;
}

// Returns the raw reset token to the CALLER (server route) for delivery only —
// it is never sent to the browser. No-op (but still ok:true) for unknown emails
// so the endpoint can't be used to enumerate accounts.
export function requestReset({ email }) {
  const em = normEmail(email);
  const u = store.users[em];
  if (!u) return { ok: true, sent: false };
  const token = newToken();
  u.reset = { hash: tokenHash(token), exp: Date.now() + RESET_TTL_MS };
  persist();
  return { ok: true, sent: true, email: em, token };
}

export function resetPassword({ email, token, password }) {
  const em = normEmail(email);
  const u = store.users[em];
  validatePassword(password);
  const bad = new GatewayError('This reset link is invalid or has expired.', { status: 400, code: 'invalid_reset' });
  if (!u || !u.reset || u.reset.exp < Date.now()) { if (u && u.reset) { u.reset = null; persist(); } throw bad; }
  if (!timingEqualHex(tokenHash(token || ''), u.reset.hash)) throw bad;
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPassword(password, u.salt);
  u.reset = null;
  for (const [h, s] of Object.entries(store.sessions)) if (s.email === em) delete store.sessions[h]; // force re-login everywhere
  persist();
  return { ok: true };
}

// Admin view: every account with its live ACU balance (reading a wallet mints
// the welcome wallet if absent — harmless and expected).
export function listUsers() {
  return Object.values(store.users)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((u) => {
      let wallet = { paid: 0, free: 0, total: 0 };
      try { wallet = getWallet(u.userId); } catch { /* leave zeros */ }
      return { ...publicUser(u), wallet };
    });
}

// Resolve an admin-supplied target (either a capability id or an email) to the
// canonical wallet userId a grant should credit.
export function resolveUserId(idOrEmail) {
  const s = String(idOrEmail || '').trim();
  if (/^op_[a-z0-9]{10,}$/.test(s)) return s;
  const u = store.users[normEmail(s)];
  if (u) return u.userId;
  throw new GatewayError('No user found for that id or email.', { status: 404, code: 'user_not_found' });
}

// Reverse lookup for the admin console (userId -> account email), so purchases
// and ledgers can be shown against a human-readable identity.
export function emailForUserId(userId) {
  for (const u of Object.values(store.users)) if (u.userId === userId) return u.email;
  return null;
}

// Admin: change a user's role. Live sessions get the new role immediately.
export function setRole(email, role) {
  if (!['admin', 'user'].includes(role)) throw new GatewayError('Role must be "admin" or "user".', { status: 400, code: 'invalid_role' });
  const u = store.users[normEmail(email)];
  if (!u) throw new GatewayError('No such user.', { status: 404, code: 'user_not_found' });
  u.role = role;
  for (const s of Object.values(store.sessions)) if (s.email === u.email) s.role = role;
  persist();
  return publicUser(u);
}

// Admin: disable/enable an account. Disabling ends all its sessions and blocks
// login; the wallet/balance is untouched (money is never destroyed).
export function setDisabled(email, disabled) {
  const u = store.users[normEmail(email)];
  if (!u) throw new GatewayError('No such user.', { status: 404, code: 'user_not_found' });
  u.disabled = !!disabled;
  if (u.disabled) for (const [h, s] of Object.entries(store.sessions)) if (s.email === u.email) delete store.sessions[h];
  persist();
  return publicUser(u);
}

// Seed (or reconcile) the admin account from the environment on boot. The admin
// login has no mailbox, so ADMIN_PASSWORD in the (chmod 600) env file is the
// source of truth and the recovery path: create the account if missing, keep it
// admin, and rotate its password to match env whenever they differ (edit env +
// restart = password reset). Only the derived hash is ever stored.
export function seedAdmin() {
  const em = normEmail(process.env.ADMIN_EMAIL);
  const pw = process.env.ADMIN_PASSWORD;
  if (!em || !pw) return;
  const existing = store.users[em];
  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex');
    store.users[em] = { email: em, userId: newUserId(), salt, hash: hashPassword(pw, salt), role: 'admin', createdAt: Date.now(), reset: null };
    persist();
    return;
  }
  let changed = false;
  if (existing.role !== 'admin') { existing.role = 'admin'; changed = true; }
  if (!timingEqualHex(hashPassword(pw, existing.salt), existing.hash)) {
    existing.salt = crypto.randomBytes(16).toString('hex');
    existing.hash = hashPassword(pw, existing.salt);
    for (const [h, s] of Object.entries(store.sessions)) if (s.email === em) delete store.sessions[h];
    changed = true;
  }
  if (changed) persist();
}

seedAdmin();
