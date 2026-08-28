// P0 wallet service: the ACU system of record moves off localStorage and onto
// the server. File-persisted JSON store (swap for Postgres in P1 — the handler
// contract below is the stable surface). Single-process writes are serialized
// through an in-memory queue, so balances never race.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import '../../../shared/nf-economy.js'; // canonical economy → globalThis.NF_ECONOMY

const ECONOMY = globalThis.NF_ECONOMY;
const STORE_PATH = process.env.WALLET_STORE || path.join(process.cwd(), 'data', 'wallets.json');
const WELCOME_FREE = ECONOMY.WELCOME_FREE;
const LEDGER_CAP = 500;

/* ---- encryption at rest (E2EE law, Addendum A) ----
   Set WALLET_STORE_KEY to a 64-char hex string (32 bytes) and the store is
   written as an AES-256-GCM envelope ("NFE1:iv:tag:ct"), tamper-evident by
   GCM authentication. The key lives in the environment — never beside the
   data. Without the key the store falls back to plaintext JSON and logs a
   warning so a misconfigured production deploy is loud, not silent. */
const STORE_KEY = (() => {
  const hex = process.env.WALLET_STORE_KEY || '';
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.error('[gateway] WALLET_STORE_KEY must be 64 hex chars (32 bytes) — store encryption DISABLED');
    return null;
  }
  return Buffer.from(hex, 'hex');
})();
if (!STORE_KEY) console.warn('[gateway] WALLET_STORE_KEY not set — wallet store is NOT encrypted at rest');

