#!/usr/bin/env node
// Saturday readiness check. Run from repo root: node scripts/preflight.mjs
// Verifies deploy artifacts, runs both gateway test suites, and prints GO/NO-GO.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

let ok = true;
const line = (pass, msg) => { console.log(`${pass ? '✓' : '✗'} ${msg}`); if (!pass) ok = false; };

console.log('\nNICHE FINDER — Saturday pre-flight\n');

for (const f of ['Dockerfile', 'DEPLOY-VPS.md', 'LAUNCH.md', 'SATURDAY-GOLIVE.md',
  'frontend/nf-config.js', 'frontend/index.html', 'shared/nf-economy.js',
  'frontend/account.html', 'frontend/reset.html', 'frontend/admin-console.html', 'frontend/nf-auth.js',
  'backend/gateway/src/server.js', 'backend/gateway/src/payments.js',
  'backend/gateway/src/human.js', 'backend/gateway/src/auth.js']) {
  line(existsSync(f), `present: ${f}`);
}

// deploy switch reachable (empty is fine pre-deploy; Saturday you set it)
try {
  const cfg = execSync('grep -c "NF_GATEWAY_URL" frontend/nf-config.js').toString().trim();
  line(Number(cfg) > 0, 'deploy switch NF_GATEWAY_URL present in nf-config.js');
} catch { line(false, 'deploy switch missing'); }

// free acquisition hook present
try {
  const hook = execSync('grep -c "Score your business idea free" frontend/index.html').toString().trim();
  line(Number(hook) > 0, 'free Niche Score acquisition hook on homepage');
} catch { line(false, 'free score hook missing'); }

// run the suites
try {
  console.log('\nrunning gateway test suites…');
  const out = execSync('cd backend/gateway && npm test 2>&1').toString();
  line(/All smoke tests passed/.test(out), 'smoke suite green');
  line(/FULL PAYMENT CYCLE: all checks passed/.test(out), 'full payment cycle green');
} catch (e) {
  const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  line(/All smoke tests passed/.test(out), 'smoke suite green');
  line(/FULL PAYMENT CYCLE: all checks passed/.test(out), 'full payment cycle green');
}

console.log(`\n${ok ? '🟢 GO — code is ready. Saturday is founder admin + deploy (SATURDAY-GOLIVE.md).'
  : '🔴 NO-GO — fix the ✗ items above before deploying.'}\n`);
process.exit(ok ? 0 : 1);
