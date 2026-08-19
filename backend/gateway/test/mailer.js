// MAILER test — verifies the zero-dependency SMTP client speaks a correct
// conversation (EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT) and
// builds a well-formed message. Uses a fake plaintext SMTP server (SMTP_SECURE
// =false), so no TLS certs or network are needed.
import net from 'node:net';

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '18995';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'contact@nichefinderhq.com';
process.env.SMTP_PASS = 's3cret-pass';
process.env.SMTP_FROM = 'Niche Finder <contact@nichefinderhq.com>';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
};

// ---- fake SMTP server: replies with the codes the client expects, records the exchange ----
const seen = { cmds: [], authUser: '', authPass: '', mailFrom: '', rcptTo: '', data: '' };
const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  let inData = false, dataBuf = '', stage = 0;
  sock.write('220 fake.smtp ready\r\n');
  sock.on('data', (chunk) => {
    for (const line of chunk.split('\r\n')) {
      if (line === '' && !inData) continue;
      if (inData) {
        if (line === '.') { inData = false; seen.data = dataBuf; sock.write('250 OK queued\r\n'); }
        else { dataBuf += line + '\r\n'; }
        continue;
      }
      if (stage !== 1 && stage !== 2) seen.cmds.push(line.split(' ')[0].toUpperCase()); // skip base64 auth tokens
      if (/^EHLO/i.test(line)) sock.write('250-fake.smtp\r\n250 AUTH LOGIN\r\n');
      else if (/^AUTH LOGIN/i.test(line)) { stage = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (stage === 1) { seen.authUser = Buffer.from(line, 'base64').toString(); stage = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
      else if (stage === 2) { seen.authPass = Buffer.from(line, 'base64').toString(); stage = 0; sock.write('235 authenticated\r\n'); }
      else if (/^MAIL FROM/i.test(line)) { seen.mailFrom = line; sock.write('250 OK\r\n'); }
      else if (/^RCPT TO/i.test(line)) { seen.rcptTo = line; sock.write('250 OK\r\n'); }
      else if (/^DATA/i.test(line)) { inData = true; sock.write('354 end with .\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
});
await new Promise((r) => server.listen(18995, r));

const { sendMail, buildMessage, mailConfigured } = await import('../src/mailer.js');

console.log('— mailer config —');
check('mailConfigured() true when SMTP_* set', mailConfigured() === true);

console.log('— message construction —');
const msg = buildMessage({ from: 'A <a@x.com>', to: 'b@y.com', subject: 'Hi', text: '.dot line\nsecond', date: 'Fri, 01 Jan 2027 00:00:00 GMT' });
check('has From/To/Subject headers', /From: A <a@x.com>/.test(msg) && /To: b@y.com/.test(msg) && /Subject: Hi/.test(msg));
check('dot-stuffs leading-dot lines', /\r\n\.\.dot line/.test(msg), JSON.stringify(msg));

const mp = buildMessage({ from: 'A <a@x.com>', to: 'b@y.com', subject: 'Hi', text: 'plain body', html: '<b>rich</b>', date: 'Fri, 01 Jan 2027 00:00:00 GMT' });
check('multipart/alternative when text+html both present', /Content-Type: multipart\/alternative; boundary="NFALT_[0-9a-f]+"/.test(mp), mp.slice(0, 300));
check('multipart carries the plain-text part', /Content-Type: text\/plain; charset=utf-8[\s\S]*plain body/.test(mp));
check('multipart carries the html part', /Content-Type: text\/html; charset=utf-8[\s\S]*<b>rich<\/b>/.test(mp));
check('single-part html when only html given', /Content-Type: text\/html; charset=utf-8/.test(buildMessage({ from: 'a@x', to: 'b@y', subject: 's', html: '<i>x</i>' })));

console.log('— full send over SMTP —');
await sendMail({ to: 'jane@example.com', subject: 'Reset your password', html: '<b>hello</b>' });
check('AUTH sent the configured username', seen.authUser === 'contact@nichefinderhq.com', seen.authUser);
check('AUTH sent the configured password', seen.authPass === 's3cret-pass');
check('MAIL FROM is the sender address', /<contact@nichefinderhq\.com>/.test(seen.mailFrom), seen.mailFrom);
check('RCPT TO is the recipient', /<jane@example\.com>/.test(seen.rcptTo), seen.rcptTo);
check('command order EHLO→AUTH→MAIL→RCPT→DATA→QUIT', seen.cmds.join(',').includes('EHLO,AUTH,MAIL,RCPT,DATA') && seen.cmds.includes('QUIT'), seen.cmds.join(','));
check('DATA carried the subject + body', /Subject: Reset your password/.test(seen.data) && /<b>hello<\/b>/.test(seen.data), seen.data);

server.close();
console.log(failures === 0 ? '\nMAILER: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
