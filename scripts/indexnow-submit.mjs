#!/usr/bin/env node
// Niche Finder — IndexNow submitter (zero-dependency, Node ESM).
//
// IndexNow instantly notifies Bing, Yandex, Seznam, Naver and other participating
// engines that URLs are new or changed, so they crawl them in hours instead of
// waiting to rediscover them. It does NOT include Google (Google uses its own
// signals + Search Console), but it covers the rest with one call.
//
// HOW IT WORKS
//   1. A key file lives at the site root: https://<host>/<key>.txt containing the
//      key. Engines fetch it to prove you own the domain. This script auto-finds
//      that file in the frontend/ dir — a single source of truth, no duplicated
//      secret. (Override with INDEXNOW_KEY if you host the key elsewhere.)
//   2. It POSTs the changed URLs to https://api.indexnow.org/indexnow.
//
// USAGE
//   node scripts/indexnow-submit.mjs                       # submit the default key pages
//   node scripts/indexnow-submit.mjs what-are-ai-agents.html blog.html
//   node scripts/indexnow-submit.mjs https://nichefinderhq.com/what-are-ai-agents.html
//   NF_SITE_HOST=nichefinderhq.com node scripts/indexnow-submit.mjs --dry-run
//
// Accepts full URLs, root-relative paths, or bare filenames. Robots-disallowed
// pages (admin, dashboard, account, …) are skipped automatically — there is no
// point asking a search engine to index a page you tell it not to.
//
// Exit code is 0 on success and on a soft failure (network/endpoint) so a deploy
// pipeline is never broken by a best-effort ping; pass --strict to exit non-zero.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = (process.env.NF_SITE_HOST || 'nichefinderhq.com').replace(/^https?:\/\//, '').replace(/\/.*/, '');
const ORIGIN = `https://${HOST}`;
const ENDPOINT = process.env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow';
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');

// Kept in sync with frontend/robots.txt Disallow rules — never submit these.
const DISALLOW = new Set([
  'admin.html', 'admin-console.html', 'comms.html', 'dashboard.html', 'project.html',
  'asset.html', 'account.html', 'settings.html', 'growth.html', 'reset.html',
]);

// Pages worth pinging when the script is run with no explicit URLs.
const DEFAULTS = ['', 'what-are-ai-agents.html', 'blog.html', 'how-it-works.html', 'about.html', 'sitemap.xml'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const strict = args.includes('--strict');
const inputs = args.filter((a) => !a.startsWith('--'));

// Locate the key: env override, else the <key>.txt in frontend/ whose contents
// equal its own filename stem (that is exactly the IndexNow key-file contract).
function findKey() {
  if (process.env.INDEXNOW_KEY) return { key: process.env.INDEXNOW_KEY.trim(), keyLocation: process.env.INDEXNOW_KEY_LOCATION || null };
  let files = [];
  try { files = fs.readdirSync(FRONTEND); } catch { return null; }
  for (const f of files) {
    const m = /^([a-f0-9]{8,128})\.txt$/i.exec(f);
    if (!m) continue;
    let body = '';
    try { body = fs.readFileSync(path.join(FRONTEND, f), 'utf8').trim(); } catch { continue; }
    if (body === m[1]) return { key: m[1], keyLocation: `${ORIGIN}/${f}` };
  }
  return null;
}

// Normalise any input (full URL / path / bare filename) to an absolute URL on
// this host, or null if it should be skipped.
function toUrl(x) {
  let u = String(x).trim();
  if (!u) return `${ORIGIN}/`;
  if (/^https?:\/\//i.test(u)) {
    try { const parsed = new URL(u); if (parsed.host !== HOST) return null; u = parsed.pathname.slice(1); }
    catch { return null; }
  }
  u = u.replace(/^\/+/, '').replace(/^frontend\//, '');
  const file = u.split(/[?#]/)[0];
  if (DISALLOW.has(file)) return null;
  return `${ORIGIN}/${u}`;
}

const urlList = [...new Set((inputs.length ? inputs : DEFAULTS).map(toUrl).filter(Boolean))];

if (!urlList.length) { console.error('IndexNow: no submittable URLs (all were skipped).'); process.exit(strict ? 1 : 0); }

const found = findKey();
if (!found) {
  console.error(`IndexNow: no key found. Create frontend/<key>.txt (contents = <key>) or set INDEXNOW_KEY.`);
  process.exit(strict ? 1 : 0);
}
const body = { host: HOST, key: found.key, urlList };
if (found.keyLocation) body.keyLocation = found.keyLocation;

console.log(`IndexNow → ${ENDPOINT}`);
console.log(`  host: ${HOST}  key: ${found.key.slice(0, 6)}…  (${urlList.length} URL${urlList.length > 1 ? 's' : ''})`);
urlList.forEach((u) => console.log(`   • ${u}`));

if (dryRun) { console.log('IndexNow: --dry-run, nothing submitted.'); process.exit(0); }

try {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  // IndexNow: 200 = accepted, 202 = accepted/pending validation. Both are success.
  if (res.status === 200 || res.status === 202) {
    console.log(`IndexNow: submitted OK (HTTP ${res.status}).`);
    process.exit(0);
  }
  const text = await res.text().catch(() => '');
  console.error(`IndexNow: endpoint returned HTTP ${res.status}. ${text.slice(0, 300)}`);
  // 403 usually means the key file isn't live yet at keyLocation — deploy first.
  if (res.status === 403) console.error('  (403 → the key file is not reachable at its URL yet. Deploy the site first, then re-run.)');
  process.exit(strict ? 1 : 0);
} catch (err) {
  console.error(`IndexNow: request failed — ${err && err.message ? err.message : err}`);
  process.exit(strict ? 1 : 0);
}
