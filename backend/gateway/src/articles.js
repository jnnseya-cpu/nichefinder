// Durable store for admin/autopilot-published blog articles. Previously the SEO
// console published to the operator's localStorage only, so "published" posts
// were visible in exactly one browser and never reached real visitors. Here they
// live server-side and are served to everyone by blog.html + article.html.
// Bodies are rendered client-side (same seeded engine as the static catalogue);
// this store holds the article's identity + metadata.
import fs from 'node:fs';
import path from 'node:path';
import { GatewayError } from './errors.js';

const STORE_PATH = process.env.ARTICLES_STORE || path.join(process.cwd(), 'data', 'articles.json');
const MAX = 2000; // hard cap on stored articles

let store = load();
let timer = null;

function load() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { articles: {} }; }
}
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_PATH);
    } catch (err) { console.error('[articles] persist failed:', err.message); }
  }, 50);
}
export function flushArticles() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(store)); } catch { /* best effort */ }
}

export function slugify(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}
const clean = (s, n = 160) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, n);

// Create or update a published article. `slug` is derived from the title unless
// given. Idempotent on slug (re-publishing the same title updates in place).
export function publishArticle({ title, category, format, slug, auto }) {
  const t = clean(title, 160);
  if (!t) throw new GatewayError('An article title is required.', { status: 400, code: 'bad_request' });
  const s = slugify(slug || t);
  if (!s) throw new GatewayError('Could not derive a slug from the title.', { status: 400, code: 'bad_slug' });
  const existing = store.articles[s];
  if (!existing && Object.keys(store.articles).length >= MAX) {
    throw new GatewayError('Article store is full.', { status: 507, code: 'store_full' });
  }
  store.articles[s] = {
    slug: s,
    title: t,
    category: clean(category, 40) || 'GUIDE',
    format: clean(format, 40) || 'article',
    auto: !!auto,
    publishedAt: existing ? existing.publishedAt : Date.now(),
    updatedAt: Date.now(),
  };
  persist();
  return store.articles[s];
}

export function unpublishArticle(slug) {
  const s = slugify(slug);
  if (store.articles[s]) { delete store.articles[s]; persist(); return { removed: true, slug: s }; }
  return { removed: false, slug: s };
}

// Public list, newest first, capped.
export function listArticles(limit = 200) {
  const n = Math.max(1, Math.min(Number(limit) || 200, 500));
  return Object.values(store.articles)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, n);
}

export function getArticle(slug) {
  return store.articles[slugify(slug)] || null;
}
