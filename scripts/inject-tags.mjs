#!/usr/bin/env node
/* Idempotent tag injector. Removes any raw GTM / Meta-Pixel snippet blocks
   (now superseded) and injects a single consent-gated loader — nf-tags.js —
   into every frontend/*.html <head>. GTM + Pixel now load only after consent
   (see nf-tags.js), so no un-gated inline snippets or noscript fallbacks remain. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const S = '<!-- TAGS:head (managed by scripts/inject-tags.mjs) -->';
const E = '<!-- /TAGS:head -->';
// `defer` so the tag loader never blocks first paint (it sets Consent Mode
// defaults then loads GTM/Pixel in order, after parse — all NF_TRACK calls are
// in event handlers, so nothing needs it synchronously).
const block = `${S}\n<script src="nf-tags.js" defer></script>\n${E}\n`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripPair = (html, a, b) => html.replace(new RegExp(esc(a) + '[\\s\\S]*?' + esc(b) + '\\n?', 'g'), '');
const strip = (html) => {
  html = stripPair(html, '<!-- GTM:head (managed by scripts/inject-gtm.mjs) -->', '<!-- /GTM:head -->');
  html = stripPair(html, '<!-- GTM:body (managed by scripts/inject-gtm.mjs) -->', '<!-- /GTM:body -->');
  html = stripPair(html, '<!-- FBPX:head (managed by scripts/inject-fbpixel.mjs) -->', '<!-- /FBPX:head -->');
  html = stripPair(html, S, E);
  return html;
};

let changed = 0;
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const p = path.join(DIR, f);
  let html = strip(fs.readFileSync(p, 'utf8'));
  if (!/<head[^>]*>/i.test(html)) { console.log('skip (no head): ' + f); continue; }
  html = html.replace(/(<head[^>]*>)/i, `$1\n${block}`);
  fs.writeFileSync(p, html);
  changed++;
}
console.log(`Consent-gated nf-tags.js injected into ${changed} files (raw GTM/Pixel snippets removed)`);
