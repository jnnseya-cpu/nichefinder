import OpenAI from 'openai';
import { config, apiKeyFor } from '../config.js';
import { GatewayError, classifyStatus } from '../errors.js';

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: apiKeyFor('openai') });
  return client;
}

export async function generate(req) {
  const model = req.model || config.providers.openai.model;

  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    messages.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
  }

  const params = {
    model,
    messages,
    max_completion_tokens: req.maxTokens || config.defaults.maxTokens,
  };
  if (req.effort && /^(gpt-5|o\d)/.test(model)) {
    // reasoning models accept low|medium|high; clamp our wider scale
    params.reasoning_effort = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort;
  }
  if (req.jsonSchema) {
    params.response_format = {
      type: 'json_schema',
      json_schema: { name: 'gateway_output', schema: req.jsonSchema, strict: true },
    };
  }

  let response;
  try {
    response = await getClient().chat.completions.create(params);
  } catch (err) {
    throw normalize(err);
  }

  const choice = response.choices?.[0];
  return {
    provider: 'openai',
    model: response.model,
    text: choice?.message?.content ?? '',
    stopReason: choice?.finish_reason || 'stop',
    usage: {
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
    },
  };
}

function normalize(err) {
  const status = err.status || 500;
  return new GatewayError(err.message || 'Unknown OpenAI error.', {
    provider: 'openai',
    status,
    code: status === 429 ? 'rate_limited' : status === 401 ? 'auth_error' : 'api_error',
    retryable: classifyStatus(status),
  });
}
