// Niche Finder — document-store migration: a flat JSON store (auth.json /
// referrals.json) → its SQLite DB, for the STORE_BACKEND=sqlite cutover. Reads
// the JSON (decrypting an NFE1 envelope with WALLET_STORE_KEY if needed), writes
// every record into the `docs` table via the same document backend the app uses,
// and VERIFIES the record count matches before declaring success. Never mutates
// the JSON source (instant rollback).
//
// CLI:  node scripts/nf-migrate-docstore.mjs <store.json> <out.db> [col1,col2,...]
//       (columns default to auth's {users,sessions}; pass the referrals set for it)
// Requires Node ≥ 22 (built-in node:sqlite).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

function decryptEnvelope(envelope, keyHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex || '')) throw new Error('WALLET_STORE_KEY must be 64 hex chars to decrypt this store');
  const [magic, ivB64, tagB64, ctB64] = envelope.split(':');
  if (magic !== 'NFE1') throw new Error('not an NFE1 envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

export async function migrateDocStore({ storePath, dbPath, defaultStore, keyHex = process.env.WALLET_STORE_KEY }) {
  const raw = fs.readFileSync(storePath, 'utf8');
  const parsed = raw.startsWith('NFE1:') ? JSON.parse(decryptEnvelope(raw, keyHex)) : JSON.parse(raw);
  const store = { ...defaultStore };
  for (const [k, v] of Object.entries(parsed)) store[k] = v;

  // Count source records across the map collections.
  let srcRecords = 0;
  for (const map of Object.values(store)) if (map && typeof map === 'object') srcRecords += Object.keys(map).length;

  process.env.STORE_BACKEND = 'sqlite';
  const { makeDocStore } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'gateway', 'src', 'store', 'docstore-backend.js'));
  const { DatabaseSync } = (await import('node:module')).createRequire(import.meta.url)('node:sqlite');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const pre = new DatabaseSync(dbPath);
  pre.exec('CREATE TABLE IF NOT EXISTS docs (collection TEXT, key TEXT, data_json TEXT, PRIMARY KEY(collection,key));');
  const existing = Number(pre.prepare('SELECT COUNT(*) c FROM docs').get().c);
  pre.close();
  if (existing > 0) throw new Error(`refusing to migrate into a non-empty database: ${dbPath}`);

  const backend = makeDocStore({ storePath, dbPath, defaultStore });
  backend.persist(store); // transactional full write into `docs`

  const db = new DatabaseSync(dbPath);
  const got = Number(db.prepare('SELECT COUNT(*) c FROM docs').get().c);
  db.close();
  if (got !== srcRecords) throw new Error(`verification failed: source records=${srcRecords} db rows=${got}`);
  return { ok: true, records: got };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [storePath, dbPath, cols] = process.argv.slice(2);
  if (!storePath || !dbPath) { console.error('usage: node scripts/nf-migrate-docstore.mjs <store.json> <out.db> [collections]'); process.exit(1); }
  const names = (cols || 'users,sessions').split(',').map((s) => s.trim()).filter(Boolean);
  const defaultStore = Object.fromEntries(names.map((n) => [n, {}]));
  migrateDocStore({ storePath, dbPath, defaultStore })
    .then((r) => console.log('[migrate-doc] OK — verified:', JSON.stringify(r)))
    .catch((e) => { console.error('[migrate-doc] FAILED:', e.message); process.exit(1); });
}
