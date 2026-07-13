// P0 wallet service: the ACU system of record moves off localStorage and onto
// the server. File-persisted JSON store (swap for Postgres in P1 — the handler
// contract below is the stable surface). Single-process writes are serialized
// through an in-memory queue, so balances never race.
import fs from 'node:fs';
import path from 'node:path';
import { GatewayError } from './errors.js';

const STORE_PATH = process.env.WALLET_STORE || path.join(process.cwd(), 'data', 'wallets.json');
const WELCOME_FREE = 100;
const LEDGER_CAP = 500;

// Mirrors nf-wallet.js — the client displays what the server enforces.
export const PACKAGES = {
  starter_5: { name: 'Starter', priceGBP: 5, acus: 500, bonus: 0 },
  builder_10: { name: 'Builder', priceGBP: 10, acus: 1000, bonus: 100 },
  founder_20: { name: 'Founder', priceGBP: 20, acus: 2000, bonus: 400 },
  investor_50: { name: 'Investor', priceGBP: 50, acus: 5000, bonus: 1500 },
};

let store = load();
let persistTimer = null;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { wallets: {}, idempotency: {} };
  }
}

function persist() {
  // Debounced atomic write: tmp file + rename so a crash never truncates the store.
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_PATH);
  }, 50);
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

function view(wallet) {
  return { paid: wallet.paid, free: wallet.free, total: wallet.paid + wallet.free };
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
    if (keys.length > 5000) delete store.idempotency[keys[0]];
  }
  return { replayed: false, ...result };
}

export function getWallet(userId) {
  return view(requireUser(userId));
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
    if (wallet.paid < cost) {
      // platformCode 4001 = "Insufficient ACUs" in the spec's API error registry (§10.1).
      throw new GatewayError(`Insufficient paid ACU: need ${cost}, have ${wallet.paid}. Welcome ACUs are read-only.`, {
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
