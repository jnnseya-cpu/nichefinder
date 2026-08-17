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
import { encryptStore, decryptStore, peekWallet, deleteWallet } from './wallet.js';
import { attachReferral } from './referrals.js';

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
const publicUser = (u) => ({
  email: u.email, userId: u.userId, role: u.role, createdAt: u.createdAt, disabled: !!u.disabled,
  name: (u.profile && u.profile.name) || '',
  company: (u.profile && u.profile.company) || '',
  country: (u.profile && u.profile.country) || '',
  bio: (u.profile && u.profile.bio) || '',
  avatar: (u.profile && u.profile.avatar) || '',
  cover: (u.profile && u.profile.cover) || '',
});
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

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

export function signup({ email, password, ref }) {
  const em = normEmail(email);
  if (!EMAIL_RE.test(em)) throw new GatewayError('Enter a valid email address.', { status: 400, code: 'invalid_email' });
  validatePassword(password);
  if (store.users[em]) throw new GatewayError('An account with this email already exists.', { status: 409, code: 'email_taken' });
  const salt = crypto.randomBytes(16).toString('hex');
  const role = em === normEmail(process.env.ADMIN_EMAIL) ? 'admin' : 'user';
  const u = { email: em, userId: newUserId(), salt, hash: hashPassword(password, salt), role, createdAt: Date.now(), reset: null };
  store.users[em] = u;
  // Attribute the referral if this signup carried an invite code. Best-effort:
  // a bad/self/duplicate code is silently ignored (never blocks signup). Admins
  // don't participate as referees.
  if (ref && role !== 'admin') { try { attachReferral({ referee: u.userId, code: ref }); } catch { /* non-fatal */ } }
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

// Admin view: every account with its live ACU balance. Admins are operators,
// not customers — they carry no consumer wallet (wallet = null → shown as "—").
// Uses peekWallet so listing never mints a welcome wallet as a side effect.
export function listUsers() {
  return Object.values(store.users)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((u) => {
      const wallet = u.role === 'admin' ? null : (peekWallet(u.userId) || { paid: 0, free: 0, total: 0 });
      return { ...publicUser(u), wallet };
    });
}

// --- Newsletter audience ----------------------------------------------------
// The weekly product email goes to real customers who haven't opted out. Admins
// are operators (no mailbox) and disabled accounts are excluded.
export function listNewsletterRecipients() {
  return Object.values(store.users)
    .filter((u) => u.role === 'user' && !u.disabled && !u.newsletterOptOut)
    .map((u) => ({ email: u.email, userId: u.userId, name: (u.profile && u.profile.name) || '' }));
}

// One-click unsubscribe: flip the opt-out flag for the account behind a userId.
// Idempotent — unsubscribing an already-unsubscribed account still returns ok.
export function setNewsletterOptOut(userId, optOut) {
  const u = Object.values(store.users).find((x) => x.userId === userId);
  if (!u) throw new GatewayError('No such subscriber.', { status: 404, code: 'user_not_found' });
  u.newsletterOptOut = !!optOut;
  persist();
  return { ok: true, email: u.email, optOut: u.newsletterOptOut };
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
  if (role === 'admin') { try { deleteWallet(u.userId); } catch { /* none */ } } // operators hold no consumer ACUs
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

export function userByEmail(email) {
  const u = store.users[normEmail(email)];
  return u ? publicUser(u) : null;
}

// Self-service profile: account-holder name + optional details.
export function updateProfile(email, fields) {
  const u = store.users[normEmail(email)];
  if (!u) throw new GatewayError('No such user.', { status: 404, code: 'user_not_found' });
  u.profile = u.profile || {};
  if (fields.name !== undefined) u.profile.name = clip(fields.name, 80);
  if (fields.company !== undefined) u.profile.company = clip(fields.company, 80);
  if (fields.country !== undefined) u.profile.country = clip(fields.country, 60);
  if (fields.bio !== undefined) u.profile.bio = clip(fields.bio, 400);
  persist();
  return publicUser(u);
}

// Store the filename of an uploaded profile picture / cover (bytes live on disk;
// the gateway handles the file IO and passes us the resulting filename).
export function setMedia(email, kind, filename) {
  if (!['avatar', 'cover'].includes(kind)) throw new GatewayError('Invalid media kind.', { status: 400, code: 'invalid_kind' });
  const u = store.users[normEmail(email)];
  if (!u) throw new GatewayError('No such user.', { status: 404, code: 'user_not_found' });
  u.profile = u.profile || {};
  u.profile[kind] = filename;
  persist();
  return publicUser(u);
}

// Change password: requires the current one; rotates the salt. Existing sessions
// stay valid — the user isn't logged out of their own device.
export function changePassword(email, currentPassword, newPassword) {
  const u = store.users[normEmail(email)];
  if (!u) throw new GatewayError('No such user.', { status: 404, code: 'user_not_found' });
  if (!timingEqualHex(hashPassword(currentPassword || '', u.salt), u.hash)) {
    throw new GatewayError('Current password is incorrect.', { status: 403, code: 'bad_current_password' });
  }
  validatePassword(newPassword);
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPassword(newPassword, u.salt);
  persist();
  return { ok: true };
}

// Permanently delete an account: requires the current password. Returns the
// userId so the caller can also drop the wallet. Sessions are all revoked.
export function deleteAccount(email, currentPassword) {
  const em = normEmail(email);
  const u = store.users[em];
  if (!u) throw new GatewayError('No such user.', { status: 404, code: 'user_not_found' });
  if (!timingEqualHex(hashPassword(currentPassword || '', u.salt), u.hash)) {
    throw new GatewayError('Password is incorrect.', { status: 403, code: 'bad_current_password' });
  }
  const userId = u.userId;
  delete store.users[em];
  for (const [h, s] of Object.entries(store.sessions)) if (s.email === em) delete store.sessions[h];
  persist();
  return { ok: true, userId };
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
    const admin = { email: em, userId: newUserId(), salt, hash: hashPassword(pw, salt), role: 'admin', createdAt: Date.now(), reset: null };
    store.users[em] = admin;
    try { deleteWallet(admin.userId); } catch { /* none */ }
    persist();
    return;
  }
  let changed = false;
  if (existing.role !== 'admin') { existing.role = 'admin'; changed = true; }
  try { deleteWallet(existing.userId); } catch { /* operators hold no consumer ACUs */ }
  if (!timingEqualHex(hashPassword(pw, existing.salt), existing.hash)) {
    existing.salt = crypto.randomBytes(16).toString('hex');
    existing.hash = hashPassword(pw, existing.salt);
    for (const [h, s] of Object.entries(store.sessions)) if (s.email === em) delete store.sessions[h];
    changed = true;
  }
  if (changed) persist();
}

seedAdmin();
