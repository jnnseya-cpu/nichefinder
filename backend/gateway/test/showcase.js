import './isolate-stores.js'; // never touch the live data/ files (must be first)
// SHOWCASE test — the operator-curated real "See the working" example the landing
// auto-pulls. Verifies: public read is null until published, admin can publish a
// validated example, malformed input is rejected, the public read then returns it,
// admin can clear it, and the write is admin-gated. Run: node test/showcase.js
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18833';
process.env.ADMIN_API_KEY = 'adm_showcase';
process.env.SHOWCASE_STORE = '/tmp/showcase-test.json';
process.env.WALLET_STORE = '/tmp/showcase-wallets.json';
try { fs.unlinkSync(process.env.SHOWCASE_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));
const admin = { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_API_KEY };

console.log('— public read is null until published —');
let res = await fetch(`${BASE}/v1/showcase`);
let d = await res.json();
check('GET /v1/showcase is public (200) and null', res.status === 200 && d.showcase === null, JSON.stringify(d));

console.log('— write is admin-gated —');
res = await fetch(`${BASE}/v1/admin/showcase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('publish without admin key refused (403)', res.status === 403);

console.log('— malformed input rejected —');
res = await fetch(`${BASE}/v1/admin/showcase`, { method: 'POST', headers: admin, body: JSON.stringify({ title: 'x' }) });
check('missing rows/result rejected (400)', res.status === 400, `status=${res.status}`);

console.log('— admin publishes a valid example —');
const example = {
  title: 'Cold-chain micro-depots', country: 'DR Congo', metricLabel: 'Year-3 revenue',
  rows: [
    { label: 'Serviceable cooperatives', value: '~1,900', why: 'Within a 40km radius of Kinshasa produce corridors.' },
    { label: 'Adoption by Year 3', value: '12%', why: 'Conservative vs comparable operators.' },
  ],
  result: { label: 'Year-3 revenue', value: '$1.24M', why: 'Reconciles with the 61% margin.' },
  source: 'internal test venture, Sep 2026',
};
res = await fetch(`${BASE}/v1/admin/showcase`, { method: 'POST', headers: admin, body: JSON.stringify(example) });
d = await res.json();
check('publish succeeds (200)', res.status === 200 && d.published === true, JSON.stringify(d).slice(0, 120));
check('published example marked real + normalized', d.showcase && d.showcase.real === true && d.showcase.rows.length === 2);

console.log('— public read now returns the real example —');
d = await (await fetch(`${BASE}/v1/showcase`)).json();
check('public showcase is the published example', d.showcase && d.showcase.title === 'Cold-chain micro-depots' && d.showcase.result.value === '$1.24M', JSON.stringify(d).slice(0, 140));

console.log('— row cap + sanitization —');
res = await fetch(`${BASE}/v1/admin/showcase`, { method: 'POST', headers: admin, body: JSON.stringify({ ...example, rows: new Array(20).fill(example.rows[0]) }) });
d = await res.json();
check('rows are capped at 6', d.showcase && d.showcase.rows.length === 6, `rows=${d.showcase && d.showcase.rows.length}`);

console.log('— admin can clear it —');
res = await fetch(`${BASE}/v1/admin/showcase`, { method: 'DELETE', headers: admin });
check('clear succeeds', res.status === 200);
d = await (await fetch(`${BASE}/v1/showcase`)).json();
check('public read is null again after clear', d.showcase === null);

console.log(failures === 0 ? '\nSHOWCASE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
