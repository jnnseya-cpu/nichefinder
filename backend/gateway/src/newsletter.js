// Weekly product newsletter — NO new vendor. Reuses the operator's own SMTP
// (mailer.js) and the in-house account store (auth.js). A persisted clock makes
// the cadence survive restarts, and every message carries a one-click, signed
// unsubscribe link (+ List-Unsubscribe header) so the send is CAN-SPAM / PECR /
// GDPR compliant.
//
// Config (all optional — sensible defaults, no secrets in the repo):
//   NEWSLETTER_ENABLED        "false" turns the scheduler off (default on)
//   NEWSLETTER_INTERVAL_DAYS  cadence in days (default 7)
//   NEWSLETTER_SEND_DELAY_MS  pause between recipients, gentle on SMTP (default 1200)
//   NEWSLETTER_STATE          state file path (default data/newsletter.json)
//   NEWSLETTER_SECRET         HMAC key for unsubscribe tokens (falls back to WALLET_STORE_KEY)
//   PUBLIC_ORIGIN             absolute site origin for links (default https://nichefinderhq.com)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayError } from './errors.js';
import { sendMail, mailConfigured } from './mailer.js';
import { listNewsletterRecipients, setNewsletterOptOut, userByEmail } from './auth.js';

const STATE_PATH = process.env.NEWSLETTER_STATE || path.join(process.cwd(), 'data', 'newsletter.json');
const INTERVAL_DAYS = Math.max(1, Number(process.env.NEWSLETTER_INTERVAL_DAYS || 7));
const INTERVAL_MS = INTERVAL_DAYS * 24 * 60 * 60 * 1000;
const ENABLED = String(process.env.NEWSLETTER_ENABLED ?? 'true').toLowerCase() !== 'false';
const SEND_DELAY_MS = Number(process.env.NEWSLETTER_SEND_DELAY_MS || 1200);
const SECRET = process.env.NEWSLETTER_SECRET || process.env.WALLET_STORE_KEY || 'nf-newsletter-default';

const origin = () => (process.env.PUBLIC_ORIGIN || 'https://nichefinderhq.com').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- persisted clock -------------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(next) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { console.error('[newsletter] could not persist state:', e.message); }
}

