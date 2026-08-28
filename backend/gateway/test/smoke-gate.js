// SMOKE-GATE test — the post-deploy live check that drives auto-rollback.
// Proves nf-smoke.sh passes against a healthy running gateway and fails fast
// against a dead port (which is what triggers the rollback in vps-autodeploy.sh).
// The gateway is spawned as a SEPARATE process (as in production), so the smoke
// script probes a real socket. Run: node test/smoke-gate.js
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(HERE, '..');
const ROOT = path.resolve(GATEWAY, '..', '..');
const SMOKE = path.join(ROOT, 'scripts', 'nf-smoke.sh');
const PORT = '18821';
const HEALTH = `http://127.0.0.1:${PORT}/v1/health`;
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const runSmoke = (env) => {
  try { execFileSync('bash', [SMOKE], { env: { ...process.env, ...env }, encoding: 'utf8' }); return 0; }
  catch (e) { return e.status || 1; }
};

// 1) dead port → smoke FAILS fast (this is what fires the rollback).
console.log('— smoke against a dead service fails (→ triggers rollback) —');
const rc = runSmoke({ NF_SMOKE_URL: HEALTH, NF_SMOKE_RETRIES: '2', NF_SMOKE_DELAY: '1' });
check('nf-smoke.sh exits non-zero when nothing is listening', rc !== 0, `rc=${rc}`);

// 2) boot the real gateway as a separate process → smoke PASSES.
console.log('— smoke against the healthy gateway passes —');
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: GATEWAY,
  env: { ...process.env, MOCK_AI: '1', PORT, WALLET_STORE: '/tmp/smokegate-wallets.json', WALLET_STORE_KEY: 'cd'.repeat(32) },
  stdio: 'ignore',
});
try {
  const rc2 = runSmoke({ NF_SMOKE_URL: HEALTH, NF_SMOKE_RETRIES: '8', NF_SMOKE_DELAY: '1' });
  check('nf-smoke.sh exits 0 when the service is healthy (200/status)', rc2 === 0, `rc=${rc2}`);
} finally {
  try { process.kill(child.pid); } catch {}
}

console.log(failures === 0 ? '\nSMOKE GATE: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
