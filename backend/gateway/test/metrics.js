// METRICS test — the observability endpoint the watchdog polls. Verifies the
// admin-gated /v1/admin/metrics reports request/error/webhook-failure counters,
// that a forged webhook increments webhookFailures, and that it is not public.
// Run: node test/metrics.js
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18820';
process.env.STRIPE_SECRET_KEY = 'sk_test_metrics';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_metrics';
process.env.WALLET_STORE = '/tmp/metrics-wallets.json';
process.env.WALLET_STORE_KEY = 'cd'.repeat(32);
process.env.ADMIN_API_KEY = 'adm_metrics';
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));
const admin = { 'x-admin-key': process.env.ADMIN_API_KEY };

console.log('— metrics endpoint is admin-gated —');
let res = await fetch(`${BASE}/v1/admin/metrics`);
check('metrics endpoint refuses the public (403)', res.status === 403);
res = await fetch(`${BASE}/v1/admin/metrics`, { headers: admin });
let m = await res.json();
check('admin key can read metrics (200)', res.status === 200 && typeof m.requests === 'number', JSON.stringify(m).slice(0, 120));
check('reports config + counters', typeof m.errorRatePct === 'number' && 'webhookFailures' in m && 'generationFailures' in m, JSON.stringify(m));

console.log('— a forged webhook increments webhookFailures —');
const before = m.webhookFailures;
res = await fetch(`${BASE}/v1/payments/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
check('forged webhook rejected (400)', res.status === 400);
m = await (await fetch(`${BASE}/v1/admin/metrics`, { headers: admin })).json();
check('webhookFailures went up', m.webhookFailures === before + 1, `before=${before} after=${m.webhookFailures}`);

console.log('— request counter advances —');
const r0 = m.requests;
await fetch(`${BASE}/v1/health`);
m = await (await fetch(`${BASE}/v1/admin/metrics`, { headers: admin })).json();
check('requests counter increased', m.requests > r0, `${r0} -> ${m.requests}`);

console.log(failures === 0 ? '\nMETRICS: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
