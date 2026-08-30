// DIAG test — the launch-readiness self-diagnosis endpoint. Verifies the
// admin-gated /v1/admin/diag reports provider-key presence, payments/webhook
// config, server clock, and a human-readable problems list — WITHOUT leaking
// secret values — and that it is not public. Run: node test/diag.js
import fs from 'node:fs';

process.env.MOCK_AI = '1';
process.env.PORT = '18821';
process.env.STRIPE_SECRET_KEY = 'sk_test_diag';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_a,whsec_b';
process.env.WALLET_STORE = '/tmp/diag-wallets.json';
process.env.ADMIN_API_KEY = 'adm_diag';
delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY;
try { fs.unlinkSync(process.env.WALLET_STORE); } catch {}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));
const admin = { 'x-admin-key': process.env.ADMIN_API_KEY };

console.log('— diag is admin-gated —');
let res = await fetch(`${BASE}/v1/admin/diag`);
check('diag refuses the public (403)', res.status === 403);

res = await fetch(`${BASE}/v1/admin/diag`, { headers: admin });
const d = await res.json();
check('admin key can read diag (200)', res.status === 200, JSON.stringify(d).slice(0, 120));

console.log('— content is actionable and leaks no secrets —');
check('reports server time for clock-skew checks', typeof d.time?.serverUnix === 'number');
check('payments block reports webhook secret COUNT (2), not values', d.payments?.webhookSecrets === 2);
check('never echoes a secret value', !JSON.stringify(d).includes('whsec_a') && !JSON.stringify(d).includes('sk_test_diag'));
check('payments configured (secret + webhook present)', d.payments?.configured === true && d.payments?.stripeSecretKey === true);
check('reports the exact webhook path to configure in Stripe', d.payments?.webhookPath === '/v1/payments/stripe-webhook');
check('reports the webhook tolerance window', typeof d.payments?.webhookToleranceSec === 'number');

console.log('— generation readiness reflects the (missing) provider keys —');
check('provider-key map present', d.generation && d.generation.providerKeys && 'claude' in d.generation.providerKeys);
check('no real provider key detected', d.generation.providerKeys.claude === false && d.generation.providerKeys.openai === false);
check('under MOCK_AI the active provider is mock', Array.isArray(d.generation.active) && d.generation.active.includes('mock'));

console.log('— problems list surfaces the real gaps —');
check('flags missing SMTP', d.problems.some((p) => /SMTP/i.test(p)));
check('status is attention when something is unconfigured', d.status === 'attention', d.status);

console.log(failures === 0 ? '\nDIAG: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
