// KEEPALIVE test — proves a long generation never leaves the connection idle.
// The gateway commits a 200 and streams harmless whitespace every few seconds
// during the slow model call, so a browser abort or a proxy idle-cut can't kill
// a live generation. The final body is whitespace + JSON, which is still valid
// JSON, so the existing r.json() client parses it unchanged.
//   K1  a slow generation's raw body carries leading whitespace BEFORE the JSON
//   K2  that body still JSON-parses and delivers a usable, billed result
//   K3  /v1/document streams the same way and delivers its content
// Run: node test/keepalive.js   (exits non-zero on any failure)
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18823';
process.env.GEN_HEARTBEAT_MS = '150';   // fire the keepalive fast so the test is quick
process.env.MOCK_DELAY_MS = '600';      // model "takes" 600ms → ~4 heartbeats
process.env.WALLET_STORE = '/tmp/keepalive-wallets.json';
process.env.WALLET_STORE_KEY = 'ab'.repeat(32);
process.env.AUTH_STORE = '/tmp/keepalive-auth.json';
process.env.DOCS_STORE = '/tmp/keepalive-docs.json';
process.env.ADMIN_API_KEY = 'adm_keepalive';
for (const f of [process.env.WALLET_STORE, process.env.AUTH_STORE, process.env.DOCS_STORE]) { try { fs.unlinkSync(f); } catch {} }

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const admin = { 'x-admin-key': process.env.ADMIN_API_KEY };

const SCHEMA = { type: 'object', properties: { niches: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, score: { type: 'integer' } } } } } };

console.log('— K1/K2: a slow /v1/generate streams keepalive then a parseable, billed result —');
const U = 'op_' + 'keepalive001';
await post('/v1/wallet/credit', { user: U, amount: 100 }, admin);
const r = await post('/v1/generate', { user: U, jsonSchema: SCHEMA, messages: [{ role: 'user', content: 'discover niches' }] });
const raw = await r.text(); // read the RAW body to inspect the keepalive bytes
check('response is 200', r.status === 200, `status=${r.status}`);
check('raw body carries leading whitespace (the keepalive) before the JSON', /^\s+\{/.test(raw) || /^\s+\[/.test(raw), `head=${JSON.stringify(raw.slice(0, 12))}`);
let body = null;
try { body = JSON.parse(raw); } catch (e) { /* leave null */ }
check('the whitespace-prefixed body still JSON-parses', body !== null);
check('it delivers a usable result and was billed', !!(body && body.text) && (body.charged >= 1), `charged=${body && body.charged}`);

console.log('— K3: a slow /v1/document streams keepalive then delivers its content —');
const DSCHEMA = { type: 'object', properties: { title: { type: 'string' }, sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' } } } } } };
const U2 = 'op_' + 'keepalive002';
await post('/v1/wallet/credit', { user: U2, amount: 2000 }, admin);
const rd = await post('/v1/document', { user: U2, docType: 'validation', project: 'proj_k', system: 'sys', messages: [{ role: 'user', content: 'make it' }], jsonSchema: DSCHEMA });
const rawd = await rd.text();
check('document response is 200', rd.status === 200, `status=${rd.status}`);
check('document raw body carries the leading keepalive whitespace', /^\s+\{/.test(rawd), `head=${JSON.stringify(rawd.slice(0, 12))}`);
let bd = null; try { bd = JSON.parse(rawd); } catch {}
check('the document body parses and carries content', !!(bd && bd.content), JSON.stringify(bd).slice(0, 120));
check('the document was NOT marked failed', !(bd && bd._failed));

console.log(failures === 0 ? '\nKEEPALIVE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
