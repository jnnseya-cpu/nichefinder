/* ============================================================================
   Niche Finder — admin-managed API key / secret store.

   Lets an administrator set the platform's integration secrets (AI providers,
   Stripe, KODA, SMTP, Search Console, Meta) from the admin console instead of
   editing /etc/nichefinder.env over SSH.

   SECURITY MODEL — deliberately conservative:
   - Secrets are ENCRYPTED AT REST (AES-256-GCM, NFE1 envelope) with the master
     key in WALLET_STORE_KEY (env). Without that key the store is DISABLED
     (set/clear refuse), because a secret store you can't encrypt is worse than
     none. The master key, and the admin credentials that authenticate whoever
     sets these, therefore can NEVER live in here — they bootstrap it.
   - ENV ALWAYS WINS. A key present in the process env (from the env file) is
     authoritative; the admin store only fills keys the env does NOT provide, and
     the UI shows env-provided keys as locked. So this never overrides the more
     isolated env path — it's an additive fallback.
   - Secrets are NEVER returned to any client. Only masked status is exposed.
   - At boot we hydrate process.env from the store BEFORE other modules read it,
     so modules that cache their key at load pick up an admin-set value on the
     next start. AI-provider keys are read dynamically, so they also apply live.
   ============================================================================ */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STORE_PATH = process.env.SECRETS_STORE || path.join(process.cwd(), 'data', 'secrets.json');

// The ONLY secrets an admin may manage here. Bootstrap/security values
// (WALLET_STORE_KEY, ADMIN_*, REQUIRE_WALLET_SESSION, …) are intentionally absent.
export const MANAGED = [
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude) API key', group: 'AI providers', sensitive: true, live: true },
  { name: 'GEMINI_API_KEY', label: 'Google Gemini API key', group: 'AI providers', sensitive: true, live: true },
  { name: 'OPENAI_API_KEY', label: 'OpenAI API key', group: 'AI providers', sensitive: true, live: true },
  { name: 'STRIPE_SECRET_KEY', label: 'Stripe secret key', group: 'Payments — cards (Stripe)', sensitive: true, live: false },
  { name: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret', group: 'Payments — cards (Stripe)', sensitive: true, live: false },
  { name: 'KODA_SECRET_KEY', label: 'KODA secret key', group: 'Payments — mobile money (KODA)', sensitive: true, live: false },
  { name: 'KODA_WEBHOOK_SECRET', label: 'KODA webhook secret', group: 'Payments — mobile money (KODA)', sensitive: true, live: false },
  { name: 'BITRIPAY_SECRET_KEY', label: 'BitriPay secret key', group: 'Payments — BitriPay', sensitive: true, live: false },
  { name: 'BITRIPAY_WEBHOOK_SECRET', label: 'BitriPay webhook secret', group: 'Payments — BitriPay', sensitive: true, live: false },
  { name: 'SMTP_HOST', label: 'SMTP host', group: 'Email (SMTP)', sensitive: false, live: false },
  { name: 'SMTP_PORT', label: 'SMTP port', group: 'Email (SMTP)', sensitive: false, live: false },
  { name: 'SMTP_USER', label: 'SMTP username / address', group: 'Email (SMTP)', sensitive: false, live: false },
  { name: 'SMTP_PASS', label: 'SMTP password', group: 'Email (SMTP)', sensitive: true, live: false },
  { name: 'SMTP_FROM', label: 'From address', group: 'Email (SMTP)', sensitive: false, live: false },
  { name: 'GSC_SITE_URL', label: 'Search Console site URL', group: 'SEO (Google Search Console)', sensitive: false, live: false },
  { name: 'GSC_SA_EMAIL', label: 'Service-account email', group: 'SEO (Google Search Console)', sensitive: false, live: false },
  { name: 'GSC_SA_PRIVATE_KEY', label: 'Service-account private key', group: 'SEO (Google Search Console)', sensitive: true, live: false },
  { name: 'META_PIXEL_ID', label: 'Meta Pixel ID', group: 'Analytics (Meta)', sensitive: false, live: false },
  { name: 'META_CAPI_TOKEN', label: 'Meta Conversions API token', group: 'Analytics (Meta)', sensitive: true, live: false },
];
const BY_NAME = new Map(MANAGED.map((m) => [m.name, m]));

