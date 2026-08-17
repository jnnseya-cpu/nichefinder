// NEWSLETTER test — pure checks, no email is sent and no live store is touched.
// Verifies the signed unsubscribe token, the weekly edition rotation, and that
// every edition carries its hyperlinks + a personal unsubscribe link. Also
// confirms mailer custom headers (List-Unsubscribe) survive message building.
import os from 'node:os';
import path from 'node:path';

// Point stores at throwaway paths so importing the modules has no side effects.
const tmp = path.join(os.tmpdir(), 'nf-nl-test-' + Date.now());
process.env.AUTH_STORE = tmp + '-auth.json';
process.env.WALLET_STORE = tmp + '-wallet.json';
process.env.NEWSLETTER_STATE = tmp + '-state.json';
process.env.NEWSLETTER_SECRET = 'test-newsletter-secret';
process.env.PUBLIC_ORIGIN = 'https://nichefinderhq.com';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

const { unsubToken, verifyUnsub, buildEditionEmail } = await import('../src/newsletter.js');
const { buildMessage } = await import('../src/mailer.js');

const id = 'op_abcdef123456';

console.log('— unsubscribe token —');
check('token verifies against itself', verifyUnsub(id, unsubToken(id)) === true);
check('token rejects a wrong value', verifyUnsub(id, 'not-the-token') === false);
check('token rejects empty', verifyUnsub(id, '') === false);
check('token is user-specific', unsubToken(id) !== unsubToken('op_zzzzzz999999'));

console.log('— edition content —');
const r = { email: 'ada@example.com', userId: id, name: 'Ada Lovelace' };
const e0 = buildEditionEmail(r, 0);
const e1 = buildEditionEmail(r, 1);
check('edition has a subject', typeof e0.subject === 'string' && e0.subject.length > 10, e0.subject);
check('weekly spotlight rotates', e0.subject !== e1.subject, `${e0.subject} == ${e1.subject}`);
check('html greets by first name', e0.html.includes('Ada'), '');
check('html has the search hyperlink', e0.html.includes('https://nichefinderhq.com/search.html'));
check('html has multiple hyperlinks', (e0.html.match(/href="https:\/\/nichefinderhq\.com/g) || []).length >= 6);
check('html carries a personal unsubscribe link', e0.html.includes('/v1/newsletter/unsubscribe?u=' + id) && e0.html.includes(unsubToken(id)));
check('plain-text alternative present', typeof e0.text === 'string' && e0.text.includes('/search.html') && e0.text.toLowerCase().includes('unsubscribe'));
check('unsubUrl is well-formed', e0.unsubUrl.includes('u=' + id) && e0.unsubUrl.includes('t=' + unsubToken(id)));
// rotation wraps cleanly across the whole cycle
check('rotation is stable across a full cycle', buildEditionEmail(r, 6).subject === e0.subject);

console.log('— mailer custom headers —');
const msg = buildMessage({ from: 'A <a@x.com>', to: 'b@y.com', subject: 'Hi', html: '<b>x</b>', headers: { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
check('List-Unsubscribe header is emitted', /\r\nList-Unsubscribe: <https:\/\/x\/u>\r\n/.test(msg), msg);
check('one-click post header is emitted', /List-Unsubscribe-Post: List-Unsubscribe=One-Click/.test(msg));
check('extra-header injection is neutralised', !/\r\nInjected:/i.test(buildMessage({ from: 'a@x', to: 'b@y', subject: 's', text: 't', headers: { 'X-Test': 'ok\r\nInjected: evil' } })));
// The Subject carries attacker-controlled text (contact-form name) — CRLF in it
// must not be able to inject a Bcc header or split into the body.
check('base-header (subject) injection is neutralised', !/\r\nBcc:/i.test(buildMessage({ from: 'a@x', to: 'b@y', subject: 'New enquiry from Bob\r\nBcc: victim@x', text: 't' })));

console.log(failures === 0 ? '\nNEWSLETTER: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
