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
const { meterAcu } = await import('../src/router.js');
check('claude 10k-in/2k-out meters correctly', meterAcu('claude', { inputTokens: 10000, outputTokens: 2000 }) === 10);
check('investor mode adds 40%', meterAcu('claude', { inputTokens: 10000, outputTokens: 2000 }, true) === 14);
check('minimum charge applies', meterAcu('gemini', { inputTokens: 10, outputTokens: 10 }) === 1);

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
