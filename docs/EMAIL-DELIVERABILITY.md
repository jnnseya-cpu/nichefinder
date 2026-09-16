# Email deliverability — why mail lands in spam, and how to fix it

> ## LIVE AUDIT (2026-09-16) — root cause found
> Everything is on **Hostinger** (no Vercel): site IP `187.124.117.159` (Hostinger
> VPS), MX `mx1/mx2.hostinger.com`, nameservers `athena/apollo.dns-parking.com`
> (edit records in hPanel → **DNS Zone Editor**).
>
> **Two faults are sending mail to spam:**
> 1. **NO SPF record exists.** Root TXT holds only a `fah-claim=…` and a
>    `brevo-code:…` — there is no `v=spf1` record, so Hostinger's senders are
>    unauthorized and **SPF fails on every message.** ← the big one.
> 2. **TWO `_dmarc` records** (`…rua=…brevo…` and a bare `v=DMARC1; p=none`).
>    DMARC allows exactly one; two = permerror = no DMARC.
> 3. DKIM is fine (`hostingermail-a/b._domainkey` CNAMEs published).
>
> A `brevo-code` TXT + Brevo DMARC rua means **Brevo (Sendinblue) was also set up**
> at some point — the SPF below authorizes Hostinger and Brevo both.
>
> **FIX (hPanel → DNS Zone Editor):**
> - ADD one SPF TXT on `@`:
>   `v=spf1 include:_spf.mail.hostinger.com include:spf.sendinblue.com ~all`
>   (drop the sendinblue include if nothing uses Brevo; only ONE SPF record allowed)
> - DELETE both `_dmarc` TXT records, ADD one:
>   `v=DMARC1; p=none; rua=mailto:dmarc@nichefinderhq.com; fo=1`
> - Leave DKIM as-is. Wait for propagation, re-test at mail-tester.com.

> **YOUR SETUP: Hostinger relay** (`SMTP_HOST=smtp.hostinger.com`). Hostinger's
> servers send, so their IP reputation and rDNS are already handled. Your job is
> just to publish **SPF + DKIM + DMARC** for `nichefinderhq.com`. Exact steps:
>
> **First, find where your DNS lives** — this decides how you add records:
> - If the domain's nameservers point at **Hostinger** (hPanel → Domains → DNS/
>   Nameservers shows Hostinger), you add records in hPanel → **DNS Zone Editor**,
>   and Hostinger may have already created SPF/DKIM automatically — verify them.
> - If DNS is at **Cloudflare / Namecheap / GoDaddy** (external), you must copy
>   the records Hostinger shows in **hPanel → Emails → your mailbox → DNS records
>   / Configure** into that provider by hand. This is the usual reason Hostinger
>   mail still spams: the records exist in hPanel but were never added at the DNS
>   host.
>
> **The three records (values as Hostinger shows them — these are the typical ones):**
> 1. **SPF** — one TXT on the root (`@`). Hostinger's is usually:
>    `v=spf1 include:_spf.mail.hostinger.com ~all`
>    You may have only ONE SPF record — if one exists, merge the include into it.
> 2. **DKIM** — Hostinger publishes two CNAMEs (copy the exact targets from hPanel):
>    `hostingermail-a._domainkey  CNAME  hostingermail-a.dkim.mail.hostinger.com`
>    `hostingermail-b._domainkey  CNAME  hostingermail-b.dkim.mail.hostinger.com`
>    (some accounts show a single `default._domainkey` TXT instead — use whatever
>    hPanel lists). **This is the biggest lever — do not skip it.**
> 3. **DMARC** — TXT on `_dmarc`:
>    `v=DMARC1; p=none; rua=mailto:dmarc@nichefinderhq.com; fo=1`
>
> **Then confirm From alignment:** set
> `SMTP_FROM="Niche Finder <contact@nichefinderhq.com>"` in `/etc/nichefinder.env`
> (must be the same `@nichefinderhq.com` mailbox as `SMTP_USER`), and redeploy.
>
> **Verify:** send a password reset to the address at **mail-tester.com** → aim
> 9–10/10, and check a Gmail "Show original" shows SPF/DKIM/DMARC = PASS. DNS can
> take up to a few hours to propagate.
>
> The rest of this document is the full reference (both setups) and the exact
> record formats.

---

## The general picture

Symptom: receipts, password resets, lead notifications, or the newsletter land in
the **Spam/Junk** folder.

**The truth about causes, in order of impact:**

1. **Authentication failing (SPF / DKIM / DMARC)** — ~80% of spam placement. If a
   receiving server can't verify the mail is really from `nichefinderhq.com`, it
   distrusts it. This is DNS config, not code.
2. **Sending-IP / domain reputation** — a new or shared IP with no history, or a
   self-hosted IP on a consumer block, starts "cold" and gets filtered.
3. **Missing headers / bad format** — `Message-ID`, one-click unsubscribe on bulk.
   (Both are now handled in code — see below.)
4. **Content** — spammy words, image-only mail, link shorteners, bad ratios.

## Step 0 — Diagnose in 2 minutes (do this first)

Don't guess. Get the actual verdict:

