#!/usr/bin/env node
/* Idempotent Google Tag Manager injector. Adds the GTM <head> snippet and the
   <body> <noscript> fallback to every frontend/*.html, wrapped in markers so a
   re-run replaces cleanly. Container id is the single constant below. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GTM_ID = 'GTM-WM23ZCZR';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

const HS = '<!-- GTM:head (managed by scripts/inject-gtm.mjs) -->';
const HE = '<!-- /GTM:head -->';
const BS = '<!-- GTM:body (managed by scripts/inject-gtm.mjs) -->';
const BE = '<!-- /GTM:body -->';

const headBlock =
  `${HS}\n` +
  `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');</script>\n` +
  `${HE}\n`;

const bodyBlock =
  `${BS}\n` +
  `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n` +
  `${BE}\n`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = (html, s, e) => html.replace(new RegExp(esc(s) + '[\\s\\S]*?' + esc(e) + '\\n?', 'g'), '');

let changed = 0;
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const p = path.join(DIR, f);
  let html = fs.readFileSync(p, 'utf8');
  html = strip(strip(html, HS, HE), BS, BE);
  if (!/<head[^>]*>/i.test(html) || !/<body[^>]*>/i.test(html)) { console.log('skip (no head/body): ' + f); continue; }
  html = html.replace(/(<head[^>]*>)/i, `$1\n${headBlock}`);
  html = html.replace(/(<body[^>]*>)/i, `$1\n${bodyBlock}`);
  fs.writeFileSync(p, html);
  changed++;
}
console.log(`GTM ${GTM_ID} injected into ${changed} files`);
