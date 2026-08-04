/* Niche Finder OS — full end-to-end QA: user role + admin role + backend API.
   Screenshot on every PASS; process exits 1 if anything fails. */
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const SHOTS = __dirname + '/shots';
const B = 'http://localhost:8901/frontend/';
const GW = 'http://localhost:8902';
const results = [];

function log(id, ok, desc, extra) {
  results.push({ id, ok, desc, extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' — ' + desc + (extra ? ' [' + extra + ']' : ''));
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const shot = (n) => page.screenshot({ path: SHOTS + '/' + n + '.png' });
  const paid = () => page.evaluate(() => NF.wallet().paid);
  const free = () => page.evaluate(() => NF.wallet().free);

  /* ============ USER ROLE ============ */

  // U01 landing + consent
  await page.goto(B + 'index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const badge = await page.locator('.hero-badges').first().innerText();
  await page.getByRole('button', { name: 'Accept all' }).click();
  await page.waitForTimeout(400);
  const bannerGone = (await page.locator('text=Cookies & local storage').count()) === 0;
  log('U01', /End-to-End Encrypted/i.test(badge) && bannerGone, 'Landing renders, E2EE badge shown, consent accepted & banner dismissed');
  await shot('U01-landing-consent-accepted');

  // U02 welcome wallet
  await page.goto(B + 'dashboard.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const w0 = await page.evaluate(() => NF.wallet());
  log('U02', w0.paid === 0 && w0.free === 100, 'New account holds exactly 100 free read-only welcome ACUs', JSON.stringify(w0));
  await shot('U02-welcome-wallet-100-free');

  // U03 top-up Builder £10 → 1,100 paid
  await page.click('#topUp');
  await page.waitForSelector('[data-pkg="builder_10"]');
  await shot('U03a-topup-modal-packages');
  await page.click('[data-pkg="builder_10"]');
  await page.waitForTimeout(600);
  const w1 = await page.evaluate(() => NF.wallet());
  log('U03', w1.paid === 1100, 'Builder package credits 1,100 paid ACU (£10 = 1,000 + 100 bonus)', 'paid=' + w1.paid);
  await page.reload(); await page.waitForTimeout(500);
  await shot('U03b-wallet-after-topup');

  // U04 subscription plan selection
  await page.locator('#planGrid .bcard', { hasText: 'Professional' }).locator('button').click();
  await page.waitForTimeout(400);
  const planTag = await page.locator('#planTag').innerText();
  log('U04', /PROFESSIONAL/.test(planTag), 'Professional plan selected and persisted', planTag);
  await shot('U04-plan-selected');

  // U05 search canvas config (mandatory country)
  await page.goto(B + 'search.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const sel = document.getElementById('country');
    const opt = Array.from(sel.options).find((o) => /congo/i.test(o.textContent));
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const market = await page.locator('#sumMarket').innerText();
  log('U05', /congo/i.test(market), 'Country (mandatory) selected; config summary reflects market', market);
  await shot('U05-search-config-country');

  // U06 capital bracket scales price live (£25k → bracket 3 ×4 → 500 ACU)
  await page.evaluate(() => { document.querySelector('details.adv').open = true; });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const b = document.getElementById('budget');
    b.value = 25000;
    b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const cost25 = await page.locator('#acuCost').innerText();
  log('U06', /500/.test(cost25), 'Bracket 3 (£25k) prices search at 500 ACU (125 × 4) live in the rail', cost25.replace(/\s+/g, ' '));
  await shot('U06-bracket3-price-500');

  // U07 investor mode multiplier (back at £10k: 125 × 1.4 = 175)
  await page.evaluate(() => {
    const b = document.getElementById('budget');
    b.value = 10000;
    b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#invMode').scrollIntoViewIfNeeded();
  await page.click('#invMode');
  await page.waitForTimeout(300);
  const costInv = await page.locator('#acuCost').innerText();
  log('U07', /175/.test(costInv), 'Investor Mode applies ×1.4 (125 → 175 ACU)', costInv.replace(/\s+/g, ' '));
  await shot('U07-investor-mode-175');
  await page.click('#invMode'); // off again
  await page.waitForTimeout(200);

  // U08 run discovery — charges 125, renders ranked scored niches
  const paidBefore = await paid();
  await page.click('#generate');
  await page.waitForSelector('.niche', { timeout: 8000 });
  await page.waitForTimeout(1200);
  const nicheCount = await page.locator('.niche').count();
  const paidAfterSearch = await paid();
  log('U08', nicheCount >= 3 && paidAfterSearch === paidBefore - 125,
    'Discovery run charges exactly 125 ACU and renders scored opportunities',
    nicheCount + ' niches, paid ' + paidBefore + '→' + paidAfterSearch);
  await shot('U08-discovery-results');

  // U09 search history (last-10, re-run)
  const histVisible = await page.locator('#histCard').isVisible();
  const histText = await page.locator('#histList').innerText();
  log('U09', histVisible && /congo/i.test(histText), 'Recent Searches rail logs the run for one-click re-run', histText.split('\n')[0]);
  await shot('U09-search-history');

  // U10 unlock → Deep-Dive project workspace (150 ACU)
  const paidB4Unlock = await paid();
  await page.locator('.a.primary').first().click();
  await page.waitForURL('**/project.html', { timeout: 8000 });
  await page.waitForTimeout(800);
  const paidAfterUnlock = await page.evaluate(() => NF.wallet().paid);
  const projTitle = await page.locator('h1').first().innerText();
  log('U10', paidAfterUnlock === paidB4Unlock - 150 && projTitle.length > 3,
    'Unlock charges 150 ACU and opens the Deep-Dive workspace', '"' + projTitle.slice(0, 40) + '…" paid ' + paidB4Unlock + '→' + paidAfterUnlock);
  await shot('U10-project-unlocked');

  // U11 Build Hub: market validation engine (250 ACU) advances status
  const paidB4Val = await paid();
  const valBtn = page.locator('#actions button', { hasText: 'Market Validation' }).first();
  await valBtn.click();
  await page.waitForFunction(() => NF.wallet !== undefined && document.querySelector('#actions') !== null);
  await page.waitForTimeout(2400); // generation runs ~1.6s, then charges + re-renders
  const paidAfterVal = await paid();
  log('U11', paidAfterVal === paidB4Val - 250, 'Market Validation engine charges 250 ACU and syncs to repository',
    'paid ' + paidB4Val + '→' + paidAfterVal);
  await shot('U11-validation-generated');

  // U12 Build Hub: 3-year forecast (250 ACU)
  const paidB4F = await paid();
  await page.locator('#actions button', { hasText: 'Cashflow Forecast' }).first().click();
  await page.waitForTimeout(2400);
  const paidAfterF = await paid();
  log('U12', paidAfterF === paidB4F - 250, 'Cashflow Forecast engine charges 250 ACU', 'paid ' + paidB4F + '→' + paidAfterF);
  await shot('U12-forecast-generated');

  // U13 document viewer renders the generated validation report
  await page.goto(B + 'asset.html?type=validation', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const docH1 = await page.locator('.doc-band h1').innerText();
  const docTag = await page.locator('.doc-band .meta').innerText();
  log('U13', docH1.length > 3 && /250 ACU/.test(docTag), 'Branded validation report renders with bracket-priced tag',
    '"' + docH1.slice(0, 40) + '…"');
  await shot('U13-asset-validation-report');

  // U14 support concierge answers, 1 ACU from welcome credits (dashboard carries the widget)
  await page.goto(B + 'dashboard.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const freeB4 = await free();
  await page.getByRole('button', { name: 'Open support' }).click();
  await page.fill('[data-in]', 'How does pricing work?');
  await page.locator('form[data-form] button[type=submit]').click();
  await page.waitForTimeout(900);
  const freeAfter = await free();
  const answered = await page.locator('[data-log]').innerText();
  log('U14', freeAfter === freeB4 - 1 && /ACU/i.test(answered),
    'Support concierge replies; 1 ACU deducted from free welcome credits', 'free ' + freeB4 + '→' + freeAfter);
  await shot('U14-support-concierge');

  // U15 low-balance alert fires below 50 paid ACU
  await page.evaluate(() => { localStorage.setItem('nf_wallet', JSON.stringify({ paid: 60, free: 99 })); });
  await page.reload(); await page.waitForTimeout(500);
  await page.evaluate(() => NF.charge(20, 'QA low-balance probe'));
  await page.waitForTimeout(400);
  const lowToast = await page.locator('text=ACU balance low').count();
  log('U15', lowToast > 0, 'Low-balance notice fires when paid ACU drops below 50 (40 left)', 'toast visible');
  await shot('U15-low-balance-alert');

  // U16 human-only: bot-speed contact submission is blocked
  await page.goto(B + 'contact.html', { waitUntil: 'load' });
  await page.fill('#contactForm input[type=text]', 'QA Bot');
  await page.fill('#contactForm input[type=email]', 'bot@qa.test');
  await page.fill('#contactForm textarea', 'automated');
  await page.check('#humanCheck');
  await page.locator('#contactForm button[type=submit]').click();
  await page.waitForTimeout(300);
  const blocked = await page.locator('text=SUBMISSION BLOCKED').count();
  log('U16', blocked > 0, 'Bot-speed submission rejected by human-only access controls');
  await shot('U16-bot-blocked');

  // U17 human-paced submission goes through
  await page.reload(); await page.waitForTimeout(3400);
  await page.fill('#contactForm input[type=text]', 'Amara Okafor');
  await page.fill('#contactForm input[type=email]', 'amara@example.com');
  await page.fill('#contactForm textarea', 'Interested in the incubator plan.');
  await page.check('#humanCheck');
  await page.locator('#contactForm button[type=submit]').click();
  await page.waitForTimeout(300);
  const queued = await page.locator('text=MESSAGE QUEUED').count();
  log('U17', queued > 0, 'Human-paced submission accepted and queued');
  await shot('U17-human-accepted');

  /* ============ ADMIN ROLE ============ */

  // A01 Super Admin OS command overview
  await page.goto(B + 'admin.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const kpiCount = await page.locator('.kpi').count();
  log('A01', kpiCount >= 6, 'Super Admin OS command overview renders platform KPIs', kpiCount + ' KPI tiles');
  await shot('A01-admin-overview');

  // A02 admin grants 1,000 ACU to a user wallet
  const paidB4Grant = await paid();
  await page.click('[data-pane="ops"]');
  await page.click('[data-spane="users"]');
  await page.fill('#modUid', 'OP-QA-001');
  await page.click('#modRun');
  await page.waitForTimeout(500);
  const paidAfterGrant = await paid();
  log('A02', paidAfterGrant === paidB4Grant + 1000, 'Admin ACU grant credits 1,000 to the user wallet',
    'paid ' + paidB4Grant + '→' + paidAfterGrant);
  await shot('A02-admin-grant-1000');

  // A03 admin generates + publishes a blog post
  await page.click('[data-spane="blog"]');
  await page.fill('#blogTopic', 'QA Launch Readiness: How We Test the OS');
  await page.click('#genDraft');
  await page.waitForTimeout(600);
  await page.locator('[data-publish]').first().click();
  await page.waitForTimeout(400);
  const pubRow = await page.locator('#postsTable').innerText();
  log('A03', /QA Launch Readiness/.test(pubRow) && /published/i.test(pubRow), 'Blog post generated and published from Platform Ops');
  await shot('A03-admin-blog-published');

  // A04 published post appears live on the public blog
  await page.goto(B + 'blog.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const liveVisible = await page.locator('#livePosts').isVisible();
  const liveText = liveVisible ? await page.locator('#livePostGrid').innerText() : '';
  log('A04', liveVisible && /QA Launch Readiness/.test(liveText), 'Published post is live on the public blog instantly');
  await shot('A04-blog-live-post');

  // A05 support escalation reaches admin and is resolved
  await page.goto(B + 'dashboard.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Open support' }).click();
  await page.fill('[data-in]', 'human');
  await page.locator('form[data-form] button[type=submit]').click();
  await page.waitForTimeout(700);
  await page.fill('[data-in]', 'I need help with a payment issue');
  await page.locator('form[data-form] button[type=submit]').click();
  await page.waitForTimeout(900);
  await page.goto(B + 'admin.html', { waitUntil: 'load' });
  await page.click('[data-pane="ops"]');
  await page.waitForTimeout(400);
  const caseText = await page.locator('#caseList').innerText();
  const hadCase = /Resolve/i.test(await page.locator('#caseList').innerHTML());
  await shot('A05a-admin-support-case-open');
  if (hadCase) {
    await page.locator('[data-resolve]').first().click();
    await page.waitForTimeout(400);
  }
  const caseAfter = await page.locator('#caseList').innerText();
  log('A05', hadCase && /No open support cases/i.test(caseAfter),
    'User escalation lands as an admin case and resolves to the ledger', caseText.slice(0, 60));
  await shot('A05b-admin-support-case-resolved');

  // A06 SEO war room
  await page.click('[data-pane="seo"]');
  await page.waitForTimeout(400);
  const seoText = await page.locator('#pane-seo').innerText();
  log('A06', /keyword|content|SEO/i.test(seoText), 'SEO War Room renders content generator and keyword map');
  await shot('A06-admin-seo-war-room');

  // A07 OS governance
  await page.click('[data-pane="gov"]');
  await page.waitForTimeout(400);
  const govText = await page.locator('#pane-gov').innerText();
  log('A07', /governance|insight|confidence/i.test(govText), 'OS Governance pane renders strategic insights');
  await shot('A07-admin-governance');

  // A08 ledger shows the full ACU audit trail
  await page.click('[data-pane="ops"]');
  await page.click('[data-spane="ledger"]');
  await page.waitForTimeout(400);
  const ledgerText = await page.locator('#spane-ledger').innerText();
  log('A08', /TOP-UP|OPERATIONAL_TASK|ADMIN/i.test(ledgerText), 'Ledger shows top-ups, charges, and admin actions as an audit trail');
  await shot('A08-admin-ledger');

  // A09 comms engine: preview branded email + send test across channels
  await page.goto(B + 'comms.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.selectOption('#evSel', 'payment.successful');
  await page.click('#btnPreview');
  await page.waitForTimeout(300);
  const mailText = await page.locator('#mailPreview').innerText();
  await page.click('#btnSend');
  await page.waitForTimeout(400);
  const deliv = await page.locator('#kDeliv').innerText();
  log('A09', /Payment received/i.test(mailText) && Number(deliv) >= 3,
    'Comms engine previews branded email and fires test across its channels', deliv + ' messages delivered');
  await shot('A09-comms-preview-and-send');

  // A10 bot-block security events present in catalogue as mandatory
  const secText = await page.locator('#catalogue').innerText();
  log('A10', /Bot sign-up blocked/i.test(secText) && /Bot sign-in blocked/i.test(secText),
    'Human-only access events ship in the catalogue as mandatory notices');
  await shot('A10-comms-bot-events');

  // A11 government observatory switches country datasets
  await page.goto(B + 'government.html', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.selectOption('#countrySel', { label: 'Nigeria' });
  await page.waitForTimeout(500);
  const govPage = await page.locator('main').innerText();
  log('A11', /Nigeria/i.test(govPage), 'Government observatory re-renders k-anonymised dataset for Nigeria');
  await shot('A11-government-nigeria');

  /* ============ BACKEND API (real HTTP against the gateway) ============ */
  const QA_USER = 'op_qa' + Math.random().toString(36).slice(2, 12);
  const api = [];
  const j = (r) => r.json();
  const health = await fetch(GW + '/v1/health').then(j);
  api.push(['GET /v1/health', health.status === 'ok', JSON.stringify(health)]);

  const gen = await fetch(GW + '/v1/generate', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'QA ping' }], capitalGBP: 15000 }) }).then(j);
  api.push(['POST /v1/generate (capital £15k)', typeof gen.text === 'string' && gen.bracketFactor === 2,
    'provider=' + gen.provider + ' acu=' + gen.acu + ' bracketFactor=' + gen.bracketFactor]);

  const est = await fetch(GW + '/v1/estimate', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'estimate' }], capitalGBP: 25000 }) }).then(j);
  api.push(['POST /v1/estimate (capital £25k)', typeof est.estimatedAcu === 'number', 'estimatedAcu=' + est.estimatedAcu]);

  const wallet0 = await fetch(GW + '/v1/wallet?user=' + QA_USER).then(j);
  api.push(['GET /v1/wallet — welcome grant', wallet0.paid === 0 && wallet0.free === 100, JSON.stringify(wallet0)]);

  const cred = await fetch(GW + '/v1/wallet/credit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: QA_USER, packageId: 'builder_10', idempotencyKey: 'qa-credit-' + QA_USER }) }).then(j);
  api.push(['POST /v1/wallet/credit builder_10', cred.credited === 1100 && cred.wallet.paid === 1100, JSON.stringify(cred.wallet)]);

  const ch1 = await fetch(GW + '/v1/wallet/charge', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: QA_USER, amount: 125, label: 'niche search', action: 'niche_search', bracketFactor: 1, idempotencyKey: 'qa-charge-' + QA_USER }) }).then(j);
  const ch2 = await fetch(GW + '/v1/wallet/charge', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: QA_USER, amount: 125, label: 'niche search', action: 'niche_search', bracketFactor: 1, idempotencyKey: 'qa-charge-' + QA_USER }) }).then(j);
  api.push(['POST /v1/wallet/charge + idempotent replay', ch1.wallet.paid === 975 && ch2.replayed === true && ch2.wallet.paid === 975,
    'paid=' + ch1.wallet.paid + ' replayed=' + ch2.replayed]);

  const overRes = await fetch(GW + '/v1/wallet/charge', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: QA_USER, amount: 99999, label: 'overdraft attempt' }) });
  const over = await overRes.json();
  api.push(['Overdraft → 402 insufficient_acu (code 4001)', overRes.status === 402 && over.error === 'insufficient_acu' && over.platformCode === 4001,
    'status=' + overRes.status + ' platformCode=' + over.platformCode]);

  const tx = await fetch(GW + '/v1/wallet/transactions?user=' + QA_USER).then(j);
  const t0 = tx.ledger[0];
  api.push(['GET /v1/wallet/transactions — enriched entries', t0 && typeof t0.balanceAfter === 'number' && t0.pool === 'paid' && t0.bracketFactor === 1,
    JSON.stringify({ t: t0.t.slice(0, 30), balanceBefore: t0.balanceBefore, balanceAfter: t0.balanceAfter, pool: t0.pool })]);

  await new Promise((r) => setTimeout(r, 300)); // let the debounced persist flush
  const storeHead = require('fs').readFileSync('/tmp/qa-wallets.json', 'utf8').slice(0, 5);
  api.push(['Wallet store encrypted at rest (AES-256-GCM)', storeHead === 'NFE1:', 'file starts with "' + storeHead + '"']);

  let smokeOut = '';
  try { smokeOut = execSync('cd /home/user/nichefinder/backend/gateway && node test/smoke.js 2>&1').toString(); } catch (e) { smokeOut = e.stdout ? e.stdout.toString() : 'run failed'; }
  const smokePassed = /All smoke tests passed/.test(smokeOut);
  const smokeCount = (smokeOut.match(/✓/g) || []).length;
  api.push(['Gateway smoke suite', smokePassed, smokeCount + '/17 checks green']);

  api.forEach(([name, ok, extra], i) => log('B' + String(i + 1).padStart(2, '0'), ok, name, extra));

  // render backend results as a branded report and screenshot it
  const rows = api.map(([name, ok, extra]) =>
    '<tr><td style="padding:10px 14px;border-bottom:1px solid #1E2A3E"><b style="color:' + (ok ? '#3FA79B' : '#C4604F') + '">' +
    (ok ? 'PASS' : 'FAIL') + '</b></td><td style="padding:10px 14px;border-bottom:1px solid #1E2A3E">' + name +
    '</td><td style="padding:10px 14px;border-bottom:1px solid #1E2A3E;font-family:monospace;font-size:12px;color:#8B93A5">' + String(extra).replace(/</g, '&lt;') + '</td></tr>').join('');
  await page.setContent('<body style="background:#070B14;color:#EAE5D9;font-family:Georgia,serif;padding:40px">' +
    '<div style="border-top:3px solid #E8A61A;max-width:1100px;margin:0 auto;background:#0E1626;border-radius:10px;padding:30px">' +
    '<div style="font-family:monospace;font-size:11px;letter-spacing:.2em;color:#E8A61A">NICHE FINDER OS · BACKEND QA</div>' +
    '<h1 style="font-weight:400;margin:8px 0 4px">Gateway &amp; Wallet API — live test results</h1>' +
    '<p style="color:#8B93A5;font-size:14px">Mock-provider mode · encrypted store · ' + new Date().toISOString() + '</p>' +
    '<table style="border-collapse:collapse;width:100%;margin-top:18px;font-size:14px">' + rows + '</table></div></body>');
  await page.screenshot({ path: SHOTS + '/B01-backend-api-report.png', fullPage: true });

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== ' + (results.length - failed.length) + '/' + results.length + ' tests passed =====');
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.id).join(', ')); }
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
