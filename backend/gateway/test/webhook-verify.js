// Stripe webhook signature verification — reason-level diagnosis (live-webhook
// hardening). A rejection must distinguish an AUTHENTIC-but-stale delivery
// (server clock skew → fix NTP) from a genuine secret mismatch (wrong whsec_),
// because the two have completely different fixes. Run: node test/webhook-verify.js
import crypto from 'node:crypto';

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_primary,whsec_secondary';

const { verifySignature, verifySignatureDetailed } = await import('../src/payments.js');

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
const sign = (secret, t) => { const ts = t ?? Math.floor(Date.now() / 1000); return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`; };

// Happy path against either configured secret.
check('valid signature (primary secret) accepted', verifySignature(body, sign('whsec_primary')));
check('valid signature (secondary secret) accepted', verifySignature(body, sign('whsec_secondary')));
check('valid detailed reason is ok', verifySignatureDetailed(body, sign('whsec_primary')).reason === 'ok');

// Wrong secret → signature_mismatch (fix: correct whsec_).
const wrong = verifySignatureDetailed(body, sign('whsec_wrong'));
check('wrong secret → not ok', !wrong.ok);
check('wrong secret → reason signature_mismatch', wrong.reason === 'signature_mismatch', wrong.reason);

// AUTHENTIC signature but timestamp 1 hour old → stale_timestamp (fix: NTP),
// NOT signature_mismatch. This is the clock-skew failure we must name correctly.
const staleTs = Math.floor(Date.now() / 1000) - 3600;
const stale = verifySignatureDetailed(body, sign('whsec_primary', staleTs));
check('authentic-but-stale → not ok', !stale.ok);
check('authentic-but-stale → reason stale_timestamp (clock skew, not bad secret)', stale.reason === 'stale_timestamp', stale.reason);
check('stale reason reports the age', typeof stale.ageSec === 'number' && Math.abs(stale.ageSec) >= 3500);

// Widening the tolerance rescues a stale-but-authentic delivery.
check('a wide tolerance accepts the stale-but-authentic delivery', verifySignature(body, sign('whsec_primary', staleTs), null, 7200));

// Malformed / empty headers.
check('empty header → malformed_header', verifySignatureDetailed(body, '').reason === 'malformed_header');
check('garbage header → malformed_header', verifySignatureDetailed(body, 'not-a-signature').reason === 'malformed_header');
check('forged v1 with current t → signature_mismatch', verifySignatureDetailed(body, `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`).reason === 'signature_mismatch');

console.log(failures === 0 ? '\nWEBHOOK-VERIFY: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
