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
process.env.LEADS_STORE = '/tmp/auth-test-leads.jsonl';
process.env.SENTINEL_LOG = '/tmp/auth-test-sentinel.jsonl';
process.env.MAINT_FLAG = '/tmp/auth-test-maint.flag';
process.env.AVATAR_STORE = '/tmp/auth-test-avatars';
process.env.ADMIN_EMAIL = 'boss@nf.test'; // no ADMIN_PASSWORD → seeded via signup below
for (const f of [process.env.WALLET_STORE, process.env.AUTH_STORE, process.env.LEADS_STORE, process.env.SENTINEL_LOG, process.env.MAINT_FLAG]) { try { fs.unlinkSync(f); } catch {} }
try { fs.rmSync(process.env.AVATAR_STORE, { recursive: true, force: true }); } catch {}

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

console.log('— admin command centre: overview + deduct + ledger —');
res = await getJson('/v1/admin/overview', { authorization: 'Bearer ' + boss.token });
let ov = await res.json();
check('overview returns KPIs', res.status === 200 && ov.users >= 2 && typeof ov.revenueGBP === 'number' && ov.grantsTotal >= 750, JSON.stringify(ov));
res = await getJson('/v1/admin/overview', { authorization: 'Bearer ' + janeLogin.token });
check('non-admin overview refused (403)', res.status === 403);

res = await post('/v1/admin/deduct', { email: 'jane@example.com', amount: 250, reason: 'correction' }, { authorization: 'Bearer ' + boss.token });
let ded = await res.json();
check('admin deduct removes 250 (jane paid 500)', res.status === 200 && ded.charged === 250 && ded.wallet.paid === 500, JSON.stringify(ded));

res = await getJson('/v1/admin/ledger?user=jane@example.com', { authorization: 'Bearer ' + boss.token });
let led = await res.json();
check('admin ledger returns jane transactions', res.status === 200 && Array.isArray(led.ledger) && led.ledger.length >= 2 && led.email === 'jane@example.com');

console.log('— admin test-email (Comms console send) —');
res = await post('/v1/admin/test-email', { subject: 'Ping', html: '<b>hi</b>' }, { authorization: 'Bearer ' + janeLogin.token });
check('non-admin cannot send a test email (403)', res.status === 403);
res = await post('/v1/admin/test-email', { subject: 'Ping', html: '<b>hi</b>' }, { authorization: 'Bearer ' + boss.token });
check('admin test-email is gated by SMTP config (503 when unconfigured, else 200)', res.status === 503 || res.status === 200, String(res.status));

console.log('— admin article publishing (public SEO store) —');
res = await post('/v1/admin/articles', { title: 'Test SEO Article' }, { authorization: 'Bearer ' + janeLogin.token });
check('non-admin cannot publish an article (403)', res.status === 403);
res = await post('/v1/admin/articles', { title: 'Test SEO Article', category: 'METHOD' }, { authorization: 'Bearer ' + boss.token });
let art = await res.json();
check('admin publishes an article with a slug', res.status === 200 && art.slug === 'test-seo-article', JSON.stringify(art));
res = await getJson('/v1/articles');
let arts = await res.json();
check('public list includes the published article', res.status === 200 && arts.articles.some(function (a) { return a.slug === 'test-seo-article'; }));
res = await getJson('/v1/articles?slug=test-seo-article');
check('public single-article fetch works', res.status === 200 && (await res.json()).title === 'Test SEO Article');
res = await post('/v1/admin/articles/unpublish', { slug: 'test-seo-article' }, { authorization: 'Bearer ' + boss.token });
check('admin can unpublish', res.status === 200 && (await res.json()).removed === true);

console.log('— roles + disable/enable —');
res = await post('/v1/admin/role', { email: 'jane@example.com', role: 'admin' }, { authorization: 'Bearer ' + boss.token });
check('admin can promote jane to admin', res.status === 200 && (await res.json()).role === 'admin');
res = await post('/v1/admin/role', { email: 'jane@example.com', role: 'user' }, { authorization: 'Bearer ' + boss.token });
check('admin can revoke back to user', res.status === 200 && (await res.json()).role === 'user');

res = await post('/v1/admin/disable', { email: 'boss@nf.test', disabled: true }, { authorization: 'Bearer ' + boss.token });
check('admin cannot disable own account (400 self_disable)', res.status === 400 && (await res.json()).error === 'self_disable');
res = await post('/v1/admin/disable', { email: 'jane@example.com', disabled: true }, { authorization: 'Bearer ' + boss.token });
check('admin disables jane', res.status === 200 && (await res.json()).disabled === true);
res = await post('/v1/auth/login', { email: 'jane@example.com', password: 'hunter2hunter' });
check('disabled account cannot log in (403 account_disabled)', res.status === 403 && (await res.json()).error === 'account_disabled');
res = await post('/v1/admin/disable', { email: 'jane@example.com', disabled: false }, { authorization: 'Bearer ' + boss.token });
check('admin re-enables jane', res.status === 200 && (await res.json()).disabled === false);