// ---- signed one-click unsubscribe -----------------------------------------
export function unsubToken(userId) {
  return crypto.createHmac('sha256', SECRET).update('unsub:' + String(userId)).digest('hex').slice(0, 32);
}
export function verifyUnsub(userId, token) {
  const expected = unsubToken(userId);
  const a = Buffer.from(expected);
  let b;
  try { b = Buffer.from(String(token || '')); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function handleUnsubscribe(userId, token) {
  if (!userId || !verifyUnsub(userId, token)) {
    throw new GatewayError('This unsubscribe link is invalid.', { status: 400, code: 'invalid_unsubscribe' });
  }
  return setNewsletterOptOut(userId, true);
}

// ---- content ---------------------------------------------------------------
// A different feature headlines each week (rotates by edition index); the same
// evergreen capability grid sits underneath. Every block links somewhere.
const SPOTLIGHTS = [
  {
    tag: 'DISCOVER',
    title: 'Find a hidden niche in minutes — grounded in your market',
    body: 'Enter your country and budget and the AI Search Canvas returns ranked, buildable opportunities with demand evidence and a deterministic score out of 10. No more guessing what to build.',
    cta: { label: 'Run a search', path: '/search.html' },
  },
  {
    tag: 'BUILD',
    title: 'Turn one opportunity into an investor-ready venture',
    body: 'The Build Hub runs real AI engines on your idea: market validation, a 3-year forecast, a risk heatmap, a full business plan and a pitch deck — each investor-grade and exportable.',
    cta: { label: 'Open the Build Hub', path: '/dashboard.html' },
  },
  {
    tag: 'PROTECT',
    title: 'Every plan now tells you how to protect the idea',
    body: 'Your generated documents include a moat & IP section — first-mover strategy, trade-secret hygiene, and how to defend the idea at both local and international level, so a copycat can’t simply lift it.',
    cta: { label: 'See how it works', path: '/how-it-works.html' },
  },
  {
    tag: 'EARN',
    title: 'Invite founders, earn ACU — the Growth Partner programme',
    body: 'Share your invite link. When someone you refer makes a genuine paid purchase, you earn a commission credited straight to your wallet as ACU. No reward for sign-ups alone — only real usage.',
    cta: { label: 'Get your invite link', path: '/growth.html' },
  },
  {
    tag: 'PAY YOUR WAY',
    title: 'Top up by card or mobile money',
    body: 'Buy ACU with a card via Stripe, or by mobile money via KODA (Orange Money, M-Pesa) — charged in your local currency at the live exchange rate, shown before you confirm.',
    cta: { label: 'Top up your wallet', path: '/dashboard.html' },
  },
  {
    tag: 'EXPORT',
    title: 'Take your model with you — real .xlsx workbooks',
    body: 'Financial models and P&Ls export as proper multi-tab Excel workbooks (assumptions, monthly model, annual summary), plus polished document exports you can hand to an investor.',
    cta: { label: 'Explore your outputs', path: '/dashboard.html' },
  },
];

// Evergreen capability grid — link-rich, "what you can do on the platform".
function featureGrid() {
  const o = origin();
  const rows = [
    ['Deep niche discovery', 'Ranked, scored opportunities inside your budget.', '/search.html'],
    ['Deterministic scoring', 'Market readiness, competitive gap, prospect of success — no black box.', '/how-it-works.html'],
    ['Market validation report', 'Is the demand real and current? Get the evidence.', '/dashboard.html'],
    ['3-year financial forecast', 'Revenue, costs and cashflow, generated for your idea.', '/dashboard.html'],
    ['Risk heatmap', 'Know what could kill it before you commit capital.', '/dashboard.html'],
    ['Business plan & pitch deck', 'Investor-grade documents from your inputs.', '/dashboard.html'],
    ['Growth Partner rewards', 'Earn ACU when your referrals buy.', '/growth.html'],
    ['One account, every device', 'Your wallet, projects and documents follow you.', '/settings.html'],
  ];
  return rows.map(([h, b, p]) =>
    `<tr>
       <td style="padding:10px 0;border-bottom:1px solid #ECEAE3;vertical-align:top">
         <a href="${o}${p}" style="color:#8A6300;text-decoration:none;font-weight:700;font-size:15px">${esc(h)} &rsaquo;</a>
         <div style="color:#5A6472;font-size:13px;margin-top:2px">${esc(b)}</div>
       </td>
     </tr>`).join('');
}

// Build one edition for one recipient. Pure w.r.t. its inputs — exported so the
// test suite can assert the content without sending anything.
export function buildEditionEmail(recipient, editionIndex = 0) {
  const o = origin();
  const spot = SPOTLIGHTS[((editionIndex % SPOTLIGHTS.length) + SPOTLIGHTS.length) % SPOTLIGHTS.length];
  const first = (recipient.name || '').trim().split(/\s+/)[0] || 'there';
  const unsubUrl = `${o}/v1/newsletter/unsubscribe?u=${encodeURIComponent(recipient.userId)}&t=${unsubToken(recipient.userId)}`;
  const btn = (label, href) =>
    `<a href="${href}" style="display:inline-block;background:#E8A61A;color:#241A02;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px">${esc(label)}</a>`;

  const subject = `${spot.title} — this week on Niche Finder`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F4F2EC">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(spot.body).slice(0, 100)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EC">
   <tr><td align="center" style="padding:22px 14px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:14px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <!-- header -->
      <tr><td style="background:#0B1220;padding:22px 28px">
        <a href="${o}/" style="color:#EAE5D9;text-decoration:none;font-size:20px;font-weight:700;letter-spacing:.2px">Niche<span style="color:#E8A61A">Finder</span></a>
        <div style="color:#8B93A5;font-size:12px;letter-spacing:.18em;text-transform:uppercase;margin-top:4px">The venture-creation OS</div>
      </td></tr>

      <!-- spotlight -->
      <tr><td style="padding:28px 28px 6px">
        <div style="color:#B98700;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase">${esc(spot.tag)} · this week</div>
        <h1 style="margin:8px 0 6px;color:#0B1220;font-size:23px;line-height:1.25">${esc(spot.title)}</h1>
        <p style="margin:0 0 18px;color:#3D4657;font-size:15px;line-height:1.6">Hi ${esc(first)}, ${esc(spot.body)}</p>
        ${btn(spot.cta.label, o + spot.cta.path)}
      </td></tr>

      <!-- everything you can do -->
      <tr><td style="padding:26px 28px 6px">
        <div style="color:#0B1220;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-top:1px solid #ECEAE3;padding-top:20px">Everything you can do with your account</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">${featureGrid()}</table>
      </td></tr>

      <!-- economics nudge -->
      <tr><td style="padding:14px 28px 8px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF6EA;border:1px solid #F0E4C4;border-radius:10px">
          <tr><td style="padding:16px 18px">
            <div style="color:#0B1220;font-weight:700;font-size:15px">£1 = 100 ACU · pay per outcome</div>
            <div style="color:#5A6472;font-size:13px;margin:4px 0 12px">Free welcome credits to look around; paid ACU to build. Prices are shown before every action — no surprises.</div>
            <a href="${o}/how-it-works.html" style="color:#8A6300;font-weight:700;text-decoration:none;font-size:14px">See pricing &amp; how it works &rsaquo;</a>
          </td></tr>
        </table>
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:18px 28px 30px">
        ${btn('Start your next search', o + '/search.html')}
        <div style="margin-top:12px"><a href="${o}/dashboard.html" style="color:#8A6300;text-decoration:none;font-size:14px;font-weight:600">Or open your Command Center &rsaquo;</a></div>
      </td></tr>

      <!-- footer -->
      <tr><td style="background:#0B1220;padding:20px 28px">
        <div style="color:#8B93A5;font-size:12px;line-height:1.6">
          You’re receiving this because you have a Niche Finder account.<br>
          <a href="${o}/how-it-works.html" style="color:#B9C0CC;text-decoration:underline">How it works</a> ·
          <a href="${o}/blog.html" style="color:#B9C0CC;text-decoration:underline">Blog</a> ·
          <a href="${o}/settings.html" style="color:#B9C0CC;text-decoration:underline">Your account</a> ·
          <a href="${o}/contact.html" style="color:#B9C0CC;text-decoration:underline">Contact</a>
        </div>
        <div style="color:#6A7382;font-size:11px;margin-top:12px">
          Niche Finder Ltd · <a href="${unsubUrl}" style="color:#9AA3B2;text-decoration:underline">Unsubscribe from these emails</a>
        </div>
      </td></tr>
    </table>
   </td></tr>
  </table>
  </body></html>`;

  const text = [
    `${spot.title}`,
    '',
    `Hi ${first}, ${spot.body}`,
    `${spot.cta.label}: ${o}${spot.cta.path}`,
    '',
    'What you can do with your account:',
    `- Deep niche discovery: ${o}/search.html`,
    `- Build Hub (validation, forecast, risk, plan, deck): ${o}/dashboard.html`,
    `- Growth Partner rewards: ${o}/growth.html`,
    `- Pricing & how it works: ${o}/how-it-works.html`,
    '',
    `Start a search: ${o}/search.html`,
    '',
    `Niche Finder Ltd. Unsubscribe: ${unsubUrl}`,
  ].join('\n');

  return { subject, html, text, unsubUrl };
}

// ---- sending ---------------------------------------------------------------
// force:true ignores the ENABLED flag (used by the admin trigger). to:<email>
// sends a single preview to one address (any account) without advancing the
// weekly clock or edition counter.
export async function sendNewsletterOnce({ force = false, to = null } = {}) {
  if (!ENABLED && !force) return { skipped: 'disabled' };
  if (!mailConfigured()) { console.warn('[newsletter] SMTP not configured — nothing sent'); return { skipped: 'mail_not_configured' }; }

  const st = loadState();
  const editionIndex = st.edition || 0;

  let recipients = listNewsletterRecipients();
  if (to) {
    const target = String(to).trim().toLowerCase();
    const found = recipients.find((r) => r.email === target);
    if (found) recipients = [found];
    else {
      const u = userByEmail(target); // allow previewing to any account (e.g. the admin)
      if (!u) return { skipped: 'recipient_not_found', to: target };
      recipients = [{ email: u.email, userId: u.userId, name: u.name }];
    }
  }

  let sent = 0, failed = 0;
  for (const r of recipients) {
    try {
      const { subject, html, text, unsubUrl } = buildEditionEmail(r, editionIndex);
      await sendMail({
        to: r.email, subject, html, text,
        headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      sent++;
    } catch (e) {
      failed++;
      console.error(`[newsletter] send failed to ${r.email}: ${e.message}`);
    }
    if (SEND_DELAY_MS > 0 && recipients.length > 1) await sleep(SEND_DELAY_MS);
  }

  // Advance the clock/edition only on a real full run (never on a single preview).
  if (!to) saveState({ lastSentAt: Date.now(), edition: editionIndex + 1, lastCount: sent, lastFailed: failed, lastAt: new Date().toISOString() });
  console.log(`[newsletter] edition ${editionIndex}: sent=${sent} failed=${failed} of ${recipients.length}${to ? ' (preview)' : ''}`);
  return { sent, failed, total: recipients.length, edition: editionIndex, preview: !!to };
}

// ---- scheduler -------------------------------------------------------------
// Hourly self-check against a persisted clock, so the weekly cadence survives
// restarts and never double-sends. First boot seeds the clock WITHOUT sending,
// so deploying this never triggers an unexpected mass email — use the admin
// trigger to send the first edition when you're ready.
export function startNewsletterScheduler() {
  if (!ENABLED) { console.log('[newsletter] scheduler off (NEWSLETTER_ENABLED=false)'); return; }
  const st = loadState();
  if (!st.lastSentAt) { saveState({ ...st, lastSentAt: Date.now() }); console.log(`[newsletter] armed; first automatic edition in ~${INTERVAL_DAYS}d (or send now via the admin trigger)`); }

  const tick = async () => {
    try {
      const s = loadState();
      if (Date.now() - (s.lastSentAt || 0) >= INTERVAL_MS) {
        console.log('[newsletter] weekly interval elapsed — sending edition');
        await sendNewsletterOnce();
      }
    } catch (e) { console.error('[newsletter] scheduler tick failed:', e.message); }
  };

  const first = setTimeout(tick, 5 * 60 * 1000);      // first check 5 min after boot
  const every = setInterval(tick, 60 * 60 * 1000);    // hourly thereafter
  // Don't let these timers hold the event loop open (keeps the test harness and
  // any short-lived boot from hanging); the HTTP server keeps the process alive.
  if (first.unref) first.unref();
  if (every.unref) every.unref();
}
