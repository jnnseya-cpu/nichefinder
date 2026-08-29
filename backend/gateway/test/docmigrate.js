// DOC-STORE MIGRATION test — proves nf-migrate-docstore.mjs moves an auth/
// referrals JSON store into SQLite losslessly (record counts verified), reloads
// intact, refuses a non-empty DB, and handles an encrypted (NFE1) source.
// Skips on Node < 22. Run: node test/docmigrate.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

try { (await import('node:module')).createRequire(import.meta.url)('node:sqlite'); }
catch { console.log('DOC MIGRATION: SKIPPED — node:sqlite unavailable (needs Node ≥ 22). Not a failure.'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { migrateDocStore } = await import(path.join(ROOT, 'scripts', 'nf-migrate-docstore.mjs'));
const T = '/tmp/nf-docmigrate';
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T, { recursive: true });
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

const refDefault = { codes: {}, byCode: {}, links: {}, earned: {}, awarded: {}, awardAmount: {}, reversed: {} };
const refStore = {
  codes: { op_a: 'NF-AAAA', op_b: 'NF-BBBB' },
  byCode: { 'NF-AAAA': 'op_a', 'NF-BBBB': 'op_b' },
  links: { op_b: 'op_a' },
  earned: { op_a: { referrals: ['op_b'], qualified: ['op_b'], acu: 100, gbp: 1 } },
  awarded: { ref_pi_1: true }, awardAmount: { ref_pi_1: 100 }, reversed: {},
};
// 8 records across the collections.
const JSONP = path.join(T, 'referrals.json'); fs.writeFileSync(JSONP, JSON.stringify(refStore));

console.log('— lossless doc-store migration —');
const DB = path.join(T, 'referrals.db');
const r = await migrateDocStore({ storePath: JSONP, dbPath: DB, defaultStore: refDefault });
check('migrated + verified record count', r.ok && r.records === 8, JSON.stringify(r));

process.env.STORE_BACKEND = 'sqlite';
const { makeDocStore } = await import(path.join(ROOT, 'backend', 'gateway', 'src', 'store', 'docstore-backend.js'));
const back = makeDocStore({ storePath: JSONP, dbPath: DB, defaultStore: refDefault }).load();
check('code map reloaded', back.codes.op_a === 'NF-AAAA' && back.byCode['NF-AAAA'] === 'op_a');
check('link + earned reloaded (commission intact)', back.links.op_b === 'op_a' && back.earned.op_a.acu === 100);
check('awarded + awardAmount reloaded (reversal precision intact)', back.awarded.ref_pi_1 === true && back.awardAmount.ref_pi_1 === 100);
check('missing collections default to empty', typeof back.reversed === 'object' && Object.keys(back.reversed).length === 0);

console.log('— safety —');
let refused = false;
try { await migrateDocStore({ storePath: JSONP, dbPath: DB, defaultStore: refDefault }); } catch { refused = true; }
check('refuses a non-empty DB', refused);
check('JSON source untouched (rollback intact)', JSON.parse(fs.readFileSync(JSONP, 'utf8')).earned.op_a.acu === 100);

console.log('— encrypted (NFE1) source —');
const keyHex = 'ab'.repeat(32);
const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
const ct = Buffer.concat([c.update(JSON.stringify(refStore), 'utf8'), c.final()]);
const ENCP = path.join(T, 'referrals.enc.json');
fs.writeFileSync(ENCP, `NFE1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`);
const r2 = await migrateDocStore({ storePath: ENCP, dbPath: path.join(T, 'r2.db'), defaultStore: refDefault, keyHex });
check('encrypted source decrypts + migrates', r2.ok && r2.records === 8, JSON.stringify(r2));

fs.rmSync(T, { recursive: true, force: true });
console.log(failures === 0 ? '\nDOC MIGRATION: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
