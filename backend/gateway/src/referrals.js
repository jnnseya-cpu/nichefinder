// Growth Partner (referral) programme — real tracking, not a stub.
//
// Model, matching the product promise ("rewards real paid usage, not fake
// sign-ups"):
//   • Every account has a stable invite code derived from its userId.
//   • A signup carrying ?ref=CODE links referee → referrer (counts as a
//     referral, but earns nothing yet).
//   • When that referred user makes a REAL paid purchase (Stripe/KODA settlement
//     webhook), the referral becomes "qualified" and the referrer earns a
//     commission of REFERRAL_RATE × the purchase, credited as spendable ACU.
//
// Commission is paid in-platform as ACU (£1 = 100 ACU), so there is no cash
// payout rail to build or secure. Awards are idempotent on the purchase id, so
// webhook retries never double-pay.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import { grant } from './wallet.js';

const STORE_PATH = process.env.REFERRALS_STORE || path.join(process.cwd(), 'data', 'referrals.json');
const RATE = Number(process.env.REFERRAL_RATE || 0.1); // commission as a fraction of paid GBP
const PUBLIC_ORIGIN = () => (process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '');
const CAP_RE = /^op_[a-z0-9]{10,}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

let store = load();
let timer = null;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { codes: {}, byCode: {}, links: {}, earned: {}, awarded: {} };
  }
}

function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_PATH); // atomic swap
    } catch (err) {
      console.error('[referrals] persist failed:', err.message);
    }
  }, 50);
}

// Persist synchronously in tests / shutdown paths so assertions see fresh state.
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store));
  } catch { /* best effort */ }
}

function earnedFor(userId) {
  if (!store.earned[userId]) store.earned[userId] = { referrals: [], qualified: [], acu: 0, gbp: 0 };
  return store.earned[userId];
}

/* Stable, collision-free invite code for an account. Deterministic from the
   userId so it never changes, with a salted rehash on the astronomically rare
   collision. */
export function codeFor(userId) {
  if (!CAP_RE.test(String(userId || ''))) {
    throw new GatewayError('A valid account id is required.', { status: 403, code: 'invalid_user_id' });
  }
  if (store.codes[userId]) return store.codes[userId];
  let code;
  for (let salt = 0; ; salt++) {
    const h = crypto.createHash('sha256').update(`${userId}:${salt}`).digest();
    code = 'NF-' + Array.from({ length: 8 }, (_, i) => ALPHABET[h[i] % 32]).join('');
    if (!store.byCode[code]) break;
  }
  store.codes[userId] = code;
  store.byCode[code] = userId;
  persist();
  return code;
}

/* Link a new signup to its referrer. No-op (never throws) on a bad/unknown code,
   a self-referral, or an account that is already attributed — first touch wins. */
export function attachReferral({ referee, code }) {
  if (!CAP_RE.test(String(referee || ''))) return { linked: false, reason: 'bad_referee' };
  const normalized = String(code || '').trim().toUpperCase();
  const referrer = store.byCode[normalized];
  if (!referrer || referrer === referee) return { linked: false, reason: 'invalid_code' };
  if (store.links[referee]) return { linked: false, reason: 'already_linked' };
  store.links[referee] = referrer;
  const e = earnedFor(referrer);
  if (!e.referrals.includes(referee)) e.referrals.push(referee);
  persist();
  return { linked: true, referrer };
}

/* Called after a real paid purchase settles. Qualifies the referral and credits
   the referrer's commission as spendable ACU, exactly once per purchase. */
export function onPaidPurchase({ user, gbp, purchaseKey }) {
  const referrer = store.links[user];
  if (!referrer) return { rewarded: false, reason: 'no_referrer' };
  const key = `ref_${purchaseKey}`;
  if (store.awarded[key]) return { rewarded: false, reason: 'already_awarded' };
  const commissionAcu = Math.round(Number(gbp || 0) * RATE * 100); // £1 = 100 ACU
  if (commissionAcu <= 0) return { rewarded: false, reason: 'zero_commission' };
  // Credit the referrer's spendable wallet; grant() is itself idempotent on key.
  grant({ user: referrer, amount: commissionAcu, reason: `Referral commission · ${String(user).slice(-6)}`, idempotencyKey: key });
  store.awarded[key] = true;
  const e = earnedFor(referrer);
  if (!e.qualified.includes(user)) e.qualified.push(user);
  e.acu += commissionAcu;
  e.gbp = Math.round((e.gbp + Number(gbp || 0) * RATE) * 100) / 100;
  persist();
  return { rewarded: true, referrer, commissionAcu };
}

/* Dashboard summary for one account. */
export function summaryFor(userId) {
  const code = codeFor(userId);
  const e = store.earned[userId] || { referrals: [], qualified: [], acu: 0, gbp: 0 };
  return {
    code,
    link: `${PUBLIC_ORIGIN()}/?ref=${code}`,
    totalReferrals: e.referrals.length,
    qualifiedReferrals: e.qualified.length,
    acuEarned: e.acu,
    gbpEarned: Math.round((e.gbp || 0) * 100) / 100,
    ratePct: Math.round(RATE * 100),
  };
}
