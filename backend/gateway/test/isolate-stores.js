// Test store isolation. Points every persistence path at a per-run temp dir
// UNLESS the test already set it, so a test can never read or write the LIVE
// data/ files (auth, wallets, referrals) when the suite is run from a real
// deployment checkout. Import this FIRST in any test that loads src/server.js:
//   import './isolate-stores.js';
// A test that needs a specific store path or encryption key still sets it after
// this import and wins (these are defaults-only).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-test-'));
const def = (k, v) => { if (!process.env[k]) process.env[k] = v; };

def('WALLET_STORE', path.join(dir, 'wallets.json'));
def('AUTH_STORE', path.join(dir, 'auth.json'));
def('REFERRALS_STORE', path.join(dir, 'referrals.json'));
def('DOCS_STORE', path.join(dir, 'docs.json'));
def('ARTICLES_STORE', path.join(dir, 'articles.json'));
def('LEADS_STORE', path.join(dir, 'leads.jsonl'));
def('AVATAR_STORE', path.join(dir, 'avatars'));
def('SENTINEL_LOG', path.join(dir, 'sentinel.jsonl'));
def('WALLET_DB', path.join(dir, 'wallets.db'));
def('AUTH_DB', path.join(dir, 'auth.db'));
def('REFERRALS_DB', path.join(dir, 'referrals.db'));

export const TEST_STORE_DIR = dir;
