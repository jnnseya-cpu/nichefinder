// BACKUP + RESTORE round-trip test — "a backup that has never been restored is
// not a backup." Creates a sample data dir, runs the real backup script, then
// the real restore+verify script, and asserts the data comes back intact — both
// plaintext and AES-encrypted. Run: node test/backup.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BACKUP = path.join(ROOT, 'scripts', 'nf-backup.sh');
const RESTORE = path.join(ROOT, 'scripts', 'nf-restore.sh');
const T = '/tmp/nf-backup-test';
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

// Fresh sample data dir mimicking the real stores.
fs.rmSync(T, { recursive: true, force: true });
const DATA = path.join(T, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'wallets.json'), JSON.stringify({ wallets: { op_aaa: { paid: 500 }, op_bbb: { paid: 100 } }, idempotency: {} }));
fs.writeFileSync(path.join(DATA, 'auth.json'), JSON.stringify({ users: { u1: { email: 'a@b.c' } } }));
fs.writeFileSync(path.join(DATA, 'referrals.json'), JSON.stringify({ codes: { op_aaa: 'NF-XXXX' }, byCode: {}, earned: {} }));

const sh = (script, args, env) => execFileSync('bash', [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
const latest = (dir, re) => fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)).sort().pop();

// ---- 1) plaintext round-trip ----
console.log('— plaintext backup + restore —');
const STORE = path.join(T, 'store');
let out = sh(BACKUP, [], { NF_DATA_DIR: DATA, NF_BACKUP_DIR: STORE, NF_BACKUP_KEEP: '5', NF_BACKUP_KEY_FILE: '' });
check('backup ran and reports OK', /OK — backup complete/.test(out), out);
const arch = latest(STORE, /^nf-data-.*\.tar\.gz$/);
check('a .tar.gz archive was produced', Boolean(arch));

const RDIR = path.join(T, 'restore1');
out = sh(RESTORE, [arch, RDIR], {});
check('restore verified the archive', /VERIFIED — backup restores/.test(out), out);
const w = JSON.parse(fs.readFileSync(path.join(RDIR, 'data', 'wallets.json'), 'utf8'));
check('restored wallets match the source (2 wallets, balances intact)', Object.keys(w.wallets).length === 2 && w.wallets.op_aaa.paid === 500, JSON.stringify(w.wallets));

// ---- 2) refuses an empty data dir (guard against overwriting good archives) ----
console.log('— safety guards —');
let threw = false;
try { sh(BACKUP, [], { NF_DATA_DIR: path.join(T, 'nope'), NF_BACKUP_DIR: STORE }); } catch { threw = true; }
check('backup aborts on a missing/empty data dir', threw);

// ---- 3) encrypted round-trip (AES-256, openssl) ----
console.log('— encrypted backup + restore —');
const KEY = path.join(T, 'key'); fs.writeFileSync(KEY, 'super-secret-backup-passphrase\n');
const ESTORE = path.join(T, 'estore');
try {
  out = sh(BACKUP, [], { NF_DATA_DIR: DATA, NF_BACKUP_DIR: ESTORE, NF_BACKUP_KEY_FILE: KEY });
  const enc = latest(ESTORE, /^nf-data-.*\.tar\.gz\.enc$/);
  check('encrypted .enc archive was produced', Boolean(enc), out);
  check('no plaintext archive left behind', !latest(ESTORE, /^nf-data-.*\.tar\.gz$/));
  const EDIR = path.join(T, 'restore2');
  out = sh(RESTORE, [enc, EDIR], { NF_BACKUP_KEY_FILE: KEY });
  check('encrypted restore verified with the key', /VERIFIED — backup restores/.test(out), out);
  const w2 = JSON.parse(fs.readFileSync(path.join(EDIR, 'data', 'wallets.json'), 'utf8'));
  check('decrypted data matches the source', w2.wallets.op_bbb.paid === 100);
  // wrong/absent key must fail, not silently pass
  let encFail = false;
  try { sh(RESTORE, [enc, path.join(T, 'restore3')], { NF_BACKUP_KEY_FILE: '' }); } catch { encFail = true; }
  check('restore of an encrypted archive without the key is refused', encFail);
} catch (e) {
  check('openssl available for encrypted round-trip', false, String(e.message).slice(0, 120));
}

fs.rmSync(T, { recursive: true, force: true });
console.log(failures === 0 ? '\nBACKUP: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
