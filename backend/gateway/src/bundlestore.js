// Prepaid bundle credits. A bundle (e.g. the Lender Pack) is charged once at a
// discount, then each of its component documents generates FREE exactly once.
// This tracks, per account+project, how many free generations remain for each
// component type. Consumed on generation; refunded if that generation fails, so
// a user is never charged (or credit-drained) for a document they didn't get.
// Mirrors docstore.js / searchstore.js.
import fs from 'node:fs';
import path from 'node:path';
import { GatewayError } from './errors.js';

const STORE_PATH = process.env.BUNDLES_STORE || path.join(process.cwd(), 'data', 'bundles.json');
const CAP_RE = /^op_[a-z0-9]{10,}$/;
const MAX_PER_COMPONENT = 50; // sanity cap so a credit can't accumulate unbounded

let store = load();
let timer = null;

function load() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { credits: {} }; }
}
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_PATH);
    } catch (err) { console.error('[bundlestore] persist failed:', err.message); }
  }, 50);
}
export function flushBundles() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(store)); } catch { /* best effort */ }
}
export function _resetBundles() { store = { credits: {} }; }

function requireCap(user) {
  if (!CAP_RE.test(String(user || ''))) throw new GatewayError('A valid account id is required.', { status: 403, code: 'invalid_user_id' });
}
const clean = (s) => String(s || '').replace(/\|/g, '_').slice(0, 80);
const key = (user, project) => `${user}|${clean(project)}`;

// Grant one free generation per listed component (idempotency is the caller's
// job — each bundle purchase grants a fresh set; re-buying stacks, capped).
export function grantBundle({ user, project, components }) {
  requireCap(user);
  if (!project) throw new GatewayError('project is required.', { status: 400, code: 'bad_request' });
  if (!Array.isArray(components) || !components.length) throw new GatewayError('components required.', { status: 400, code: 'bad_request' });
  const k = key(user, project);
  const cur = store.credits[k] || {};
  for (const c of components) {
    const t = clean(c);
    cur[t] = Math.min(MAX_PER_COMPONENT, (cur[t] || 0) + 1);
  }
  store.credits[k] = cur;
  persist();
  return { granted: components.length, remaining: { ...cur } };
}

// Consume one free generation for `type`. Returns true if a credit was spent.
export function consumeBundleComponent({ user, project, type }) {
  if (!CAP_RE.test(String(user || '')) || !project) return false;
  const k = key(user, project);
  const cur = store.credits[k];
  const t = clean(type);
  if (!cur || !(cur[t] > 0)) return false;
  cur[t] -= 1;
  if (cur[t] <= 0) delete cur[t];
  if (!Object.keys(cur).length) delete store.credits[k];
  persist();
  return true;
}

// Restore one credit (a consumed component whose generation then failed).
export function refundBundleComponent({ user, project, type }) {
  if (!CAP_RE.test(String(user || '')) || !project) return false;
  const k = key(user, project);
  const cur = store.credits[k] || {};
  const t = clean(type);
  cur[t] = Math.min(MAX_PER_COMPONENT, (cur[t] || 0) + 1);
  store.credits[k] = cur;
  persist();
  return true;
}

export function listBundleCredits({ user, project }) {
  requireCap(user);
  return { ...(store.credits[key(user, project)] || {}) };
}

export function deleteUserBundles(user) {
  const prefix = `${user}|`;
  let n = 0;
  for (const k of Object.keys(store.credits)) if (k.startsWith(prefix)) { delete store.credits[k]; n++; }
  if (n) persist();
  return n;
}
