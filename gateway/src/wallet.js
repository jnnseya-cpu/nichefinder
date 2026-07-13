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
      ledger: [{ t: 'WELCOME · 100 free read-only ACU', amt: 0, ts: Date.now() }],
      createdAt: Date.now(),
    };
    persist();
  }
  return store.wallets[userId];
}

function ledger(wallet, label, amt) {
  wallet.ledger.unshift({ t: label, amt, ts: Date.now() });
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
export function charge({ user, amount, label, idempotencyKey }) {
  const wallet = requireUser(user);
  const cost = Math.floor(Number(amount));
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new GatewayError('"amount" must be a positive integer of ACUs.', { status: 400, code: 'invalid_amount' });
  }
  return idempotent(idempotencyKey, () => {
    if (wallet.paid < cost) {
      throw new GatewayError(`Insufficient paid ACU: need ${cost}, have ${wallet.paid}. Welcome ACUs are read-only.`, {
        status: 402,
        code: 'insufficient_acu',
      });
    }
    wallet.paid -= cost;
    ledger(wallet, `OPERATIONAL_TASK · ${String(label || 'action').slice(0, 120)}`, -cost);
    persist();
    return { charged: cost, wallet: view(wallet) };
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
    ledger(wallet, `TOP-UP · ${pkg.name} (£${pkg.priceGBP} = ${total.toLocaleString('en-US')} ACU)`, total);
    persist();
    return { credited: total, package: packageId, wallet: view(wallet) };
  });
}
