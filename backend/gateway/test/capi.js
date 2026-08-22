// Meta Conversions API unit test — payload shape, PII hashing, dedup id, test code.
import http from 'node:http';
import crypto from 'node:crypto';

process.env.META_PIXEL_ID = '1322395659736364';
process.env.META_CAPI_TOKEN = 'tok_test';
process.env.META_GRAPH_BASE = 'http://127.0.0.1:18991';
process.env.META_TEST_EVENT_CODE = 'TEST64707';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

let captured = null;
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => { captured = { url: req.url, body: JSON.parse(raw || '{}') }; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
});
await new Promise((r) => srv.listen(18991, r));

const { sendEvent, capiConfigured } = await import('../src/meta-capi.js');

console.log('— config —');
check('capiConfigured() true when token set', capiConfigured() === true);

console.log('— Purchase event —');
const r = await sendEvent({ eventName: 'Purchase', eventId: 'cs_123', email: '  Jane@Example.COM ', value: 10, currency: 'GBP', clientIp: '1.2.3.4', userAgent: 'UA/1', fbp: 'fb.1.p', fbc: 'fb.1.c' });
check('sendEvent reports sent', r.sent === true, JSON.stringify(r));
check('POSTs to /{pixel}/events with token', /\/v\d+\.\d+\/1322395659736364\/events\?access_token=tok_test/.test(captured.url), captured && captured.url);
const ev = captured.body.data[0];
check('event_name is Purchase', ev.event_name === 'Purchase');
check('event_id (dedup) passed', ev.event_id === 'cs_123');
check('action_source website', ev.action_source === 'website');
check('email is SHA-256 of normalised value', ev.user_data.em[0] === crypto.createHash('sha256').update('jane@example.com').digest('hex'), ev.user_data.em[0]);
check('ip + ua + fbp + fbc forwarded', ev.user_data.client_ip_address === '1.2.3.4' && ev.user_data.client_user_agent === 'UA/1' && ev.user_data.fbp === 'fb.1.p' && ev.user_data.fbc === 'fb.1.c');
check('value + currency in custom_data', ev.custom_data.value === 10 && ev.custom_data.currency === 'GBP');
check('test_event_code included', captured.body.test_event_code === 'TEST64707');
check('event_time is unix seconds', typeof ev.event_time === 'number' && ev.event_time > 1e9);

console.log('— no email → no em hash, still sends —');
captured = null;
await sendEvent({ eventName: 'Lead', eventId: 'nfx_1', clientIp: '9.9.9.9' });
check('Lead sent without email', captured && captured.body.data[0].event_name === 'Lead' && !captured.body.data[0].user_data.em);

srv.close();
console.log(failures === 0 ? '\nCAPI: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