- **mail-tester.com**: open it, copy the address it shows, trigger a real email to
  it (e.g. a password reset to that address), then check your score. It tells you
  exactly which of SPF/DKIM/DMARC/rDNS fails and why. Aim for 9–10/10.
- **Gmail "Show original"**: send yourself a mail, open it in Gmail → ⋮ → *Show
  original*. You want to see:
  ```
  SPF:   PASS
  DKIM:  'PASS' with domain nichefinderhq.com
  DMARC: 'PASS'
  ```
  Any `FAIL`/`SOFTFAIL`/`none` is your problem — fix that record.

## Which setup are you on? (it decides whose records matter)

The mailer sends via whatever `SMTP_HOST` is set to:

- **A) Relay through Hostinger** (`SMTP_HOST=smtp.hostinger.com`) — Hostinger's IP
  sends, so Hostinger's rDNS/reputation apply. You still must publish **SPF** and
  **DKIM** for `nichefinderhq.com` using the records Hostinger gives you in
  hPanel → Emails → DNS/DKIM. This is the easier, more reliable path.
- **B) Your own `mailserver` container** — you own SPF, DKIM, DMARC, rDNS, and IP
  warmup entirely. Much harder to keep out of spam; only worth it if deliberate.

If you're not sure, check the env: `grep SMTP_HOST /etc/nichefinder.env`.

## The DNS records to publish (host: your DNS provider for nichefinderhq.com)

### 1. SPF (one TXT record on the root domain — never two)
- **Relay via Hostinger:**
  `TXT  @  "v=spf1 include:_spf.mail.hostinger.com ~all"`
  (use the exact `include:` Hostinger lists — it may differ.)
- **Own mailserver:**
  `TXT  @  "v=spf1 ip4:YOUR.SERVER.IP -all"`
- You may have only **one** SPF record. If one already exists, merge, don't add a
  second.

### 2. DKIM (TXT record; the selector + key come from your mail host)
- **Hostinger:** enable DKIM in hPanel and publish the `selector._domainkey`
  record it generates (often a CNAME or TXT).
- **Own mailserver (docker-mailserver):** run `setup config dkim`, then publish
  the printed `mail._domainkey.nichefinderhq.com TXT "v=DKIM1; k=rsa; p=…"`.
- **DKIM is the single biggest win.** Self-hosted mail with no DKIM almost always
  goes to spam. Confirm the signing domain matches `nichefinderhq.com` (alignment).

### 3. DMARC (required by Gmail/Yahoo for any volume)
`TXT  _dmarc  "v=DMARC1; p=none; rua=mailto:dmarc@nichefinderhq.com; fo=1"`
- Start with `p=none` (monitor only). After a week of clean `rua` reports showing
  SPF+DKIM aligned, raise to `p=quarantine`, then `p=reject`.

### 4. rDNS / PTR (own mailserver only)
- Ask your VPS host (Hostinger) to set the **PTR** for your server IP to a
  hostname that forward-resolves back to the same IP (e.g. `mail.nichefinderhq.com`).
- Make the mailer's HELO match it: set `SMTP_HELO=mail.nichefinderhq.com` if you
  add that env (currently HELO is derived from the From domain — fine for a relay,
  but a self-hosted server wants HELO = its rDNS name).

## From-address alignment (matters for both setups)

- `SMTP_FROM` domain **must** equal the DKIM signing domain and the SMTP_USER
  domain. Send as `Niche Finder <noreply@nichefinderhq.com>` or
  `contact@nichefinderhq.com` — never a gmail.com/other-domain From, which breaks
  DMARC alignment instantly.
- Set a **display name**: `SMTP_FROM="Niche Finder <contact@nichefinderhq.com>"`.
- Consider a dedicated `noreply@` or `receipts@` mailbox so transactional mail and
  the newsletter don't share reputation with your personal inbox.

## What is already handled in code (you don't need to touch)

- **Message-ID** — auto-generated on every message, domain-aligned to From
  (`src/mailer.js`). Its absence is a common spam trigger; now fixed.
- **Multipart/alternative** — every mail that has both text and HTML sends both, so
  filters and text-only clients get a plain part.
- **One-click unsubscribe** on the newsletter — `List-Unsubscribe` +
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), which Gmail and
  Yahoo now require for bulk senders (`src/newsletter.js`).
- **Header-injection safe** — CR/LF stripped from every header value.

## If you're launching transactional mail and want it to just work

Consider an authenticated ESP relay for transactional mail specifically (Amazon
SES, Resend, Postmark, Mailgun): you point `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` at
them, publish their SPF/DKIM records once, and inherit a warm, monitored IP pool.
No code change — it's the same SMTP path. This is the most reliable route to the
inbox for receipts and password resets, where landing in spam directly costs you
customers. Keep the domain's DMARC in place either way.

## Order of operations

1. Run mail-tester.com → read the exact failures.
2. Publish SPF (one record) + enable/publish DKIM. Re-test → expect SPF+DKIM PASS.
3. Add DMARC `p=none`. Re-test.
4. Fix `SMTP_FROM` alignment + display name.
5. (Own server only) set PTR/rDNS + `SMTP_HELO`.
6. Re-run mail-tester until 9–10/10, then send a real receipt to a Gmail account
   and confirm it lands in Primary, not Spam.
