// Durable store for generated documents. Documents cost real ACU to produce, so
// they must not live only in a browser's localStorage (lost on cache clear or in
// a private window). Here they are persisted server-side, keyed by account
// (capability id) + project + document type, and can be listed and re-fetched.
import fs from 'node:fs';
import path from 'node:path';
import { GatewayError } from './errors.js';

const STORE_PATH = process.env.DOCS_STORE || path.join(process.cwd(), 'data', 'documents.json');
const CAP_RE = /^op_[a-z0-9]{10,}$/;

let store = load();
let timer = null;

function load() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { docs: {} }; }
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
    } catch (err) { console.error('[docstore] persist failed:', err.message); }
  }, 50);
}
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(store)); } catch { /* best effort */ }
}

function requireCap(user) {
  if (!CAP_RE.test(String(user || ''))) throw new GatewayError('A valid account id is required.', { status: 403, code: 'invalid_user_id' });
}
const key = (user, project, type) => `${user}|${project}|${type}`;
const clean = (s) => String(s || '').slice(0, 80);

export function saveDoc({ user, project, type, content, version, title }) {
  requireCap(user);
  if (!project || !type) throw new GatewayError('project and type are required.', { status: 400, code: 'bad_request' });
  store.docs[key(user, clean(project), clean(type))] = { content, version: version || 1, title: title || '', ts: Date.now() };
  persist();
  return { saved: true };
}

export function getDoc({ user, project, type }) {
  requireCap(user);
  return store.docs[key(user, clean(project), clean(type))] || null;
}

// All generated document types for one project — lets the client restore its
// "generated / View report" state after a cache clear.
export function listDocs({ user, project }) {
  requireCap(user);
  const prefix = `${user}|${clean(project)}|`;
  return Object.keys(store.docs)
    .filter((k) => k.startsWith(prefix))
    .map((k) => ({ type: k.slice(prefix.length), version: store.docs[k].version, ts: store.docs[k].ts, title: store.docs[k].title }));
}

// Right-to-erasure: remove every stored document belonging to a user (called on
// account deletion). Keys are `${user}|${project}|${type}`, so a `${user}|`
// prefix match finds them all. Returns how many were removed.
export function deleteUserDocs(user) {
  const prefix = `${user}|`;
  let n = 0;
  for (const k of Object.keys(store.docs)) if (k.startsWith(prefix)) { delete store.docs[k]; n++; }
  if (n) persist();
  return n;
}