export function encryptStore(json, key = STORE_KEY) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return `NFE1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptStore(envelope, key = STORE_KEY) {
  const [magic, ivB64, tagB64, ctB64] = envelope.split(':');
  if (magic !== 'NFE1') throw new Error('not an NFE1 envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// Derived from shared/nf-economy.js — the client displays what the server enforces.
export const PACKAGES = Object.fromEntries(
  ECONOMY.PACKAGES.map((p) => [p.id, { name: p.name, priceGBP: p.priceGBP, acus: p.acus, bonus: p.bonus }])
);
export const PLANS = Object.fromEntries(
  (ECONOMY.PLANS || []).map((p) => [p.id, { name: p.name, priceGBP: p.priceGBP, acusPerMonth: p.acusPerMonth, selfServe: p.selfServe }])
);

let store = load();

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    if (raw.startsWith('NFE1:')) {
      if (!STORE_KEY) throw new Error('store is encrypted but WALLET_STORE_KEY is not set');
      return JSON.parse(decryptStore(raw));
    }
    return JSON.parse(raw);
  } catch (err) {
    if (String(err.message).includes('WALLET_STORE_KEY')) throw err; // loud: never silently reset an encrypted store
    return { wallets: {}, idempotency: {} };
  }
}

function persist() {
  // SYNCHRONOUS durable write — money must survive a crash. The store is the
  // system of record for real balances, so we do NOT debounce: the previous
  // 50 ms setTimeout window could lose a just-committed charge/credit if the
  // process died before it flushed. Write to a tmp file, fsync it to disk, then
  // atomically rename over the store (so a reader never sees a truncated file).
  // (Superseded at scale by the SQLite/WAL backend — docs/DB-MIGRATION.md.)
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  const json = JSON.stringify(store);
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, STORE_KEY ? encryptStore(json) : json); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, STORE_PATH);
}

function requireUser(userId) {
  if (!userId || typeof userId !== 'string' || userId.length > 128) {
    throw new GatewayError('A "user" id is required.', { status: 400, code: 'user_required' });
  }
  if (!store.wallets[userId]) {
    store.wallets[userId] = {
      paid: 0,
      free: WELCOME_FREE,
      ledger: [{
        t: 'WELCOME · 100 free read-only ACU', amt: WELCOME_FREE, ts: Date.now(),
        type: 'credit_welcome', pool: 'free', balanceBefore: 0, balanceAfter: WELCOME_FREE, bracketFactor: 1,
      }],
      createdAt: Date.now(),
    };
    persist();
  }
  return store.wallets[userId];
}

// Ledger entries follow the acu_transactions contract from the transformation
// spec (§9): balance snapshots, pool used, and the bracket factor applied.
function ledger(wallet, label, amt, extra = {}) {
  const before = wallet.paid + wallet.free - amt;
  wallet.ledger.unshift({
    t: label, amt, ts: Date.now(),
    balanceBefore: before, balanceAfter: before + amt,
    ...extra,
  });
  if (wallet.ledger.length > LEDGER_CAP) wallet.ledger.length = LEDGER_CAP;
}

// Spendable = owned paid balance minus funds currently HELD by in-flight
// reservations. Every path that spends must check this, not raw `paid`, or two
// concurrent requests could both pass a balance check and make us pay a provider
// twice for one balance's worth of ACU (a TOCTOU between check and charge).
function spendable(wallet) {
  return wallet.paid - (wallet.held || 0);
}

function view(wallet) {
  return {
    paid: wallet.paid, free: wallet.free, total: wallet.paid + wallet.free,
    held: wallet.held || 0, spendable: spendable(wallet) + wallet.free,
    plan: wallet.plan || null,
  };
}

function idempotent(key, fn) {
  if (key) {
    const prior = store.idempotency[key];
    if (prior) return { replayed: true, ...prior };
  }
  const result = fn();
  if (key) {
    store.idempotency[key] = result;
    const keys = Object.keys(store.idempotency);
    if (keys.length > 20000) {
      // Evict the oldest NON-settlement key. Payment settlement keys
      // (stripe_/koda_) must NEVER be evicted — a late webhook replay after
      // eviction would double-credit real money. Transient generation keys are
      // safe to drop.
      const victim = keys.find((k) => !/^(stripe_|koda_)/.test(k));
      if (victim) delete store.idempotency[victim];
    }
  }
  return { replayed: false, ...result };
}

export function getWallet(userId) {
  return view(requireUser(userId));
}

// Remove a wallet entirely (account deletion). Money records are the user's own
// data; deletion is explicit and password-confirmed at the auth layer.
export function deleteWallet(userId) {
  if (store.wallets[userId]) { delete store.wallets[userId]; persist(); return true; }
  return false;
}

// Read a wallet WITHOUT creating one (unlike getWallet, which mints the welcome
// wallet on first touch). Returns null if the user has no wallet yet — used so
// the admin console can list operators without minting welcome ACUs for them.
export function peekWallet(userId) {
  const w = store.wallets[userId];
  return w ? view(w) : null;
}

// Platform-wide aggregates for the admin console: balances, real revenue, and
// the purchase list. Revenue is parsed from the £ in each credit_purchase
// ledger label (grants/welcome ACUs are correctly excluded — they aren't sales).
export function summary() {
  let paidTotal = 0, freeTotal = 0, acusSold = 0, revenueGBP = 0, grantsTotal = 0;
  const purchases = [];
  for (const [userId, w] of Object.entries(store.wallets)) {
    paidTotal += w.paid; freeTotal += w.free;
    for (const e of w.ledger) {
      if (e.type === 'credit_purchase') {
        const m = /£(\d+(?:\.\d+)?)/.exec(e.t || '');
        const gbp = m ? Number(m[1]) : 0;
        revenueGBP += gbp; acusSold += e.amt;
        purchases.push({ userId, gbp, acus: e.amt, ts: e.ts, label: e.t });
      } else if (e.type === 'credit_grant') {
        grantsTotal += e.amt;
      }
    }
  }
  purchases.sort((a, b) => b.ts - a.ts);
  return {
    walletCount: Object.keys(store.wallets).length,
    paidTotal, freeTotal, acusSold,
    revenueGBP: Math.round(revenueGBP * 100) / 100,
    grantsTotal, purchases: purchases.slice(0, 200),
  };
}

export function getLedger(userId, limit = 50) {
  return requireUser(userId).ledger.slice(0, Math.min(Number(limit) || 50, LEDGER_CAP));
}

// Paid ACUs only — welcome ACUs are read-only and can never fund generation.
// Optional metadata mirrors acu_transactions (§9): action key, bracket factor, reference.
export function charge({ user, amount, label, idempotencyKey, action, bracketFactor, referenceId }) {
  const wallet = requireUser(user);
  const cost = Math.floor(Number(amount));
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new GatewayError('"amount" must be a positive integer of ACUs.', { status: 400, code: 'invalid_amount' });
  }
  const bf = Number.isFinite(Number(bracketFactor)) && Number(bracketFactor) >= 1 ? Number(bracketFactor) : 1;
  return idempotent(idempotencyKey, () => {
    if (wallet.frozen) {
      throw new GatewayError('This wallet is temporarily frozen pending a payment dispute. Contact support.', {
        status: 402, code: 'wallet_frozen', platformCode: 4002,
      });
    }
    if (spendable(wallet) < cost) {
      // platformCode 4001 = "Insufficient ACUs" in the spec's API error registry (§10.1).
      throw new GatewayError(`Insufficient paid ACU: need ${cost}, have ${spendable(wallet)}. Welcome ACUs are read-only.`, {
        status: 402,
        code: 'insufficient_acu',
        platformCode: 4001,
      });
    }
    wallet.paid -= cost;
    ledger(wallet, `OPERATIONAL_TASK · ${String(label || 'action').slice(0, 120)}`, -cost, {
      type: action ? `debit_${String(action).slice(0, 40)}` : 'debit_action',
      pool: 'paid',
      bracketFactor: bf,
      ...(referenceId ? { referenceId: String(referenceId).slice(0, 64) } : {}),
    });
    persist();
    return { charged: cost, bracketFactor: bf, wallet: view(wallet) };
  });
}

/* ---- reserve → settle: atomic spend for async work (the TOCTOU seal) ----
   A generation/document runs an `await` between "do you have the funds?" and
   "take the funds". Without a hold, N concurrent requests all see the same
   balance, all pass, and we pay the provider N times for one balance's worth.
   reserve() debits nothing but PLACES A HOLD synchronously (atomic in Node's
   single thread), so the next concurrent request sees reduced spendable and is
   refused. After the work completes we settle() the real cost (≤ the hold) and
   release the rest, or release() the whole hold on failure/cancel — the caller
   is never billed for work it didn't deliver. */
export function reserve({ user, amount, key }) {
  const wallet = requireUser(user);
  const hold = Math.ceil(Number(amount));
  if (!Number.isFinite(hold) || hold <= 0) {
    throw new GatewayError('"amount" must be a positive integer of ACUs.', { status: 400, code: 'invalid_amount' });
  }
  if (wallet.frozen) {
    throw new GatewayError('This wallet is temporarily frozen pending a payment dispute. Contact support.', { status: 402, code: 'wallet_frozen', platformCode: 4002 });
  }
  wallet.holds = wallet.holds || {};
  if (wallet.holds[key] != null) return { held: wallet.holds[key], key, replayed: true }; // idempotent re-reserve
  if (spendable(wallet) < hold) {
    throw new GatewayError(`Insufficient paid ACU: need ${hold}, have ${spendable(wallet)}. Welcome ACUs are read-only.`, {
      status: 402, code: 'insufficient_acu', platformCode: 4001,
    });
  }
  wallet.held = (wallet.held || 0) + hold;
  wallet.holds[key] = hold;
  persist();
  return { held: hold, key };
}

// Convert a hold into a real debit of `actual` (clamped to the hold), releasing
// any unused remainder back to the spendable balance. Idempotent: once the hold
// is gone, a repeat call is a no-op. One clean ledger line per settled action.
export function settleHold({ user, key, actual, label, action, bracketFactor, referenceId }) {
  const wallet = requireUser(user);
  const hold = wallet.holds && wallet.holds[key];
  if (hold == null) return { charged: 0, settled: false, wallet: view(wallet) };
  const cost = Math.min(Math.max(0, Math.floor(Number(actual) || 0)), hold);
  const bf = Number.isFinite(Number(bracketFactor)) && Number(bracketFactor) >= 1 ? Number(bracketFactor) : 1;
  wallet.held -= hold;
  delete wallet.holds[key];
  wallet.paid -= cost;
  ledger(wallet, `OPERATIONAL_TASK · ${String(label || 'action').slice(0, 120)}`, -cost, {
    type: action ? `debit_${String(action).slice(0, 40)}` : 'debit_action',
    pool: 'paid', bracketFactor: bf,
    ...(referenceId ? { referenceId: String(referenceId).slice(0, 64) } : {}),
  });
  persist();
  return { charged: cost, settled: true, wallet: view(wallet) };
}

// Cancel a hold without charging (generation failed, client vanished, malformed
// output). The reserved funds return to spendable; the user is not billed.
export function releaseHold({ user, key }) {
  const wallet = store.wallets[user];
  if (!wallet || !wallet.holds || wallet.holds[key] == null) return { released: 0 };
  const hold = wallet.holds[key];
  wallet.held -= hold;
  delete wallet.holds[key];
  persist();
  return { released: hold, wallet: view(wallet) };
}

// Admin comp: credit an arbitrary amount of USABLE (paid-pool) ACUs to a user.
// Gated by the admin key at the route — never client-initiable. Recorded as a
// distinct ADMIN_GRANT entry so comped value stays auditable and separable
// from real purchases. Paid pool (not free) because only paid ACUs fund AI.
export function grant({ user, amount, reason, idempotencyKey }) {
  const wallet = requireUser(user);
  const acus = Math.floor(Number(amount));
  if (!Number.isFinite(acus) || acus <= 0) {
    throw new GatewayError('"amount" must be a positive integer of ACUs.', { status: 400, code: 'invalid_amount' });
  }
  return idempotent(idempotencyKey, () => {
    wallet.paid += acus;
    ledger(wallet, `ADMIN_GRANT · ${String(reason || 'Comped ACU').slice(0, 100)}`, acus, {
      type: 'credit_grant',
      pool: 'paid',
      bracketFactor: 1,
    });
    persist();
    return { granted: acus, wallet: view(wallet) };
  });
}

export function credit({ user, packageId, idempotencyKey }) {
  const wallet = requireUser(user);
  const pkg = PACKAGES[packageId];
  if (!pkg) {
    throw new GatewayError(`Unknown package "${packageId}".`, { status: 400, code: 'unknown_package' });
  }
  return idempotent(idempotencyKey, () => {
    const total = pkg.acus + pkg.bonus;
    wallet.paid += total;
    ledger(wallet, `TOP-UP · ${pkg.name} (£${pkg.priceGBP} = ${total.toLocaleString('en-US')} ACU)`, total, {
      type: 'credit_purchase',
      pool: 'paid',
      bracketFactor: 1,
    });
    persist();
    return { credited: total, package: packageId, wallet: view(wallet) };
  });
}

// Credit a subscription plan's monthly ACU allotment to the paid pool and stamp
// the active plan on the wallet. Idempotent per billing event (the Stripe invoice
// id is the key), so a webhook replay never double-credits a cycle. Called for
// both the first invoice and every renewal.
export function creditPlanAllotment({ user, planId, idempotencyKey }) {
  const wallet = requireUser(user);
  const plan = PLANS[planId];
  if (!plan || !plan.acusPerMonth) {
    throw new GatewayError(`Unknown or non-crediting plan "${planId}".`, { status: 400, code: 'unknown_plan' });
  }
  return idempotent(idempotencyKey, () => {
    wallet.paid += plan.acusPerMonth;
    wallet.plan = { id: planId, status: 'active', since: (wallet.plan && wallet.plan.since) || Date.now(), renewedAt: Date.now() };
    ledger(wallet, `SUBSCRIPTION · ${plan.name} (£${plan.priceGBP}/mo = ${plan.acusPerMonth.toLocaleString('en-US')} ACU)`, plan.acusPerMonth, {
      type: 'credit_subscription',
      pool: 'paid',
      bracketFactor: 1,
    });
    persist();
    return { credited: plan.acusPerMonth, plan: planId, wallet: view(wallet) };
  });
}

// Reverse a prior credit when the money behind it is taken back — a Stripe
// refund, a card chargeback/dispute, or a KODA reversal. We debit the ACUs we
// granted, but a wallet can never go negative, so we claw back only what is
// still there: `clawedBack` is what we recovered, `shortfall` is the value the
// user already spent and we cannot recover (a real, recorded loss — surfaced so
// finance/anti-fraud can see it, not hidden). Idempotent on the settlement id so
// a webhook replay never double-claws. Optionally freezes the wallet so a
// disputing/refunded account cannot immediately spend a fresh top-up while the
// case is open.
export function clawback({ user, amount, reason, idempotencyKey, freeze = false, referenceId }) {
  const wallet = requireUser(user);
  const want = Math.floor(Number(amount));
  if (!Number.isFinite(want) || want <= 0) {
    throw new GatewayError('"amount" must be a positive integer of ACUs.', { status: 400, code: 'invalid_amount' });
  }
  return idempotent(idempotencyKey, () => {
    const recovered = Math.min(wallet.paid, want);
    const shortfall = want - recovered;
    wallet.paid -= recovered;
    // A dispute can land while a generation holds funds; never let held exceed
    // what's actually owned, or a later settle would drive paid negative.
    if ((wallet.held || 0) > wallet.paid) wallet.held = wallet.paid;
    if (freeze) wallet.frozen = true;
    ledger(wallet, `REVERSAL · ${String(reason || 'Refund/chargeback').slice(0, 100)}${shortfall ? ` (recovered ${recovered}/${want}; ${shortfall} already spent)` : ''}`, -recovered, {
      type: 'debit_reversal',
      pool: 'paid',
      bracketFactor: 1,
      reversalRequested: want,
      shortfall,
      ...(freeze ? { frozen: true } : {}),
      ...(referenceId ? { referenceId: String(referenceId).slice(0, 64) } : {}),
    });
    persist();
    return { clawedBack: recovered, shortfall, frozen: Boolean(wallet.frozen), wallet: view(wallet) };
  });
}

// Is this wallet frozen (open dispute / refunded)? Spending paths consult this
// so a bad actor can't refund-then-spend a fresh top-up mid-dispute.
export function isFrozen(user) {
  const w = store.wallets[user];
  return Boolean(w && w.frozen);
}

// Lift a freeze (admin action once a dispute resolves in our favour).
export function unfreeze(user) {
  const w = store.wallets[user];
  if (w && w.frozen) { delete w.frozen; persist(); return true; }
  return false;
}

// Mark a wallet's subscription ended (on Stripe cancellation/deletion). Already-
// credited ACUs are kept (they were paid for); only the plan status changes.
export function endPlan({ user }) {
  const wallet = store.wallets[user];
  if (!wallet || !wallet.plan) return { ended: false };
  wallet.plan = { ...wallet.plan, status: 'canceled', canceledAt: Date.now() };
  persist();
  return { ended: true, wallet: view(wallet) };
}

// Move a guest (anonymous) wallet's PAID balance into an account wallet on first
// login/signup, so ACU bought before signing in isn't stranded. Only the paid
// pool moves — welcome (free) ACUs are per-identity and read-only, so migrating
// them would let one person farm multiple welcome grants. Naturally idempotent:
// the source is zeroed, so a repeat move transfers 0. The source is read from
// the live store WITHOUT minting, so a bogus/empty `from` has no side effect.
export function migratePaid({ from, to }) {
  if (!from || !to || from === to) {
    return { moved: 0, wallet: to ? view(requireUser(to)) : null };
  }
  const src = store.wallets[from]; // live object (peekWallet returns a copy)
  if (!src || src.paid <= 0) {
    return { moved: 0, wallet: view(requireUser(to)) };
  }
  // One-time claim: a guest wallet can only ever be absorbed into ONE account.
  // The source is zeroed below (so a re-run moves 0 regardless), but recording
  // the claimer refuses a second account outright and leaves an audit trail —
  // guest ids are bearer capabilities, and this bounds what a leaked id can do.
  if (src.claimedBy && src.claimedBy !== to) {
    throw new GatewayError('This guest balance has already been claimed by another account.', { status: 409, code: 'already_claimed' });
  }
  const dst = requireUser(to);
  const moved = src.paid;
  src.paid = 0;
  src.claimedBy = to;
  dst.paid += moved;
  ledger(src, 'MIGRATED_OUT · balance moved to account', -moved, { type: 'debit_migrate', pool: 'paid', bracketFactor: 1 });
  ledger(dst, `MIGRATED_IN · from guest wallet ${String(from).slice(0, 12)}…`, moved, { type: 'credit_migrate', pool: 'paid', bracketFactor: 1 });
  persist();
  return { moved, wallet: view(dst) };
}
