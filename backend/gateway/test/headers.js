// SECURITY HEADERS test — asserts the hardening headers are present on both API
// and static responses, and that the CSP is the non-breaking framing/base/object
// policy (does not restrict scripts/styles, so the site's inline JS + tags work).
// Run: node test/headers.js
import fs from 'node:fs';
process.env.MOCK_AI = '1';
process.env.PORT = '18824';
process.env.WALLET_STORE = '/tmp/headers-wallets.json';
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

const want = {
  'strict-transport-security': /max-age=\d+/,
  'x-content-type-options': /nosniff/,
  'referrer-policy': /strict-origin/,
  'x-frame-options': /SAMEORIGIN/i,
  'content-security-policy': /frame-ancestors 'self'/,
  'permissions-policy': /camera=\(\)/,
  'cross-origin-opener-policy': /same-origin/,
};

console.log('— API response (/v1/health) carries the security headers —');
let res = await fetch(`${BASE}/v1/health`);
for (const [h, re] of Object.entries(want)) check(`API has ${h}`, re.test(res.headers.get(h) || ''), `got: ${res.headers.get(h)}`);

console.log('— static response (/frontend/index.html) carries them too —');
res = await fetch(`${BASE}/frontend/index.html`);
check('static has HSTS', /max-age/.test(res.headers.get('strict-transport-security') || ''));
check('static has nosniff', /nosniff/.test(res.headers.get('x-content-type-options') || ''));
check('static has the CSP', /frame-ancestors/.test(res.headers.get('content-security-policy') || ''));

console.log('— CSP does NOT restrict scripts/styles (no site breakage) —');
const csp = res.headers.get('content-security-policy') || '';
check('CSP has no script-src/style-src/default-src directive', !/script-src|style-src|default-src/.test(csp), csp);

console.log(failures === 0 ? '\nHEADERS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
