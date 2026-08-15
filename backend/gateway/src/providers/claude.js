import Anthropic from '@anthropic-ai/sdk';
import { config, apiKeyFor } from '../config.js';
import { GatewayError } from '../errors.js';

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: apiKeyFor('claude') });
  return client;
}

// Unified request → Anthropic Messages API. Adaptive thinking is enabled for
// every call; venture analysis is exactly the kind of multi-step reasoning it
// exists for. Structured output requests use output_config.format so the
// response is guaranteed to validate against the caller's schema.
export async function generate(req) {
  const model = req.model || config.providers.claude.model;
  const maxTokens = req.maxTokens || config.defaults.maxTokens;

  const params = {
    model,
    max_tokens: maxTokens,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    thinking: { type: 'adaptive' },
    // Deep reasoning by default: venture analysis quality tracks effort.
    output_config: { effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(req.effort) ? req.effort : 'high' },
  };
  if (req.jsonSchema) {
    params.output_config.format = { type: 'json_schema', schema: req.jsonSchema };
  }

  let response;
  const t0 = Date.now();
  console.log(`[claude] start model=${model} effort=${params.output_config.effort} maxTokens=${maxTokens} schema=${req.jsonSchema ? 'yes' : 'no'}`);
  try {
    // Always stream. Deep venture analysis (adaptive thinking at high effort)
    // can run for minutes and emit tens of thousands of tokens; a non-streaming
    // request risks HTTP/idle timeouts on long runs. finalMessage() reassembles
    // the complete message either way.
    const stream = getClient().messages.stream(params);
    response = await stream.finalMessage();
    console.log(`[claude] ok model=${response.model} latencyMs=${Date.now() - t0} outTokens=${response.usage?.output_tokens ?? '?'} stop=${response.stop_reason}`);
  } catch (err) {
    // Provider failures must never vanish: surface the real upstream reason to
    // the logs so we can diagnose 4xx rejections (the client only sees a
    // sanitized message). No secrets are logged — only status/type/message.
    console.error(
      `[claude] generate failed: status=${err?.status ?? '?'} type=${err?.error?.type || err?.name || '?'} model=${model} effort=${params.output_config.effort} maxTokens=${maxTokens} schema=${req.jsonSchema ? 'yes' : 'no'} :: ${err?.message || err}`,
    );
    throw normalize(err);
  }

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
