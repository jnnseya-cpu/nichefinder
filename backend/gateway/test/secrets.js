// SECRETS test — admin-managed API key store.
// Proves: admin-only; secrets never returned (masked only); env always wins;
// an admin-set AI key applies LIVE (availableProviders picks it up); the store
// file is ENCRYPTED at rest; unknown keys rejected; clear works.
// Run: node test/secrets.js
import crypto from 'node:crypto';
import fs from 'node:fs';

const D = '/tmp/nf-secrets-test';
fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
// NOTE: MOCK_AI intentionally UNSET so availableProviders reflects real keys.
process.env.PORT = '18844';
process.env.WALLET_STORE_KEY = 'ab'.repeat(32);
process.env.ADMIN_EMAIL = 'root@audit.test';
process.env.ADMIN_PASSWORD = 'RootPass!123';
process.env.STRIPE_SECRET_KEY = 'sk_live_ENVPROVIDED_123'; // an ENV-provided key → must stay authoritative
process.env.SECRETS_STORE = `${D}/secrets.json`;
process.env.WALLET_STORE = `${D}/w.json`; process.env.AUTH_STORE = `${D}/a.json`;
process.env.REFERRALS_STORE = `${D}/r.json`; process.env.DOCS_STORE = `${D}/d.json`;
process.env.LEADS_STORE = `${D}/l.jsonl`; process.env.NEWSLETTER_STATE = `${D}/n.json`;
process.env.SHOWCASE_STORE = `${D}/s.json`; process.env.AVATAR_STORE = `${D}/av`;

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (p, b, h = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
const get = (p, h = {}) => fetch(BASE + p, { headers: h });
function lz(hex) { let b = 0; for (const c of hex) { const v = parseInt(c, 16); if (v === 0) { b += 4; continue; } b += Math.clz32(v) - 28; break; } return b; }
async function proof() { const ch = await (await fetch(BASE + '/v1/human/challenge')).json(); let n = 0; for (;;) { if (lz(crypto.createHash('sha256').update(ch.challenge + n).digest('hex')) >= ch.difficulty) break; n++; } return { challenge: ch.challenge, nonce: String(n) }; }

console.log('— admin auth on the key endpoints —');
let r = await get('/v1/admin/keys');
check('GET /v1/admin/keys without session → 403', r.status === 403, 'got ' + r.status);
r = await post('/v1/admin/keys', { name: 'ANTHROPIC_API_KEY', value: 'x' });
check('POST /v1/admin/keys without session → 403', r.status === 403, 'got ' + r.status);

// admin login (bootstrapped from ADMIN_EMAIL/PASSWORD)
r = await post('/v1/auth/login', { email: 'root@audit.test', password: 'RootPass!123', ...(await proof()) });
const A = await r.json(); const admin = { authorization: 'Bearer ' + A.token };
check('admin login ok (role admin)', r.status === 200 && A.user.role === 'admin', 'status ' + r.status);

console.log('— status is masked, env-provided keys are locked —');
r = await get('/v1/admin/keys', admin); const ks = await r.json();
check('encryption available (WALLET_STORE_KEY set)', ks.encryptionAvailable === true);
const byName = Object.fromEntries(ks.keys.map((k) => [k.name, k]));
check('ANTHROPIC starts unset', byName.ANTHROPIC_API_KEY && byName.ANTHROPIC_API_KEY.set === false);
check('STRIPE_SECRET_KEY shows source=env and locked=true', byName.STRIPE_SECRET_KEY.source === 'env' && byName.STRIPE_SECRET_KEY.locked === true);
check('no raw secret in status (env Stripe value not leaked)', !JSON.stringify(ks).includes('sk_live_ENVPROVIDED_123'), 'LEAK!');
check('Stripe preview is masked (bullets + last-4)', /^•+\w{4}$/.test(byName.STRIPE_SECRET_KEY.preview || ''), byName.STRIPE_SECRET_KEY.preview);

console.log('— setting an AI key applies LIVE —');
r = await get('/v1/health'); let providers = (await r.json()).providers;
check('no AI providers before any key is set', providers.length === 0, JSON.stringify(providers));
r = await post('/v1/admin/keys', { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-LIVEKEY-abcd' }, admin);
const setRes = await r.json();
check('set ANTHROPIC returns ok + masked (no raw value)', r.status === 200 && setRes.ok && !JSON.stringify(setRes).includes('sk-ant-LIVEKEY-abcd'), JSON.stringify(setRes));
check('set ANTHROPIC status: source=admin, set=true', setRes.key.source === 'admin' && setRes.key.set === true);
r = await get('/v1/health'); providers = (await r.json()).providers;
check('claude is now a LIVE provider (no restart)', providers.includes('claude'), JSON.stringify(providers));

console.log('— env still wins for an env-provided key —');
r = await post('/v1/admin/keys', { name: 'STRIPE_SECRET_KEY', value: 'sk_live_ADMIN_OVERRIDE_999' }, admin);
check('admin set of an env-provided key is accepted (stored)', (await r.json()).ok === true);
r = await get('/v1/admin/diag', { 'x-admin-key': 'nope' }); // diag needs admin key; just confirm env Stripe still present via status
r = await get('/v1/admin/keys', admin); const ks2 = Object.fromEntries((await r.json()).keys.map((k) => [k.name, k]));
check('STRIPE still reports source=env (env overrides the stored value)', ks2.STRIPE_SECRET_KEY.source === 'env' && ks2.STRIPE_SECRET_KEY.locked === true);

console.log('— store file is encrypted at rest —');
const raw = fs.readFileSync(process.env.SECRETS_STORE, 'utf8');
check('secrets.json is an NFE1 encrypted envelope', raw.startsWith('NFE1:'), raw.slice(0, 16));
check('plaintext secret is NOT on disk', !raw.includes('sk-ant-LIVEKEY-abcd') && !raw.includes('sk_live_ADMIN_OVERRIDE_999'), 'LEAK ON DISK!');

console.log('— unknown key rejected, clear works —');
r = await post('/v1/admin/keys', { name: 'WALLET_STORE_KEY', value: 'hack' }, admin);
check('cannot manage a non-whitelisted key (WALLET_STORE_KEY) → 400', r.status === 400, 'got ' + r.status);
r = await post('/v1/admin/keys', { name: 'ANTHROPIC_API_KEY', value: '' }, admin);
check('clearing ANTHROPIC (empty value) → unset', (await r.json()).key.set === false);
r = await get('/v1/health'); providers = (await r.json()).providers;
check('claude removed from live providers after clear', !providers.includes('claude'), JSON.stringify(providers));

console.log(failures === 0 ? '\nSECRETS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
