import { GoogleGenAI } from '@google/genai';
import { config, apiKeyFor } from '../config.js';
import { GatewayError, classifyStatus } from '../errors.js';

let client;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: apiKeyFor('gemini') });
  return client;
}

export async function generate(req) {
  const model = req.model || config.providers.gemini.model;

  // Map the unified messages shape to Gemini's contents format.
  const contents = req.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));

  const generationConfig = {
    maxOutputTokens: req.maxTokens || config.defaults.maxTokens,
  };
  if (req.system) generationConfig.systemInstruction = req.system;
  if (req.jsonSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = req.jsonSchema;
  }

  let response;
  try {
    response = await getClient().models.generateContent({
      model,
      contents,
      config: generationConfig,
    });
  } catch (err) {
    throw normalize(err);
  }

  const usage = response.usageMetadata || {};
  return {
    provider: 'gemini',
    model,
    text: response.text ?? '',
    stopReason: response.candidates?.[0]?.finishReason?.toLowerCase() || 'stop',
    usage: {
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    },
  };
}

function normalize(err) {
  const status = err.status || err.code || 500;
  const numeric = Number(status) || 500;
  return new GatewayError(err.message || 'Unknown Gemini error.', {
    provider: 'gemini',
    status: numeric,
    code: numeric === 429 ? 'rate_limited' : numeric === 401 || numeric === 403 ? 'auth_error' : 'api_error',
    retryable: classifyStatus(numeric),
  });
}
