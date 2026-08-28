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
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (!s.articles) s.articles = {};
    if (!s.views) s.views = {};   // slug -> view count (tracks static + published articles)
    return s;
  } catch { return { articles: {}, views: {} }; }
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
    // Monotonic publish sequence: a deterministic tie-breaker so two articles
    // published in the same millisecond still order newest-first, stably.
    seq: existing ? existing.seq : (store.seq = (store.seq || 0) + 1),
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

// Deterministic on-page SEO score (0-100) from measurable signals: title length
// + word count, category present, slug quality, plus the schema + internal/
// external link mesh every article renders. No black box — the same inputs
// always give the same score.
export function seoScore(a) {
  if (!a) return 0;
  const title = String(a.title || '');
  const slug = String(a.slug || '');
  let s = 0;
  const len = title.length;
  if (len >= 35 && len <= 65) s += 30; else if (len >= 25 && len <= 75) s += 20; else if (len > 0) s += 8;
  const words = title.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 4 && words <= 12) s += 15; else if (words > 0) s += 7;
  if (a.category) s += 10;
  const slugWords = slug.split('-').filter(Boolean).length;
  if (slug.length <= 70 && slugWords >= 3 && slugWords <= 9) s += 15; else if (slug) s += 8;
  s += 15; // JSON-LD Article schema (every article renders it)
  s += 15; // internal link mesh + external authority citations
  return Math.min(100, s);
}

function decorate(a) {
  return Object.assign({}, a, { views: store.views[a.slug] || 0, seoScore: seoScore(a) });
}

// Record one view for a slug (static feature articles included). Client throttles
// per session so a reload doesn't inflate the count.
export function recordView(slug) {
  const s = slugify(slug);
  if (!s) return { views: 0 };
  store.views[s] = (store.views[s] || 0) + 1;
  persist();
  return { slug: s, views: store.views[s] };
}

// Public list, newest first, capped — each with live views + SEO score.
export function listArticles(limit = 200) {
  const n = Math.max(1, Math.min(Number(limit) || 200, 500));
  return Object.values(store.articles)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0) || (b.seq || 0) - (a.seq || 0))
    .slice(0, n)
    .map(decorate);
}

export function getArticle(slug) {
  const a = store.articles[slugify(slug)];
  return a ? decorate(a) : null;
}

// Aggregate stats for the admin SEO console. totalViews spans EVERY tracked slug
// (static + published); avgSeo is over the published store.
export function articleStats() {
  const arts = Object.values(store.articles);
  const totalViews = Object.values(store.views).reduce((t, n) => t + (n || 0), 0);
  const avgSeo = arts.length ? Math.round(arts.reduce((t, a) => t + seoScore(a), 0) / arts.length) : 0;
  return { published: arts.length, totalViews, avgSeo };
}
