// Article store unit test — publish/list/get/unpublish + slug behaviour.
import fs from 'node:fs';
process.env.ARTICLES_STORE = '/tmp/articles-test.json';
try { fs.unlinkSync(process.env.ARTICLES_STORE); } catch {}

const { publishArticle, unpublishArticle, listArticles, getArticle, slugify, seoScore, recordView, articleStats } = await import('../src/articles.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

console.log('— slugify —');
check('slugify normalises', slugify('Hello, World! 2026') === 'hello-world-2026', slugify('Hello, World! 2026'));

console.log('— publish + read —');
const a = publishArticle({ title: 'Finding a Profitable Niche in Nigeria', category: 'STRATEGY', auto: true });
check('publish returns a slug + fields', a.slug === 'finding-a-profitable-niche-in-nigeria' && a.category === 'STRATEGY' && a.auto === true, JSON.stringify(a));
check('getArticle finds it by slug', !!getArticle(a.slug) && getArticle(a.slug).title === a.title);
check('getArticle is slug-tolerant', !!getArticle('Finding a Profitable Niche in Nigeria'));

console.log('— idempotent re-publish (same title) —');
const first = getArticle(a.slug).publishedAt;
const a2 = publishArticle({ title: 'Finding a Profitable Niche in Nigeria', category: 'DISCOVERY' });
check('re-publish updates in place (same slug)', a2.slug === a.slug && a2.category === 'DISCOVERY');
check('publishedAt preserved on update', a2.publishedAt === first);
check('list has exactly one article', listArticles().length === 1, String(listArticles().length));

console.log('— second article + ordering —');
publishArticle({ title: 'The £10k Ceiling Advantage' });
check('list now has two, newest first', listArticles().length === 2 && listArticles()[0].slug === 'the-10k-ceiling-advantage', JSON.stringify(listArticles().map(x => x.slug)));

console.log('— unpublish —');
check('unpublish removes it', unpublishArticle(a.slug).removed === true && !getArticle(a.slug));
check('list back to one', listArticles().length === 1);

console.log('— SEO score —');
const wellFormed = publishArticle({ title: 'How to Validate a Business Niche Before You Spend', category: 'METHOD' });
check('a well-formed article scores high', seoScore(wellFormed) >= 85, String(seoScore(wellFormed)));
check('a weak (short, no category) title scores lower', seoScore({ title: 'Hi', slug: 'hi' }) < seoScore(wellFormed));
check('score is bounded 0-100', seoScore(wellFormed) <= 100 && seoScore({ title: '', slug: '' }) >= 0);
check('listArticles carries seoScore + views', typeof listArticles()[0].seoScore === 'number' && typeof listArticles()[0].views === 'number');

console.log('— view counting —');
const vslug = wellFormed.slug;
check('first view = 1', recordView(vslug).views === 1);
check('second view = 2', recordView(vslug).views === 2);
check('getArticle reflects view count', getArticle(vslug).views === 2);
recordView('a-static-feature-slug'); recordView('a-static-feature-slug');
check('views tracked for non-store (static) slugs too', articleStats().totalViews >= 4, JSON.stringify(articleStats()));
check('articleStats reports published + avgSeo', articleStats().published >= 1 && articleStats().avgSeo > 0);

console.log('— validation —');
let threw = false; try { publishArticle({ title: '' }); } catch { threw = true; }
check('empty title rejected', threw);

console.log(failures === 0 ? '\nARTICLES: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
