// AUTH + REFERRALS SQLITE test — proves the document backend runs the real
// auth and referrals modules on SQLite and that accounts, sessions and referral
// awards survive a restart. Skips on Node < 22. Run: node test/auth-referrals-sqlite.js
import fs from 'node:fs';
import { createRequire } from 'node:module';

try { createRequire(import.meta.url)('node:sqlite'); }
catch { console.log('AUTH+REFERRALS SQLITE: SKIPPED — node:sqlite unavailable (needs Node ≥ 22). Not a failure.'); process.exit(0); }

const AUTH_DB = '/tmp/nf-auth.db', REF_DB = '/tmp/nf-referrals.db';
for (const f of [AUTH_DB, `${AUTH_DB}-wal`, `${AUTH_DB}-shm`, REF_DB, `${REF_DB}-wal`, `${REF_DB}-shm`]) { try { fs.unlinkSync(f); } catch {} }
process.env.STORE_BACKEND = 'sqlite';
process.env.AUTH_DB = AUTH_DB;
process.env.REFERRALS_DB = REF_DB;
process.env.AUTH_STORE = '/tmp/nf-auth-unused.json';
process.env.REFERRALS_STORE = '/tmp/nf-referrals-unused.json';
process.env.WALLET_STORE = '/tmp/nf-ar-wallets.json';
process.env.WALLET_DB = '/tmp/nf-ar-money.db';
process.env.WALLET_STORE_KEY = 'cd'.repeat(32);
for (const f of [process.env.WALLET_DB, process.env.WALLET_STORE]) { try { fs.unlinkSync(f); } catch {} }

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

const auth = await import('../src/auth.js');
const ref = await import('../src/referrals.js');

console.log('— auth on sqlite: signup / login / session —');
const s1 = auth.signup({ email: 'Alice@NF.test', password: 'alicepass123' });
check('signup creates an account with an op_ id + token', /^op_[a-z0-9]{10,}$/.test(s1.user.userId) && !!s1.token, JSON.stringify(s1.user));
const ALICE = s1.user.userId;
check('duplicate email is refused', (() => { try { auth.signup({ email: 'alice@nf.test', password: 'x2345678' }); return false; } catch { return true; } })());
const li = auth.login({ email: 'alice@nf.test', password: 'alicepass123' });
check('login succeeds (case-insensitive email)', !!li.token && li.user.userId === ALICE);
check('session resolves to the account', auth.sessionFor(li.token)?.userId === ALICE);
check('resolveUserId maps email → id', auth.resolveUserId('alice@nf.test') === ALICE);

console.log('— referrals on sqlite: code / link / commission —');
const code = ref.codeFor(ALICE);
check('stable invite code issued', /^NF-[A-Z0-9]{8}$/.test(code));
const s2 = auth.signup({ email: 'bob@nf.test', password: 'bobpass1234', ref: code });
const BOB = s2.user.userId;
check('referee linked on signup', ref.summaryFor(ALICE).totalReferrals === 1);
ref.onPaidPurchase({ user: BOB, gbp: 10, purchaseKey: 'pi_ar_1' });
check('commission credited on referee purchase (100 ACU)', ref.summaryFor(ALICE).acuEarned === 100, JSON.stringify(ref.summaryFor(ALICE)));

console.log('— DURABILITY: reload both stores from their DBs (restart) —');
const { makeDocStore } = await import('../src/store/docstore-backend.js');
const authReload = makeDocStore({ storePath: process.env.AUTH_STORE, dbPath: AUTH_DB, defaultStore: { users: {}, sessions: {} } }).load();
check('account survived restart (found by email)', authReload.users['alice@nf.test']?.userId === ALICE, JSON.stringify(Object.keys(authReload.users)));
check('password hash + salt persisted (login still possible)', !!authReload.users['alice@nf.test']?.hash && !!authReload.users['alice@nf.test']?.salt);
check('session survived restart', Object.values(authReload.sessions).some((s) => s.userId === ALICE));
const refReload = makeDocStore({ storePath: process.env.REFERRALS_STORE, dbPath: REF_DB, defaultStore: { codes: {}, byCode: {}, links: {}, earned: {}, awarded: {}, awardAmount: {}, reversed: {} } }).load();
check('referral code survived restart', refReload.codes[ALICE] === code);
check('referral link survived restart', refReload.links[BOB] === ALICE);
check('commission + awarded key survived restart', refReload.earned[ALICE]?.acu === 100 && refReload.awarded['ref_pi_ar_1'] === true, JSON.stringify(refReload.awarded));

console.log(failures === 0 ? '\nAUTH+REFERRALS SQLITE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
