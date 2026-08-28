// FAILURE-INJECTION DRILL (Phase 17) — proves the health watchdog + alert webhook
// actually work: it detects an outage, fires a DOWN alert, de-dups while still
// down, and fires a RECOVERED alert when the service comes back. Everything runs
// locally: a mock webhook receiver captures the alerts, the gateway is spawned as
// a real process and killed to inject the failure. Run: node test/drill.js
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(HERE, '..');
const ROOT = path.resolve(GATEWAY, '..', '..');
const MONITOR = path.join(ROOT, 'scripts', 'nf-monitor.sh');
const GW_PORT = '18822';
const HOOK_PORT = 18823;
const HEALTH = `http://127.0.0.1:${GW_PORT}/v1/health`;
const HOOK = `http://127.0.0.1:${HOOK_PORT}/`;
const STATE = '/tmp/nf-drill.state';
try { fs.unlinkSync(STATE); } catch {}
let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };

// Mock webhook receiver — records every alert the monitor posts.
const alerts = [];
const hookSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { alerts.push(b); res.writeHead(200); res.end('ok'); });
});
await new Promise((r) => hookSrv.listen(HOOK_PORT, r));

const MENV = { NF_HEALTH_URL: HEALTH, NF_ALERT_WEBHOOK: HOOK, NF_MONITOR_STATE: STATE, NO_PROXY: '127.0.0.1,localhost', http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' };
// Run the monitor via async spawn (NOT execFileSync) so this process's event loop
// stays free to answer the mock webhook POST while the monitor runs.
const runMonitor = () => new Promise((resolve) => {
  const p = spawn('bash', [MONITOR], { env: { ...process.env, ...MENV }, stdio: 'ignore' });
  p.on('close', (code) => resolve(code));
});
const spawnGateway = () => spawn(process.execPath, ['src/server.js'], {
  cwd: GATEWAY, env: { ...process.env, MOCK_AI: '1', PORT: GW_PORT, WALLET_STORE: '/tmp/nf-drill-wallets.json', WALLET_STORE_KEY: 'cd'.repeat(32) }, stdio: 'ignore',
});
const waitHealthy = async (ok, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(HEALTH, { signal: AbortSignal.timeout(1500) }); if (ok && r.ok) return true; if (!ok) { /* keep trying until it stops */ } }
    catch { if (!ok) return true; }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
const kill = (c) => new Promise((r) => { if (!c || c.killed) return r(); c.on('close', () => r()); try { c.kill('SIGKILL'); } catch { r(); } });

// ---- 1) baseline: service healthy → monitor OK, no alert (up->up) ----
console.log('— baseline: healthy service raises no alert —');
let gw = spawnGateway();
await waitHealthy(true);
let code = await runMonitor();
check('monitor exits 0 against a healthy service', code === 0, `code=${code}`);
check('no alert fired while healthy', alerts.length === 0, `alerts=${alerts.length}`);

// ---- 2) INJECT FAILURE: kill the gateway → monitor fires DOWN ----
console.log('— inject failure: kill the gateway —');
await kill(gw);
await waitHealthy(false);
code = await runMonitor();
check('monitor exits non-zero when the service is down', code !== 0, `code=${code}`);
check('a DOWN alert was sent to the webhook', alerts.some((a) => /DOWN/.test(a)), JSON.stringify(alerts));

// ---- 3) de-dup: still down → no second DOWN alert ----
console.log('— de-dup: still down raises no repeat alert —');
const downCount = alerts.filter((a) => /DOWN/.test(a)).length;
await runMonitor();
check('no duplicate DOWN alert on the next tick', alerts.filter((a) => /DOWN/.test(a)).length === downCount, `down alerts now ${alerts.filter((a) => /DOWN/.test(a)).length}`);

// ---- 4) RECOVER: restart the gateway → monitor fires RECOVERED ----
console.log('— recover: bring the service back —');
gw = spawnGateway();
await waitHealthy(true);
code = await runMonitor();
check('monitor exits 0 once healthy again', code === 0, `code=${code}`);
check('a RECOVERED alert was sent', alerts.some((a) => /RECOVERED/.test(a)), JSON.stringify(alerts));

await kill(gw);
hookSrv.close();
console.log(failures === 0 ? '\nDRILL: all checks passed — watchdog detects outage, alerts, de-dups, recovers.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
