// Google Search Console client test — JWT auth exchange, Search Analytics query,
// per-slug aggregation with impression-weighted position. Mocks Google's token
// and API endpoints; signs with a throwaway RSA key.
import http from 'node:http';
import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.GSC_SITE_URL = 'sc-domain:nichefinderhq.com';
process.env.GSC_SA_EMAIL = 'sa@project.iam.gserviceaccount.com';
process.env.GSC_SA_PRIVATE_KEY = privateKey;
process.env.GSC_TOKEN_URL = 'http://127.0.0.1:19091/token';
process.env.GSC_API_BASE = 'http://127.0.0.1:19091';
process.env.GSC_CACHE_MS = '0';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

let tokenHit = 0, queryBody = null, sawAssertion = false;
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url.indexOf('/token') >= 0) {
      tokenHit++; sawAssertion = /assertion=[\w-]+\.[\w-]+\.[\w-]+/.test(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 })); return;
    }
    queryBody = JSON.parse(raw || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rows: [
      { keys: ['https://nichefinderhq.com/article.html?s=find-a-niche'], clicks: 10, impressions: 100, position: 4.5 },
      { keys: ['https://nichefinderhq.com/article.html?s=find-a-niche'], clicks: 5, impressions: 50, position: 6 },
      { keys: ['https://nichefinderhq.com/'], clicks: 2, impressions: 20, position: 8 },
    ] }));
  });
});
await new Promise((r) => srv.listen(19091, r));

const { getSearchConsole, gscConfigured } = await import('../src/search-console.js');

console.log('— config + auth —');
check('gscConfigured() true when env set', gscConfigured() === true);
const d = await getSearchConsole({ force: true });
check('configured result', d.configured === true, JSON.stringify(d).slice(0, 160));
check('exchanged a signed JWT for a token', tokenHit >= 1 && sawAssertion);

console.log('— query —');
check('uses page dimension + a YYYY-MM-DD date range', queryBody.dimensions[0] === 'page' && /^\d{4}-\d\d-\d\d$/.test(queryBody.startDate) && /^\d{4}-\d\d-\d\d$/.test(queryBody.endDate));

console.log('— aggregation —');
const a = d.bySlug['find-a-niche'];
check('two rows merged for the slug', a && a.impressions === 150 && a.clicks === 15, JSON.stringify(a));
check('impression-weighted position', a && a.position === Number(((4.5 * 100 + 6 * 50) / 150).toFixed(1)), a && String(a.position));
check('homepage (no slug) excluded from bySlug', !d.bySlug['']);
check('totals are article-attributable (homepage excluded)', d.totals.impressions === 150 && d.totals.clicks === 15, JSON.stringify(d.totals));

srv.close();
console.log(failures === 0 ? '\nSEARCH CONSOLE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
