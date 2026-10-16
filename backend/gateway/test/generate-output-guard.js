// OUTPUT-GUARD test — proves the "money spent, nothing produced" incident is
// closed. A structured (jsonSchema) /v1/generate whose output comes back
// truncated/unusable must NOT bill the wallet:
//   G1  server-side structuredUsable() accepts real JSON, rejects truncated/empty
//   G2  a truncated first attempt is RETRIED at the full budget and, if the retry
//       is usable, billed exactly once (the user gets their result)
//   G3  an output that stays unusable even after the retry is NOT charged —
//       the hold is released and the call returns 503 generation_incomplete
//   G4  the regression itself: a complete structured result still bills normally
// Run: node test/generate-output-guard.js   (exits non-zero on any failure)
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18821';
process.env.WALLET_STORE = '/tmp/outguard-wallets.json';
process.env.WALLET_STORE_KEY = 'ef'.repeat(32);
process.env.AUTH_STORE = '/tmp/outguard-auth.json';
process.env.REFERRALS_STORE = '/tmp/outguard-referrals.json';
process.env.DOCS_STORE = '/tmp/outguard-docs.json';
process.env.LEADS_STORE = '/tmp/outguard-leads.jsonl';
process.env.ADMIN_API_KEY = 'adm_outguard';
for (const f of [process.env.WALLET_STORE, process.env.AUTH_STORE, process.env.REFERRALS_STORE, process.env.DOCS_STORE]) { try { fs.unlinkSync(f); } catch {} }

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

const srv = await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const wallet = async (user) => (await fetch(`${BASE}/v1/wallet?user=${encodeURIComponent(user)}`)).json();
const admin = { 'x-admin-key': process.env.ADMIN_API_KEY };

// A real-shaped discovery schema whose full JSON is well over 1KB, so a tiny
// maxTokens truncates it mid-object (exactly the production failure mode).
const SCHEMA = {
  type: 'object',
  properties: {
    niches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' }, sector: { type: 'string' }, city: { type: 'string' },
          thesis: { type: 'string' }, demand: { type: 'string' }, moat: { type: 'string' },
          score: { type: 'integer' },
        },
      },
    },
  },
};

// ───────────────────────── G1: the server-side validator ─────────────────────────
console.log('— G1: structuredUsable() accepts real JSON and rejects truncated/empty —');
check('a full niches object is usable', srv.structuredUsable('{"niches":[{"title":"X"}]}') === true);
check('a bare non-empty array is usable', srv.structuredUsable('[{"a":1}]') === true);
check('truncated JSON (cut mid-object) is NOT usable', srv.structuredUsable('{"niches":[{"title":"Mock Ven') === false);
check('an empty object is NOT usable', srv.structuredUsable('{}') === false);
check('an empty niches array is NOT usable', srv.structuredUsable('{"niches":[]}') === false);
check('whitespace / empty string is NOT usable', srv.structuredUsable('   ') === false && srv.structuredUsable('') === false);
check('prose-wrapped JSON is still extracted and usable', srv.structuredUsable('Here you go:\n{"niches":[{"t":1}]}\nHope that helps') === true);

// ───────────────────── G2: truncated first attempt is retried then billed ─────────
console.log('— G2: a truncated first attempt is retried at full budget and billed once —');
const U1 = 'op_' + 'outguard0001';
await post('/v1/wallet/credit', { user: U1, amount: 100 }, admin);
const before1 = (await wallet(U1)).paid;
// maxTokens:300 → reservedOut 300 → mock truncates the ~>1KB JSON on attempt #1;
// the gateway retries at the 32000 ceiling, where the full JSON fits → usable.
let res = await post('/v1/generate', { user: U1, jsonSchema: SCHEMA, maxTokens: 300, messages: [{ role: 'user', content: 'discover niches' }] });
let body = await res.json();
const after1 = (await wallet(U1)).paid;
check('retry produced a usable result (200)', res.status === 200, `status=${res.status} ${JSON.stringify(body).slice(0, 160)}`);
check('the returned text parses as usable structured output', srv.structuredUsable(body.text || ''), `textLen=${(body.text || '').length}`);
check('the user WAS charged for the delivered result', before1 - after1 >= 1 && body.charged >= 1, `before=${before1} after=${after1} charged=${body.charged}`);
check('charged exactly once (bounded by the reservation)', before1 - after1 === body.charged, `before=${before1} after=${after1} charged=${body.charged}`);

// ───────────────────── G3: permanently-unusable output is NOT charged ─────────────
console.log('— G3: output that stays unusable even after retry is NOT charged —');
const U2 = 'op_' + 'outguard0002';
await post('/v1/wallet/credit', { user: U2, amount: 100 }, admin);
const before2 = (await wallet(U2)).paid;
// mockText forces a truncated body on BOTH the attempt and the retry → unusable.
res = await post('/v1/generate', { user: U2, jsonSchema: SCHEMA, mockText: '{"niches":[{"title":"half', messages: [{ role: 'user', content: 'discover niches' }] });
body = await res.json();
const after2 = (await wallet(U2)).paid;
check('an unusable result is refused with 503 generation_incomplete', res.status === 503 && body.error === 'generation_incomplete', `status=${res.status} ${JSON.stringify(body)}`);
check('the error is marked retryable so the client can offer "try again"', body.retryable === true, JSON.stringify(body));
check('the wallet was NOT debited for the unusable result (hold released)', after2 === before2, `before=${before2} after=${after2}`);

// ───────────────────── G4: a complete structured result still bills normally ──────
console.log('— G4: regression — a complete structured result bills as before —');
const U3 = 'op_' + 'outguard0003';
await post('/v1/wallet/credit', { user: U3, amount: 100 }, admin);
const before3 = (await wallet(U3)).paid;
// no maxTokens → reservedOut is the 12000 structured default → mock returns the
// full JSON on the first attempt, no retry needed.
res = await post('/v1/generate', { user: U3, jsonSchema: SCHEMA, messages: [{ role: 'user', content: 'discover niches' }] });
body = await res.json();
const after3 = (await wallet(U3)).paid;
check('a complete first attempt succeeds (200)', res.status === 200, `status=${res.status}`);
check('its output is usable', srv.structuredUsable(body.text || ''));
check('it is billed exactly once', before3 - after3 === body.charged && body.charged >= 1, `before=${before3} after=${after3} charged=${body.charged}`);

console.log(failures === 0 ? '\nOUTPUT GUARD: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
