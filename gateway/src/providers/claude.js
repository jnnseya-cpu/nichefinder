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
  };
  if (req.jsonSchema) {
    params.output_config = { format: { type: 'json_schema', schema: req.jsonSchema } };
  }

  let response;
  try {
    if (maxTokens > config.defaults.streamThreshold) {
      const stream = getClient().messages.stream(params);
      response = await stream.finalMessage();
    } else {
      response = await getClient().messages.create(params);
    }
  } catch (err) {
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