console.log('— revenue + leads + security + maintenance —');
res = await getJson('/v1/admin/revenue', { authorization: 'Bearer ' + boss.token });
let rev = await res.json();
check('revenue endpoint returns totals + breakdown', res.status === 200 && typeof rev.revenueGBP === 'number' && Array.isArray(rev.byPackage) && Array.isArray(rev.purchases));

await post('/v1/leads', { email: 'lead@example.com', name: 'Lead One', message: 'interested' });
res = await getJson('/v1/admin/leads', { authorization: 'Bearer ' + boss.token });
let lds = await res.json();
check('admin sees the submitted lead', res.status === 200 && lds.leads.some((l) => l.email === 'lead@example.com'));

res = await getJson('/v1/admin/security', { authorization: 'Bearer ' + boss.token });
let sec = await res.json();
check('security endpoint returns log + bans + health', res.status === 200 && Array.isArray(sec.log) && Array.isArray(sec.bans) && Array.isArray(sec.providers));

res = await post('/v1/admin/maintenance', { on: true }, { authorization: 'Bearer ' + boss.token });
check('maintenance can be turned on', res.status === 200 && (await res.json()).maintenance === true);
res = await post('/v1/generate', { user: jane.user.userId, messages: [{ role: 'user', content: 'x' }] });
check('generation blocked during maintenance (503)', res.status === 503 && (await res.json()).error === 'maintenance');
res = await getJson('/v1/health');
check('health reports maintenance', (await res.json()).maintenance === true);
res = await post('/v1/admin/maintenance', { on: false }, { authorization: 'Bearer ' + boss.token });
check('maintenance can be turned off', res.status === 200 && (await res.json()).maintenance === false);

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

console.log('— profile: name + avatar —');
res = await post('/v1/auth/login', { email: 'jane@example.com', password: 'brandnewpass9' });
const janeTok = (await res.json()).token;
res = await post('/v1/auth/profile', { name: 'Jane Doe', company: 'Acme', country: 'UK', bio: 'builder' }, { authorization: 'Bearer ' + janeTok });
check('profile update saves name', res.status === 200 && (await res.json()).user.name === 'Jane Doe');
res = await getJson('/v1/auth/me', { authorization: 'Bearer ' + janeTok });
check('me returns profile name + details', (await res.json()).user.company === 'Acme');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
res = await post('/v1/auth/avatar', { kind: 'avatar', dataUrl: PNG }, { authorization: 'Bearer ' + janeTok });
let av = await res.json();
check('avatar upload stored + returns url', res.status === 200 && /\/v1\/media\?f=/.test(av.url) && !!av.user.avatar, JSON.stringify(av));
res = await getJson(av.url);
check('avatar served back over /v1/media', res.status === 200 && (res.headers.get('content-type') || '').indexOf('image/png') === 0);
res = await post('/v1/auth/avatar', { kind: 'avatar', dataUrl: 'data:text/plain;base64,aGk=' }, { authorization: 'Bearer ' + janeTok });
check('non-image upload refused (400)', res.status === 400);

console.log('— change password —');
res = await post('/v1/auth/password', { currentPassword: 'wrong', newPassword: 'evenNEWer9' }, { authorization: 'Bearer ' + janeTok });
check('wrong current password refused (403)', res.status === 403 && (await res.json()).error === 'bad_current_password');
res = await post('/v1/auth/password', { currentPassword: 'brandnewpass9', newPassword: 'evenNEWer9' }, { authorization: 'Bearer ' + janeTok });
check('password change succeeds', res.status === 200);
res = await post('/v1/auth/login', { email: 'jane@example.com', password: 'evenNEWer9' });
check('login with changed password works', res.status === 200 && !!(await res.json()).token);

console.log('— admin holds no consumer wallet —');
res = await getJson('/v1/admin/users', { authorization: 'Bearer ' + boss.token });
let allUsers = (await res.json()).users;
let adminRow = allUsers.find((u) => u.email === 'boss@nf.test');
let userRow = allUsers.find((u) => u.email === 'jane@example.com');
check('admin row has null wallet (no ACUs)', adminRow && adminRow.wallet === null, JSON.stringify(adminRow && adminRow.wallet));
check('normal user still has a wallet', userRow && userRow.wallet && typeof userRow.wallet.paid === 'number');

console.log('— delete account —');
res = await post('/v1/auth/signup', { email: 'temp@example.com', password: 'temppass123', ...(await humanProof()) });
const tempTok = (await res.json()).token;
res = await post('/v1/auth/delete', { currentPassword: 'nope' }, { authorization: 'Bearer ' + tempTok });
check('delete with wrong password refused (403)', res.status === 403);
res = await post('/v1/auth/delete', { currentPassword: 'temppass123' }, { authorization: 'Bearer ' + tempTok });
check('delete account succeeds', res.status === 200 && (await res.json()).ok === true);
res = await post('/v1/auth/login', { email: 'temp@example.com', password: 'temppass123' });
check('deleted account cannot log in (401)', res.status === 401);

console.log('— store encrypted at rest —');
await new Promise((r) => setTimeout(r, 100));
check('auth store on disk is an AES-256-GCM envelope', fs.readFileSync(process.env.AUTH_STORE, 'utf8').startsWith('NFE1:'));

console.log(failures === 0 ? '\nAUTH + ADMIN: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
