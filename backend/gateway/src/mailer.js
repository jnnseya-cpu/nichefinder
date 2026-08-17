// Minimal SMTP sender — zero dependencies, in the codebase's hand-rolled style
// (no SDKs, same as the Stripe integration). Speaks just enough SMTP to submit
// a message through the operator's own mail host (e.g. Hostinger). Supports
// implicit TLS (port 465, the default), STARTTLS (587), and a plaintext mode
// used only by the test harness.
//
// Config (all from the environment — no secrets in the repo):
//   SMTP_HOST   e.g. smtp.hostinger.com
//   SMTP_PORT   465 (implicit TLS, default) | 587 (STARTTLS)
//   SMTP_USER   full mailbox that authenticates + sends, e.g. contact@nichefinderhq.com
//   SMTP_PASS   that mailbox's password
//   SMTP_FROM   display From, e.g. "Niche Finder <contact@nichefinderhq.com>" (defaults to SMTP_USER)
//   SMTP_SECURE "false" forces plaintext (tests only); otherwise TLS is used
import tls from 'node:tls';
import net from 'node:net';

const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT || 465);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.SMTP_FROM || USER;
const TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 15000);

export function mailConfigured() {
  return Boolean(HOST && USER && PASS && FROM);
}

// Pull the bare address out of "Name <addr@x>" or "addr@x".
function addr(s) {
  const m = /<([^>]+)>/.exec(String(s));
  return (m ? m[1] : String(s)).trim();
}

// RFC-822 message. Exported for unit testing the header/body construction.
export function buildMessage({ from, to, subject, text, html, date, headers: extra }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date || new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8`,
    'Content-Transfer-Encoding: 8bit',
  ];
  // Optional extra headers (e.g. List-Unsubscribe). Values are single-lined to
  // prevent header injection through a stray CR/LF.
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v == null) continue;
      headers.push(`${k}: ${String(v).replace(/[\r\n]+/g, ' ').trim()}`);
    }
  }
  const body = String(html || text || '');
  // Dot-stuffing: any line beginning with "." must be doubled so it isn't read
  // as the end-of-DATA terminator — including the very first line of the body.
  let safeBody = body.replace(/\r?\n/g, '\r\n').replace(/\r\n\./g, '\r\n..');
  if (safeBody.startsWith('.')) safeBody = '.' + safeBody;
  return headers.join('\r\n') + '\r\n\r\n' + safeBody;
}

// Drive one SMTP conversation over an already-open socket.
function converse(sock, { helo, from, to, message, upgrade }) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let onReply = null;
    let done = false;
    const finish = (err) => { if (done) return; done = true; sock.removeAllListeners('data'); err ? reject(err) : resolve(); };

    sock.setEncoding('utf8');
    sock.setTimeout(TIMEOUT_MS, () => finish(new Error('SMTP timeout')));
    sock.on('error', (e) => finish(e));
    sock.on('data', (chunk) => {
      buf += chunk;
      if (!/\r\n$/.test(buf)) return;
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return; // multi-line reply still in progress
      const code = Number(last.slice(0, 3));
      const text = buf; buf = '';
      const cb = onReply; onReply = null;
      if (cb) cb(code, text);
    });

    const expect = (codes) => new Promise((res, rej) => {
      onReply = (code, text) => (codes.includes(code) ? res({ code, text }) : rej(new Error(`SMTP ${code}: ${text.trim()}`)));
    });
    const send = (line) => sock.write(line + '\r\n');
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

    (async () => {
      try {
        await expect([220]);                         // greeting
        send(`EHLO ${helo}`); await expect([250]);
        if (upgrade) {                               // STARTTLS path
          send('STARTTLS'); await expect([220]);
          sock = await upgrade(sock);
          rewire();                                  // re-bind listeners to the TLS socket
          send(`EHLO ${helo}`); await expect([250]);
        }
        send('AUTH LOGIN'); await expect([334]);
        send(b64(USER)); await expect([334]);
        send(b64(PASS)); await expect([235]);        // authenticated
        send(`MAIL FROM:<${from}>`); await expect([250]);
        send(`RCPT TO:<${to}>`); await expect([250, 251]);
        send('DATA'); await expect([354]);
        sock.write(message + '\r\n.\r\n'); await expect([250]);
        send('QUIT');
        try { await expect([221]); } catch { /* some servers drop before 221 */ }
        finish();
      } catch (e) { try { send('QUIT'); } catch {} finish(e); }
    })();

    // When STARTTLS swaps the socket, move our timeout/error/data wiring across.
    function rewire() {
      sock.setEncoding('utf8');
      sock.setTimeout(TIMEOUT_MS, () => finish(new Error('SMTP timeout')));
      sock.on('error', (e) => finish(e));
      sock.on('data', (chunk) => {
        buf += chunk;
        if (!/\r\n$/.test(buf)) return;
        const lines = buf.split('\r\n').filter(Boolean);
        const last = lines[lines.length - 1] || '';
        if (!/^\d{3} /.test(last)) return;
        const code = Number(last.slice(0, 3));
        const text = buf; buf = '';
        const cb = onReply; onReply = null;
        if (cb) cb(code, text);
      });
    }
  });
}

export async function sendMail({ to, subject, text, html, headers }) {
  if (!mailConfigured()) throw new Error('SMTP not configured');
  const from = addr(FROM);
  const rcpt = addr(to);
  const message = buildMessage({ from: FROM, to, subject, text, html, headers });
  const helo = (FROM.split('@')[1] || 'localhost').replace(/[>]/g, '');
  const plaintext = String(process.env.SMTP_SECURE || '').toLowerCase() === 'false';
  const starttls = !plaintext && PORT === 587;

  let sock;
  if (plaintext || starttls) {
    sock = net.connect({ host: HOST, port: PORT });
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  } else {
    sock = tls.connect({ host: HOST, port: PORT, servername: HOST });
    await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
  }

  const upgrade = starttls
    ? (s) => new Promise((res, rej) => {
        const t = tls.connect({ socket: s, servername: HOST }, () => res(t));
        t.once('error', rej);
      })
    : null;

  try {
    await converse(sock, { helo, from, to: rcpt, message, upgrade });
  } finally {
    try { sock.end(); sock.destroy(); } catch {}
  }
}
