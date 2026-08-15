// AUTH + ADMIN test — proves the in-house account system end to end:
//   bot-gated signup (proof-of-work) → login → session (/me) → wrong-password
//   refusal → duplicate-email refusal → admin role via ADMIN_EMAIL →
//   session-gated admin users list + arbitrary ACU grant (non-admin refused) →
//   forgot-password → reset → old password dead / new password works.
// Run: node test/auth.js   (exits non-zero on any failure)
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18890';
process.env.WALLET_STORE = '/tmp/auth-test-wallets.json';
process.env.WALLET_STORE_KEY = 'ab'.repeat(32);
process.env.AUTH_STORE = '/tmp/auth-test-auth.json';
process.env.ADMIN_EMAIL = 'boss@nf.test'; // no ADMIN_PASSWORD → seeded via signup below
for (const f of [process.env.WALLET_STORE, process.env.AUTH_STORE]) { try { fs.unlinkSync(f); } catch {} }

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

// capture the reset link the server logs (no email vendor wired in tests)
let lastResetLink = null;
const origLog = console.log;
console.log = (...args) => { const s = args.join(' '); if (s.includes('reset link:')) lastResetLink = s.split('reset link:')[1].trim(); origLog(...args); };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const getJson = (path, headers = {}) => fetch(BASE + path, { headers });

// solve the same proof-of-work the browser does (leading-zero-bits of the hex digest)
function lzbits(hex) { let bits = 0; for (const ch of hex) { const v = parseInt(ch, 16); if (v === 0) { bits += 4; continue; } bits += Math.clz32(v) - 28; break; } return bits; }
async function humanProof() {
  const ch = await (await fetch(BASE + '/v1/human/challenge')).json();
  let n = 0;
  for (;;) { if (lzbits(crypto.createHash('sha256').update(ch.challenge + n).digest('hex')) >= ch.difficulty) break; n++; }
  return { challenge: ch.challenge, nonce: String(n) };
}

console.log('— signup is bot-gated —');
let res = await post('/v1/auth/signup', { email: 'jane@example.com', password: 'hunter2hunter' });
check('signup without a human proof refused (403 human_required)', res.status === 403 && (await res.json()).error === 'human_required');

console.log('— signup / login / session —');
res = await post('/v1/auth/signup', { email: 'jane@example.com', password: 'hunter2hunter', ...(await humanProof()) });
let jane = await res.json();
check('signup succeeds, returns token + user', res.status === 200 && !!jane.token && jane.user.email === 'jane@example.com' && jane.user.role === 'user', JSON.stringify(jane));
check('signup issues a capability-format userId', /^op_[a-z0-9]{10,}$/.test(jane.user.userId || ''));

res = await post('/v1/auth/signup', { email: 'jane@example.com', password: 'anotherpass1', ...(await humanProof()) });
check('duplicate email refused (409 email_taken)', res.status === 409 && (await res.json()).error === 'email_taken');

res = await post('/v1/auth/login', { email: 'jane@example.com', password: 'wrongwrong' });
check('wrong password refused (401 bad_credentials)', res.status === 401 && (await res.json()).error === 'bad_credentials');

res = await post('/v1/auth/login', { email: 'JANE@example.com', password: 'hunter2hunter' });
let janeLogin = await res.json();
check('login succeeds (email case-insensitive)', res.status === 200 && !!janeLogin.token);

res = await getJson('/v1/auth/me', { authorization: 'Bearer ' + janeLogin.token });
check('GET /me returns the session user', res.status === 200 && (await res.json()).user.email === 'jane@example.com');
res = await getJson('/v1/auth/me');
check('GET /me without token refused (401)', res.status === 401);

console.log('— admin role + session-gated admin API —');
res = await post('/v1/auth/signup', { email: 'boss@nf.test', password: 'adminadmin1', ...(await humanProof()) });
let boss = await res.json();
check('account matching ADMIN_EMAIL gets admin role', res.status === 200 && boss.user.role === 'admin', JSON.stringify(boss.user));

res = await getJson('/v1/admin/users', { authorization: 'Bearer ' + boss.token });
let list = await res.json();
check('admin can list users', res.status === 200 && Array.isArray(list.users) && list.users.length >= 2);

res = await getJson('/v1/admin/users', { authorization: 'Bearer ' + janeLogin.token });
check('non-admin cannot list users (403)', res.status === 403);

console.log('— admin arbitrary ACU grant (by email) —');
res = await post('/v1/admin/grant', { email: 'jane@example.com', amount: 750, reason: 'test comp' }, { authorization: 'Bearer ' + janeLogin.token });
check('non-admin grant refused (403)', res.status === 403);

res = await post('/v1/admin/grant', { email: 'jane@example.com', amount: 750, reason: 'test comp' }, { authorization: 'Bearer ' + boss.token });
let granted = await res.json();
check('admin grants 750 usable ACU to jane', res.status === 200 && granted.granted === 750 && granted.wallet.paid === 750, JSON.stringify(granted));

res = await getJson('/v1/wallet?user=' + jane.user.userId);
check('jane’s wallet reflects the grant (750 paid)', (await res.json()).paid === 750);

console.log('— forgot password → reset → old dead / new works —');
lastResetLink = null;
res = await post('/v1/auth/forgot', { email: 'jane@example.com', ...(await humanProof()) });
check('forgot returns ok (no enumeration)', res.status === 200 && (await res.json()).ok === true);
check('reset link was generated', !!lastResetLink && lastResetLink.includes('token='), String(lastResetLink));
const rtoken = new URL(lastResetLink).searchParams.get('token');

res = await post('/v1/auth/reset', { email: 'jane@example.com', token: rtoken, password: 'brandnewpass9' });
check('reset with valid token succeeds', res.status === 200 && (await res.json()).ok === true);

res = await post('/v1/auth/reset', { email: 'jane@example.com', token: rtoken, password: 'againagain9' });
check('reset token is single-use (second use refused)', res.status === 400 && (await res.json()).error === 'invalid_reset');

res = await post('/v1/auth/login', { email: 'jane@example.com', password: 'hunter2hunter' });
check('old password no longer works after reset (401)', res.status === 401);
res = await post('/v1/auth/login', { email: 'jane@example.com', password: 'brandnewpass9' });
check('new password works', res.status === 200 && !!(await res.json()).token);

console.log('— store encrypted at rest —');
await new Promise((r) => setTimeout(r, 100));
check('auth store on disk is an AES-256-GCM envelope', fs.readFileSync(process.env.AUTH_STORE, 'utf8').startsWith('NFE1:'));

console.log(failures === 0 ? '\nAUTH + ADMIN: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
