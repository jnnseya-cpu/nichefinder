// CONNECTOR test — the uniform third-party connector wrapper.
// Proves: success passthrough; timeout; retry-with-backoff on retryable errors;
// no auto-retry for non-idempotent ops; circuit breaker opens after N failures
// then fails fast; telemetry/stats are accurate. No network, pure timing.
import { makeConnector, ConnectorError, registerConnector, connectorHealth } from '../src/connector.js';

let failures = 0;
const check = (name, cond, detail = '') => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('— success passthrough + telemetry —');
let c = makeConnector('ok', { timeoutMs: 500 });
let r = await c.call(async () => 42, { idempotent: true });
check('returns the fn result', r === 42);
let s = c.stats();
check('stats count a success', s.calls === 1 && s.successes === 1 && s.failures === 0, JSON.stringify(s));
check('success rate 1.0, breaker closed', s.successRate === 1 && s.open === false);

console.log('— timeout aborts and is reported —');
c = makeConnector('slow', { timeoutMs: 100, retries: 0 });
let caught = null;
try { await c.call((signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))), { idempotent: true }); }
catch (e) { caught = e; }
check('timeout throws ConnectorError code=timeout', caught instanceof ConnectorError && caught.code === 'timeout', caught && caught.code);
check('timeout recorded as a failure', c.stats().failures === 1);

console.log('— retry-with-backoff on retryable errors (idempotent) —');
let attempts = 0;
c = makeConnector('flaky', { timeoutMs: 500, retries: 2, baseBackoffMs: 10, maxBackoffMs: 20 });
r = await c.call(async () => { attempts += 1; if (attempts < 3) { const e = new Error('503'); e.status = 503; throw e; } return 'recovered'; }, { idempotent: true });
check('retries a 5xx until it succeeds', r === 'recovered' && attempts === 3, 'attempts=' + attempts);
check('retry count tracked', c.stats().retries === 2, JSON.stringify(c.stats()));

console.log('— non-idempotent ops are NEVER auto-retried —');
attempts = 0;
c = makeConnector('write', { timeoutMs: 500, retries: 3, baseBackoffMs: 1 });
try { await c.call(async () => { attempts += 1; const e = new Error('503'); e.status = 503; throw e; }, { idempotent: false }); } catch {}
check('a non-idempotent op runs exactly once even on a retryable error', attempts === 1, 'attempts=' + attempts);

console.log('— non-retryable errors are not retried —');
attempts = 0;
c = makeConnector('bad', { timeoutMs: 500, retries: 3, baseBackoffMs: 1 });
try { await c.call(async () => { attempts += 1; const e = new Error('400'); e.status = 400; throw e; }, { idempotent: true }); } catch {}
check('a 4xx (non-retryable) is not retried', attempts === 1, 'attempts=' + attempts);

console.log('— circuit breaker opens after threshold, then fails fast —');
c = makeConnector('dead', { timeoutMs: 200, retries: 0, breakerThreshold: 3, breakerCooldownMs: 100 });
for (let i = 0; i < 3; i++) { try { await c.call(async () => { const e = new Error('ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }, { idempotent: true }); } catch {} }
check('breaker is open after 3 consecutive failures', c.stats().open === true, JSON.stringify(c.stats()));
let fast = null;
try { await c.call(async () => 'should not run', { idempotent: true }); } catch (e) { fast = e; }
check('open breaker fails fast with circuit_open', fast instanceof ConnectorError && fast.code === 'circuit_open', fast && fast.code);
await sleep(120);
r = await c.call(async () => 'back', { idempotent: true });
check('breaker half-opens after cooldown and recovers', r === 'back' && c.stats().open === false);

console.log('— registry health board —');
registerConnector('reg-a', { timeoutMs: 100 });
registerConnector('reg-b', { timeoutMs: 100 });
const health = connectorHealth();
check('registry enumerates connector stats', health.some((h) => h.connector === 'reg-a') && health.some((h) => h.connector === 'reg-b'), JSON.stringify(health.map((h) => h.connector)));

console.log(failures === 0 ? '\nCONNECTOR: all checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures ? 1 : 0);
