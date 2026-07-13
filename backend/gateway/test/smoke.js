// Keyless smoke test: boots the server in mock mode and exercises every
// endpoint plus router validation and ACU metering. Run: npm test

process.env.MOCK_AI = '1';
process.env.PORT = process.env.PORT || '18787';

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let failures = 0;

function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300));

// health
let res = await fetch(`${BASE}/v1/health`);
let body = await res.json();
check('health returns ok', res.status === 200 && body.status === 'ok');
check('mock provider active', body.providers.includes('mock'));

// models
res = await fetch(`${BASE}/v1/models`);
body = await res.json();
check('models lists all three providers', ['claude', 'gemini', 'openai'].every((p) => p in body.providers));
check('claude default model pinned', body.providers.claude.model === 'claude-opus-4-8');

// generate
res = await fetch(`${BASE}/v1/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    system: 'You are a venture analyst.',
    messages: [{ role: 'user', content: 'Find niches in Kinshasa agribusiness under $10k.' }],
  }),
});
body = await res.json();
check('generate succeeds', res.status === 200, JSON.stringify(body));
check('generate returns text', typeof body.text === 'string' && body.text.includes('Kinshasa'));
check('generate reports usage', body.usage.inputTokens > 0 && body.usage.outputTokens > 0);
check('generate meters ACU', typeof body.acu === 'number');

// structured output passthrough
res = await fetch(`${BASE}/v1/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'score this niche' }],
    jsonSchema: { type: 'object', properties: { mock: { type: 'boolean' } }, required: ['mock'], additionalProperties: false },
  }),
});
body = await res.json();
check('json schema request returns parseable JSON', (() => { try { return JSON.parse(body.text).mock === true; } catch { return false; } })());

// validation
res = await fetch(`${BASE}/v1/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [] }),
});
check('empty messages rejected with 400', res.status === 400);

res = await fetch(`${BASE}/v1/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], provider: 'nonsense' }),
});
check('unknown provider rejected with 400', res.status === 400);

// estimate
res = await fetch(`${BASE}/v1/estimate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'estimate me' }], investorMode: true }),
});
body = await res.json();
check('estimate returns ACU number', res.status === 200 && typeof body.estimatedAcu === 'number');

// ACU metering math (direct unit check)
const { meterAcu, bracketFactor } = await import('../src/router.js');
check('claude 10k-in/2k-out meters correctly', meterAcu('claude', { inputTokens: 10000, outputTokens: 2000 }) === 10);
check('investor mode adds 40%', meterAcu('claude', { inputTokens: 10000, outputTokens: 2000 }, true) === 14);
check('minimum charge applies', meterAcu('gemini', { inputTokens: 10, outputTokens: 10 }) === 1);

// capital-bracket pricing: band doubles per £10k bracket
check('bracket 1 (≤£10k) factor is 1', bracketFactor(10000) === 1 && bracketFactor(0) === 1 && bracketFactor(undefined) === 1);
check('bracket 2 (£10,001–£20k) factor is 2', bracketFactor(10001) === 2 && bracketFactor(20000) === 2);
check('bracket 3 (£20,001–£30k) factor is 4', bracketFactor(25000) === 4);
check('bracket 5 (£45k) factor is 16', bracketFactor(45000) === 16);
check('bracket factor caps at 1024', bracketFactor(500000) === 1024);
check('meterAcu doubles in bracket 2', meterAcu('claude', { inputTokens: 10000, outputTokens: 2000 }, false, 15000) === 20);
check('investor mode stacks on bracket', meterAcu('claude', { inputTokens: 10000, outputTokens: 2000 }, true, 15000) === 28);

// shared economy module: gateway and client enforce identical constants
const ECONOMY = globalThis.NF_ECONOMY;
check('shared economy loaded', ECONOMY && ECONOMY.PACKAGES.length === 4 && ECONOMY.COSTS.niche_search === 125);
check('gateway bracket law delegates to shared module', bracketFactor(45000) === ECONOMY.bracketFor(45000).factor);

// encryption at rest (E2EE law): AES-256-GCM roundtrip + tamper evidence
const { encryptStore, decryptStore } = await import('../src/wallet.js');
const testKey = Buffer.from('a'.repeat(64), 'hex');
const envelope = encryptStore('{"wallets":{"u1":{"paid":500}}}', testKey);
check('store encrypts to NFE1 envelope', envelope.startsWith('NFE1:'));
check('store decrypts to original JSON', decryptStore(envelope, testKey) === '{"wallets":{"u1":{"paid":500}}}');
let tampered = false;
try { decryptStore(envelope.slice(0, -8) + 'AAAAAAAA', testKey); } catch { tampered = true; }
check('tampered ciphertext is rejected (GCM auth)', tampered);

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
