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
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import { grant, clawback } from './wallet.js';
import { makeDocStore } from './store/docstore-backend.js';

const STORE_PATH = process.env.REFERRALS_STORE || path.join(process.cwd(), 'data', 'referrals.json');
const RATE = Number(process.env.REFERRAL_RATE || 0.1); // commission as a fraction of paid GBP
// Anti-abuse cap: the most referral commission any one referrer can ever earn
// (ACU). A two-account "refer myself" scheme is inherent to any referral
// programme; this bounds the loss it can create. 0 = uncapped. Default 50,000
// ACU (£500 of commission ≈ £5,000 of referred spend) — generous for a real
// partner, ruinous for nobody.
const LIFETIME_CAP_ACU = Number(process.env.REFERRAL_LIFETIME_CAP_ACU || 50000);

// Clawback a referrer's commission ACU (refund/chargeback of the referred
// purchase). Clamped inside wallet.clawback so the wallet never goes negative.
function clawbackRef(referrer, amount, reason, idemKey) {
  try { clawback({ user: referrer, amount, reason, idempotencyKey: idemKey }); }
  catch (e) { console.error('[referrals] clawback failed:', e.message); }
}
const PUBLIC_ORIGIN = () => (process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '');
const CAP_RE = /^op_[a-z0-9]{10,}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

// Persistence via the shared document backend (STORE_BACKEND=file|sqlite).
// Referral awards are money (commissions), so writes are now durable — the
// previous 50 ms debounce could lose a just-recorded award on a crash. The file
// backend does a synchronous fsync'd atomic write; sqlite a transactional
// full-replace. Plaintext at rest (no secrets; ids + relationships only).
const doc = makeDocStore({
  storePath: STORE_PATH, storeKey: null,
  dbPath: process.env.REFERRALS_DB || path.join(process.cwd(), 'data', 'referrals.db'),
  defaultStore: { codes: {}, byCode: {}, links: {}, earned: {}, awarded: {}, awardAmount: {}, reversed: {} },
});
let store = doc.load();
function persist() { doc.persist(store); }
// flush() stays for existing callers; persistence is already synchronous.
export function flush() { doc.persist(store); }

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
  let commissionAcu = Math.round(Number(gbp || 0) * RATE * 100); // £1 = 100 ACU
  if (commissionAcu <= 0) return { rewarded: false, reason: 'zero_commission' };
  const e = earnedFor(referrer);
  // Anti-abuse: cap lifetime commission per referrer. Award only up to the
  // remaining headroom; past the cap, referrals still track but pay nothing —
  // bounding what a self-referral ("two accounts") scheme can extract.
  if (LIFETIME_CAP_ACU > 0) {
    const remaining = Math.max(0, LIFETIME_CAP_ACU - (e.acu || 0));
    if (remaining <= 0) {
      store.awarded[key] = true; (store.awardAmount ||= {})[key] = 0;
      if (!e.qualified.includes(user)) e.qualified.push(user);
      persist();
      return { rewarded: false, reason: 'lifetime_cap_reached' };
    }
    commissionAcu = Math.min(commissionAcu, remaining);
  }
  // Credit the referrer's spendable wallet; grant() is itself idempotent on key.
  grant({ user: referrer, amount: commissionAcu, reason: `Referral commission · ${String(user).slice(-6)}`, idempotencyKey: key });
  store.awarded[key] = true;
  (store.awardAmount ||= {})[key] = commissionAcu; // remembered so a refund can reverse exactly this much
  if (!e.qualified.includes(user)) e.qualified.push(user);
  e.acu += commissionAcu;
  e.gbp = Math.round((e.gbp + Number(gbp || 0) * RATE) * 100) / 100;
  persist();
  return { rewarded: true, referrer, commissionAcu };
}

/* Reverse a referral commission when the underlying purchase is refunded or
   charged back. Claws the commission ACU back from the referrer (clamped at
   their balance — never negative) and reverses the recorded earnings, so a
   refund fraud can't mint permanent referral value. Idempotent: only reverses a
   commission that was actually awarded, and only once. */
