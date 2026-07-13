import http from 'node:http';
import { config } from './config.js';
import { GatewayError } from './errors.js';
import { route, availableProviders, meterAcu } from './router.js';
import { getWallet, getLedger, charge, credit, PACKAGES } from './wallet.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new GatewayError('Request body too large (2 MB limit).', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/v1/health') {
    return json(res, 200, {
      status: 'ok',
      mock: config.mock,
      providers: availableProviders(),
      fallbackChain: config.fallbackChain,
    });
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, {
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([name, p]) => [name, { model: p.model, configured: Boolean(process.env[p.apiKeyEnv]) }]),
      ),
    });
  }

  // Pre-flight cost estimate for the "every paid action displays its ACU cost
  // before you commit" product rule. Rough character-based token estimate.
  if (req.method === 'POST' && url.pathname === '/v1/estimate') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const chars = JSON.stringify(body.messages || '') .length + (body.system?.length || 0);
      const usage = { inputTokens: Math.ceil(chars / 4), outputTokens: body.expectedOutputTokens || 2000 };
      const provider = body.provider && body.provider !== 'auto' ? body.provider : availableProviders()[0] || 'claude';
      return json(res, 200, { provider, estimatedAcu: meterAcu(provider, usage, body.investorMode === true, body.capitalGBP), usage });
    } catch (err) {
      return handleError(res, err);
    }
  }

  // ---- P0 wallet: server-side ACU system of record ----
  if (req.method === 'GET' && url.pathname === '/v1/wallet') {
    try {
      return json(res, 200, getWallet(url.searchParams.get('user')));
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'GET' && url.pathname === '/v1/wallet/ledger') {
    try {
      return json(res, 200, { ledger: getLedger(url.searchParams.get('user'), url.searchParams.get('limit')) });
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'GET' && url.pathname === '/v1/wallet/packages') {
    return json(res, 200, { packages: PACKAGES });
  }

  if (req.method === 'POST' && (url.pathname === '/v1/wallet/charge' || url.pathname === '/v1/wallet/credit')) {
    try {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        throw new GatewayError('Body must be valid JSON.', { status: 400, code: 'invalid_json' });
      }
      body.idempotencyKey = body.idempotencyKey || req.headers['idempotency-key'];
      const result = url.pathname.endsWith('charge') ? charge(body) : credit(body);
      return json(res, 200, result);
    } catch (err) { return handleError(res, err); }
  }

  if (req.method === 'POST' && url.pathname === '/v1/generate') {
    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        throw new GatewayError('Body must be valid JSON.', { status: 400, code: 'invalid_json' });
      }
      const started = Date.now();
      const result = await route(body);
      return json(res, 200, { ...result, latencyMs: Date.now() - started });
    } catch (err) {
      return handleError(res, err);
    }
  }

  return json(res, 404, { error: 'not_found', message: `No route for ${req.method} ${url.pathname}` });
});

function handleError(res, err) {
  if (err instanceof GatewayError) {
    return json(res, err.status >= 400 && err.status < 600 ? err.status : 502, { ...err.toJSON(), attempts: err.attempts });
  }
  console.error('[gateway] unhandled error:', err);
  return json(res, 500, { error: 'internal_error', message: 'Unexpected gateway error.' });
}

server.listen(config.port, () => {
  console.log(`[gateway] listening on :${config.port} (mock=${config.mock}) providers=${availableProviders().join(',') || 'none'}`);
});
