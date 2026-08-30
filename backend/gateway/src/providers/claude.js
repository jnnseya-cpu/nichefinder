import Anthropic from '@anthropic-ai/sdk';
import { config, apiKeyFor } from '../config.js';
import { GatewayError } from '../errors.js';

let client;
function getClient() {
  if (!client) {
    client = new Anthropic({
      apiKey: apiKeyFor('claude'),
      // Bound the wait: if the deep call runs long, time out and let the router
      // fail over to the next (faster) provider rather than hanging the request.
      // A timeout surfaces as APIConnectionError → retryable → failover.
      timeout: Number(process.env.CLAUDE_TIMEOUT_MS || 200000),
      maxRetries: 1,
    });
  }
  return client;
}

// Build the full request params. Adaptive thinking is enabled for every call;
// venture analysis is exactly the kind of multi-step reasoning it exists for.
// Structured-output requests use output_config.format so the response validates
// against the caller's schema.
export function buildParams(req, { dropThinking = false, dropOutputConfig = false, dropSchema = false } = {}) {
  const model = req.model || config.providers.claude.model;
  const maxTokens = req.maxTokens || config.defaults.maxTokens;
  const params = {
    model,
    max_tokens: maxTokens,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (!dropThinking) params.thinking = { type: 'adaptive' };
  if (!dropOutputConfig) {
    params.output_config = { effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(req.effort) ? req.effort : 'high' };
    if (req.jsonSchema && !dropSchema) params.output_config.format = { type: 'json_schema', schema: req.jsonSchema };
  }
  return params;
}

// Decide which advanced param a 400 is complaining about, so we can strip
// exactly that field and retry rather than blindly discarding everything. A
// generic 400 (no field named) drops all advanced params in one step.
export function degradeFor(err, tried) {
  if (!(err instanceof Anthropic.BadRequestError)) return null;
  const msg = String(err?.message || '').toLowerCase();
  const opts = {};
  let matched = false;
  if (/thinking/.test(msg) && !tried.dropThinking) { opts.dropThinking = true; matched = true; }
  if (/(output_config|effort|format|schema|structured)/.test(msg) && !tried.dropOutputConfig) { opts.dropOutputConfig = true; matched = true; }
  if (matched) return { ...tried, ...opts };
  // Unattributed 400: strip every advanced param at once (last resort before
  // giving up on this provider) — but only if we haven't already.
  if (!tried.dropThinking || !tried.dropOutputConfig) return { dropThinking: true, dropOutputConfig: true };
  return null;
}

// Unified request → Anthropic Messages API, with self-healing param degradation.
// The live API or a specific model/account may reject an advanced param
// (adaptive thinking, effort, structured-output schema). Rather than hard-fail
// the whole request (and the user's paid run), we strip the offending param and
// retry with a simpler shape, logging every step. Only genuine failures
// (auth, connection, 5xx, refusal, an irreducible 400) reach the router.
export async function generate(req) {
  let opts = {};
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    const params = buildParams(req, opts);
    const shape = `thinking=${params.thinking ? 'adaptive' : 'off'} effort=${params.output_config?.effort || 'off'} schema=${params.output_config?.format ? 'yes' : req.jsonSchema ? 'dropped' : 'no'}`;
    console.log(`[claude] start attempt=${attempt} model=${params.model} ${shape} maxTokens=${params.max_tokens}`);
    let response;
    try {
      // Always stream. Deep venture analysis (adaptive thinking at high effort)
      // can run for minutes and emit tens of thousands of tokens; a non-streaming
      // request risks HTTP/idle timeouts on long runs. finalMessage() reassembles
      // the complete message either way.
      const stream = getClient().messages.stream(params);
      response = await stream.finalMessage();
      console.log(`[claude] ok attempt=${attempt} model=${response.model} latencyMs=${Date.now() - t0} outTokens=${response.usage?.output_tokens ?? '?'} stop=${response.stop_reason}`);
    } catch (err) {
      // Provider failures must never vanish: surface the real upstream reason to
      // the logs so we can diagnose 4xx rejections (the client only sees a
      // sanitized message). No secrets are logged — only status/type/message.
      console.error(
        `[claude] generate failed attempt=${attempt}: status=${err?.status ?? '?'} type=${err?.error?.type || err?.name || '?'} model=${params.model} ${shape} :: ${err?.message || err}`,
      );
      const next = degradeFor(err, opts);
      if (next) {
        console.warn(`[claude] retrying with reduced params: ${JSON.stringify(next)}`);
        opts = next;
        continue;
      }
      throw normalize(err);
    }
    return finish(response);
  }
}

function finish(response) {
  if (response.stop_reason === 'refusal') {
    throw new GatewayError('The model declined this request for safety reasons.', {
      provider: 'claude',
      status: 422,
      code: 'refusal',
      retryable: false,
    });
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    provider: 'claude',
    model: response.model,
    text,
    stopReason: response.stop_reason,
    usage: {
      inputTokens: response.usage.input_tokens +
        (response.usage.cache_read_input_tokens || 0) +
        (response.usage.cache_creation_input_tokens || 0),
      outputTokens: response.usage.output_tokens,
    },
  };
}

function normalize(err) {
  if (err instanceof Anthropic.RateLimitError) {
    return new GatewayError('Claude rate limited.', { provider: 'claude', status: 429, code: 'rate_limited', retryable: true });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new GatewayError('Claude API key invalid or missing.', { provider: 'claude', status: 401, code: 'auth_error', retryable: false });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new GatewayError('Could not reach the Claude API.', { provider: 'claude', status: 503, code: 'connection_error', retryable: true });
  }
  if (err instanceof Anthropic.APIError) {
    return new GatewayError(err.message, {
      provider: 'claude',
      status: err.status || 500,
      code: 'api_error',
      retryable: (err.status || 500) >= 500,
    });
  }
  return new GatewayError(err.message || 'Unknown Claude error.', { provider: 'claude', retryable: true });
}
