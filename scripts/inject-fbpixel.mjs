#!/usr/bin/env node
/* Idempotent Meta (Facebook) Pixel injector. Adds the base pixel + noscript
   fallback into every frontend/*.html <head>, wrapped in markers so a re-run
   replaces cleanly. Pixel id is the single constant below. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PIXEL_ID = '1322395659736364';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

const S = '<!-- FBPX:head (managed by scripts/inject-fbpixel.mjs) -->';
const E = '<!-- /FBPX:head -->';

const block =
  `${S}\n` +
  `<script>\n` +
  `!function(f,b,e,v,n,t,s)\n` +
  `{if(f.fbq)return;n=f.fbq=function(){n.callMethod?\n` +
  `n.callMethod.apply(n,arguments):n.queue.push(arguments)};\n` +
  `if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';\n` +
  `n.queue=[];t=b.createElement(e);t.async=!0;\n` +
  `t.src=v;s=b.getElementsByTagName(e)[0];\n` +
  `s.parentNode.insertBefore(t,s)}(window, document,'script',\n` +
  `'https://connect.facebook.net/en_US/fbevents.js');\n` +
  `fbq('init', '${PIXEL_ID}');\n` +
  `fbq('track', 'PageView');\n` +
  `</script>\n` +
  `<noscript><img height="1" width="1" style="display:none"\n` +
  `src="https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1"\n` +
  `/></noscript>\n` +
  `${E}\n`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = (html) => html.replace(new RegExp(esc(S) + '[\\s\\S]*?' + esc(E) + '\\n?', 'g'), '');

let changed = 0;
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const p = path.join(DIR, f);
  let html = fs.readFileSync(p, 'utf8');
  html = strip(html);
  if (!/<head[^>]*>/i.test(html)) { console.log('skip (no head): ' + f); continue; }
  // Place right after the GTM head block if present, else right after <head>.
  if (/<!-- \/GTM:head -->/.test(html)) html = html.replace(/(<!-- \/GTM:head -->\n?)/, `$1${block}`);
  else html = html.replace(/(<head[^>]*>)/i, `$1\n${block}`);
  fs.writeFileSync(p, html);
  changed++;
}
console.log(`Meta Pixel ${PIXEL_ID} injected into ${changed} files`);
