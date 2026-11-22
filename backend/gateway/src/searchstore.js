// Durable store for search runs. A search costs real ACU, so its results must
// NOT live only in a browser's localStorage (lost on a cache clear, a new
// device, or navigating away). Here each run's full result list is persisted
// server-side, keyed by account (capability id), and can be listed and
// re-fetched — so a paying customer can always get back what they paid for.
// Mirrors docstore.js.
import fs from 'node:fs';
import path from 'node:path';
import { GatewayError } from './errors.js';

const STORE_PATH = process.env.SEARCHES_STORE || path.join(process.cwd(), 'data', 'searches.json');
const CAP_RE = /^op_[a-z0-9]{10,}$/;
const MAX_PER_USER = 50;     // keep the most recent 50 runs per account
const MAX_NICHES = 25;       // bound a single run's result list
const MAX_RUN_BYTES = 262144; // 256 KiB hard cap on a stored run

let store = load();
let timer = null;

function load() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { runs: {} }; }
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
    } catch (err) { console.error('[searchstore] persist failed:', err.message); }
  }, 50);
}
export function flushSearches() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(store)); } catch { /* best effort */ }
}
// Test-only reset.
export function _resetSearches() { store = { runs: {} }; }

function requireCap(user) {
  if (!CAP_RE.test(String(user || ''))) throw new GatewayError('A valid account id is required.', { status: 403, code: 'invalid_user_id' });
}
const str = (s, n) => String(s == null ? '' : s).slice(0, n);
const newRunId = () => 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Normalise a client-supplied niche into a bounded, safe shape. The content is
// author/AI text that the client renders; we store it as data, never execute it.
function cleanNiche(n) {
  if (!n || typeof n !== 'object') return null;
  const sc = (n.scores && typeof n.scores === 'object') ? n.scores : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    t: str(n.t, 200), m: str(n.m, 300), s: num(n.s), p: str(n.p, 2000),
    scores: {
      prs: num(sc.prs), cs: num(sc.cs), pss: num(sc.pss),
      bps: num(sc.bps), msp: num(sc.msp), ppp: num(sc.ppp),
    },
  };
}

export function saveSearchRun({ user, run }) {
  requireCap(user);
  if (!run || typeof run !== 'object') throw new GatewayError('run is required.', { status: 400, code: 'bad_request' });
  const niches = Array.isArray(run.niches) ? run.niches.slice(0, MAX_NICHES).map(cleanNiche).filter(Boolean) : [];
  if (!niches.length) throw new GatewayError('run.niches must be a non-empty list.', { status: 400, code: 'empty_run' });
  const entry = {
    id: str(run.id, 64) || newRunId(),
    country: str(run.country, 80),
    routing: str(run.routing, 60),
    budget: Number.isFinite(Number(run.budget)) ? Number(run.budget) : null,
    risk: str(run.risk, 40),
    count: niches.length,
    live: !!run.live,
    niches,
    ts: Date.now(),
  };
  if (JSON.stringify(entry).length > MAX_RUN_BYTES) throw new GatewayError('run too large.', { status: 413, code: 'run_too_large' });
  const list = store.runs[user] || [];
  // De-dupe by id (idempotent re-save), newest first, capped.
  const next = [entry, ...list.filter((r) => r.id !== entry.id)].slice(0, MAX_PER_USER);
  store.runs[user] = next;
  persist();
  return { saved: true, id: entry.id };
}

// Light list (no niches) — for the Search History panel on any device.
export function listSearchRuns({ user }) {
  requireCap(user);
  return (store.runs[user] || []).map((r) => ({
    id: r.id, country: r.country, routing: r.routing, budget: r.budget,
    risk: r.risk, count: r.count, live: r.live, ts: r.ts,
  }));
}

// Full run including the niche results — so a run can be re-opened and viewed.
export function getSearchRun({ user, id }) {
  requireCap(user);
  return (store.runs[user] || []).find((r) => r.id === String(id || '')) || null;
}

// Right-to-erasure: drop every stored run for a user (account deletion).
export function deleteUserSearches(user) {
  if (store.runs[user]) { const n = store.runs[user].length; delete store.runs[user]; persist(); return n; }
  return 0;
}
