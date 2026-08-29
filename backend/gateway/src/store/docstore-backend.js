// Generic keyed-document store backend (auth, referrals), selected by
// STORE_BACKEND. These stores are nested maps of records ({users:{email:obj},
// sessions:{hash:obj}} / {codes:{}, byCode:{}, …}); rather than a lossy
// relational mapping, each record is stored as a row (collection, key, JSON) —
// durable + transactional, exact shape preserved.
//
//   file   (default) — whole-store synchronous fsync'd atomic write (AES-GCM
//                      envelope when a key is given, matching the flat file).
//   sqlite            — one `docs(collection,key,data_json)` table; persist is a
//                      transactional full-replace. Node >=22 (built-in node:sqlite).
//
// NOTE: node:sqlite has no at-rest encryption. Under STORE_BACKEND=sqlite, the
// AES envelope no longer applies — put the data volume on an encrypted disk
// (LUKS). Passwords are already scrypt-hashed, so the DB holds no plaintext
// secret; this is defence-in-depth, not the only control. (See docs/DB-MIGRATION.md.)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function makeDocStore(opts) {
  return process.env.STORE_BACKEND === 'sqlite' ? sqliteDoc(opts) : fileDoc(opts);
}

function freshShape(defaultStore) {
  const out = {};
  for (const k of Object.keys(defaultStore || {})) out[k] = {};
  return out;
}

/* ── file backend ──────────────────────────────────────────────────────────*/
function fileDoc({ storePath, storeKey, encryptStore, decryptStore, defaultStore }) {
  return {
    load() {
      try {
        const raw = fs.readFileSync(storePath, 'utf8');
        const parsed = raw.startsWith('NFE1:')
          ? (storeKey ? JSON.parse(decryptStore(raw, storeKey)) : (() => { throw new Error('store is encrypted but WALLET_STORE_KEY is not set'); })())
          : JSON.parse(raw);
        return { ...freshShape(defaultStore), ...parsed };
      } catch (err) {
        if (String(err.message).includes('WALLET_STORE_KEY')) throw err; // never silently reset an encrypted store
        return freshShape(defaultStore);
      }
    },
    persist(store) {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      const json = JSON.stringify(store);
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, storeKey ? encryptStore(json, storeKey) : json); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, storePath);
    },
  };
}

/* ── sqlite backend ────────────────────────────────────────────────────────*/
function sqliteDoc({ dbPath, defaultStore }) {
  let DatabaseSync;
  try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); }
  catch (e) { throw new Error('STORE_BACKEND=sqlite needs Node >=22 (built-in node:sqlite): ' + e.message); }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, key TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY (collection, key));');
  const selAll = db.prepare('SELECT collection, key, data_json FROM docs');
  const del = db.prepare('DELETE FROM docs');
  const ins = db.prepare('INSERT INTO docs (collection, key, data_json) VALUES (?,?,?)');

  return {
    load() {
      const out = freshShape(defaultStore);
      for (const r of selAll.all()) {
        (out[r.collection] = out[r.collection] || {})[r.key] = JSON.parse(r.data_json);
      }
      return out;
    },
    persist(store) {
      // Transactional full-replace: small stores, and a single atomic swap means
      // a crash never leaves auth/referrals half-written.
      db.exec('BEGIN');
      try {
        del.run();
        for (const [collection, map] of Object.entries(store)) {
          if (!map || typeof map !== 'object') continue;
          for (const [key, value] of Object.entries(map)) ins.run(collection, key, JSON.stringify(value));
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  };
}