function masterKey() {
  const hex = process.env.WALLET_STORE_KEY || '';
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}
export const encryptionAvailable = () => !!masterKey();

function enc(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `NFE1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function dec(envelope, key) {
  const [magic, ivB64, tagB64, ctB64] = String(envelope).split(':');
  if (magic !== 'NFE1') throw new Error('not an NFE1 envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

// Which managed keys the ENV provided at process start (captured before hydrate),
// so env always wins and we never clobber an env-provided value live.
const envProvided = new Set(MANAGED.filter((m) => present(process.env[m.name])).map((m) => m.name));
const fromAdmin = new Set(); // keys this process put into env from the store
let store = {}; // name -> plaintext value (in-memory; persisted encrypted)

function present(v) { return v != null && String(v).trim() !== ''; }

function load() {
  const key = masterKey();
  if (!key) { store = {}; return; }
  try {
    if (!fs.existsSync(STORE_PATH)) { store = {}; return; }
    const raw = fs.readFileSync(STORE_PATH, 'utf8').trim();
    if (!raw) { store = {}; return; }
    const json = raw.startsWith('NFE1:') ? dec(raw, key) : raw; // tolerate a plaintext file only if ever hand-created
    const parsed = JSON.parse(json);
    store = {};
    for (const [k, v] of Object.entries(parsed)) if (BY_NAME.has(k) && present(v)) store[k] = String(v);
  } catch (e) {
    console.error('[secrets] could not read secret store (wrong key or corrupt):', e.message);
    store = {};
  }
}
function persist() {
  const key = masterKey();
  if (!key) throw new Error('encryption_unavailable');
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, enc(JSON.stringify(store), key), { mode: 0o600 });
}

/* Populate process.env from the store for any managed key the env does NOT
   already provide. Runs once at import, before other modules read their env. */
export function hydrateEnv() {
  if (!masterKey()) return;
  load();
  for (const [name, val] of Object.entries(store)) {
    if (!envProvided.has(name) && !present(process.env[name])) {
      process.env[name] = val;
      fromAdmin.add(name);
    }
  }
}

export function setSecret(name, value) {
  const meta = BY_NAME.get(name);
  if (!meta) { const e = new Error('unknown_key'); e.code = 'unknown_key'; throw e; }
  if (!masterKey()) { const e = new Error('encryption_unavailable'); e.code = 'encryption_unavailable'; throw e; }
  const v = String(value == null ? '' : value);
  if (!v.trim()) return clearSecret(name);
  store[name] = v;
  persist();
  // Live-apply only when env isn't the authoritative source for this key.
  if (!envProvided.has(name)) { process.env[name] = v; fromAdmin.add(name); }
  console.log(`[secrets] admin set ${name} (len=${v.length}) applies${meta.live && !envProvided.has(name) ? ' immediately' : ' on next gateway start'}${envProvided.has(name) ? ' — but ENV currently overrides it' : ''}`);
  return statusFor(name);
}

export function clearSecret(name) {
  if (!BY_NAME.has(name)) { const e = new Error('unknown_key'); e.code = 'unknown_key'; throw e; }
  if (!masterKey()) { const e = new Error('encryption_unavailable'); e.code = 'encryption_unavailable'; throw e; }
  delete store[name];
  persist();
  if (fromAdmin.has(name)) { delete process.env[name]; fromAdmin.delete(name); }
  console.log(`[secrets] admin cleared ${name}`);
  return statusFor(name);
}

function mask(name) {
  const meta = BY_NAME.get(name);
  const val = present(process.env[name]) ? String(process.env[name]) : (store[name] || '');
  if (!present(val)) return '';
  if (!meta.sensitive) return val.length > 80 ? val.slice(0, 80) + '…' : val;
  const last = val.slice(-4);
  return '•'.repeat(Math.min(12, Math.max(4, val.length - 4))) + last;
}

function statusFor(name) {
  const meta = BY_NAME.get(name);
  const source = envProvided.has(name) ? 'env' : (present(store[name]) ? 'admin' : 'none');
  return {
    name: meta.name, label: meta.label, group: meta.group, sensitive: meta.sensitive, live: meta.live,
    set: source !== 'none', source, preview: mask(name),
    locked: envProvided.has(name), // env provides it → UI shows read-only
  };
}

export function statusList() { return MANAGED.map((m) => statusFor(m.name)); }

// Hydrate at import, before the rest of the server's modules load.
hydrateEnv();