export function onPurchaseReversed({ user, purchaseKey }) {
  const key = `ref_${purchaseKey}`;
  if (!store.awarded[key] || store.reversed?.[key]) return { reversed: false, reason: 'nothing_to_reverse' };
  const referrer = store.links[user];
  if (!referrer) return { reversed: false, reason: 'no_referrer' };
  const e = earnedFor(referrer);
  // The commission for THIS purchase isn't stored line-by-line, so recompute it
  // from the recorded award. We stored the ACU on the aggregate; reverse the
  // same amount we would have granted. Re-derive from the grant idempotency
  // replay is not possible, so we recompute from the purchase is not available
  // here — instead we clawback using the aggregate delta captured at award time.
  const amount = store.awardAmount?.[key] || 0;
  if (amount <= 0) { (store.reversed ||= {})[key] = true; persist(); return { reversed: false, reason: 'zero_amount' }; }
  clawbackRef(referrer, amount, `Referral reversal · ${String(user).slice(-6)}`, `${key}_rev`);
  e.acu = Math.max(0, (e.acu || 0) - amount);
  (store.reversed ||= {})[key] = true;
  persist();
  return { reversed: true, referrer, amount };
}

/* Admin overview: every account with referral activity, its real stats, and
   program totals. Commission is auto-paid as ACU at qualification time (see the
   file header) — so acuEarned is already-paid, not a pending payout. Read-only. */
export function listPartners() {
  const ids = new Set([...Object.keys(store.codes), ...Object.keys(store.earned)]);
  const rows = [];
  for (const userId of ids) {
    const e = store.earned[userId] || { referrals: [], qualified: [], acu: 0, gbp: 0 };
    if (!e.referrals.length && !e.qualified.length && !e.acu) continue; // no activity → not a partner row
    rows.push({
      userId,
      code: store.codes[userId] || null,
      totalReferrals: e.referrals.length,
      qualifiedReferrals: e.qualified.length,
      acuEarned: e.acu || 0,
      gbpEarned: Math.round((e.gbp || 0) * 100) / 100,
    });
  }
  rows.sort((a, b) => b.acuEarned - a.acuEarned);
  const totals = rows.reduce((t, r) => ({
    partners: t.partners + 1,
    referrals: t.referrals + r.totalReferrals,
    qualified: t.qualified + r.qualifiedReferrals,
    acuPaid: t.acuPaid + r.acuEarned,
    gbpCommission: Math.round((t.gbpCommission + r.gbpEarned) * 100) / 100,
  }), { partners: 0, referrals: 0, qualified: 0, acuPaid: 0, gbpCommission: 0 });
  return { rows, totals, ratePct: Math.round(RATE * 100) };
}

/* Right-to-erasure: remove all referral personal data for a deleted account —
   their invite code, their referral links (as referee AND as referrer), their
   earnings record, and any mention of them in other referrers' referral lists.
   Purchase-keyed `awarded`/`awardAmount` flags are retained (they are opaque
   payment ids, not personal data, and guard against a re-award on a late webhook).
   Returns how many of the user's own records were removed. */
export function deleteUserData(userId) {
  let removed = 0;
  const code = store.codes[userId];
  if (code) { delete store.codes[userId]; delete store.byCode[code]; removed++; }
  if (store.earned[userId]) { delete store.earned[userId]; removed++; }
  if (store.links[userId]) { delete store.links[userId]; removed++; }              // this user was referred by someone
  for (const [referee, referrer] of Object.entries(store.links)) {
    if (referrer === userId) { delete store.links[referee]; removed++; }           // this user referred others
  }
  for (const e of Object.values(store.earned)) {                                    // scrub mentions in others' lists
    if (Array.isArray(e.referrals)) e.referrals = e.referrals.filter((r) => r !== userId);
    if (Array.isArray(e.qualified)) e.qualified = e.qualified.filter((r) => r !== userId);
  }
  persist();
  return removed;
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
