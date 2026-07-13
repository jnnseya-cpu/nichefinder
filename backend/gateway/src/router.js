import { config, apiKeyFor } from './config.js';
import { GatewayError } from './errors.js';
import * as claude from './providers/claude.js';
import * as gemini from './providers/gemini.js';
import * as openai from './providers/openai.js';
import * as mock from './providers/mock.js';
import '../../../shared/nf-economy.js'; // canonical economy → globalThis.NF_ECONOMY

const PROVIDERS = { claude, gemini, openai, mock };

export function availableProviders() {
  if (config.mock) return ['mock'];
  return config.fallbackChain.filter((p) => Boolean(apiKeyFor(p)));
}

// Resolve which providers to try, in order. An explicit provider pins the
// request to that provider only; "auto" (or omitted) walks the configured
// fallback chain, skipping providers with no API key configured.
function resolveChain(requested) {
  if (requested && requested !== 'auto' && !PROVIDERS[requested]) {
    throw new GatewayError(`Unknown provider "${requested}". Valid: claude, gemini, openai, auto.`, {
      status: 400,
      code: 'invalid_request',
    });
  }
  if (config.mock) return ['mock'];
  if (requested && requested !== 'auto') {
    return [requested];
  }
  const chain = availableProviders();
  if (chain.length === 0) {
    throw new GatewayError(
      'No AI provider is configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY (or MOCK_AI=1 for development).',
      { status: 503, code: 'no_provider', retryable: false },
    );
  }
  return chain;
}

/* Capital-bracket pricing: the base ACU rates embody the 3x-10x margin band
   over provider cost for the standard <= £10k class (bracket 1). Every £10k
   bracket above doubles the band — £10,001-£20k is 6x-20x (factor 2),
   £20,001-£30k is 12x-40x (factor 4), and so on: factor = 2^(bracket - 1). */
export function bracketFactor(capitalGBP) {
  // Single source of truth: shared/nf-economy.js — the same law the client enforces.
  return globalThis.NF_ECONOMY.bracketFor(capitalGBP).factor;
}

export function meterAcu(provider, usage, investorMode = false, capitalGBP = 0) {
  const rates = config.acu.ratesPer1K[provider] || config.acu.ratesPer1K.claude;
  let acu = (usage.inputTokens / 1000) * rates.input + (usage.outputTokens / 1000) * rates.output;
  if (investorMode) acu *= config.acu.investorModeMultiplier;
  acu *= bracketFactor(capitalGBP);
  if (rates.input === 0 && rates.output === 0) return 0;
  return Math.max(config.acu.minimumCharge, Math.ceil(acu));
}

export async function route(req) {
  validate(req);
  const chain = resolveChain(req.provider);
  const attempts = [];

  for (const name of chain) {
    try {
      const result = await PROVIDERS[name].generate(req);
      return {
        ...result,
        acu: meterAcu(result.provider, result.usage, req.investorMode === true, req.capitalGBP),
        bracketFactor: bracketFactor(req.capitalGBP),
        attempts: attempts.length ? attempts : undefined,
      };
    } catch (err) {
      const gwErr = err instanceof GatewayError ? err : new GatewayError(err.message, { provider: name });
      attempts.push({ provider: name, error: gwErr.code, message: gwErr.message });
      const isLast = name === chain[chain.length - 1];
      if (!gwErr.retryable || isLast) {
        gwErr.attempts = attempts;
        throw gwErr;
      }
      // retryable and more providers remain — fail over to the next one
    }
  }
}

function validate(req) {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new GatewayError('"messages" must be a non-empty array of {role, content}.', {
      status: 400,
      code: 'invalid_request',
    });
  }
  for (const m of req.messages) {
    if (!m || !['user', 'assistant'].includes(m.role) || m.content == null) {
      throw new GatewayError('Each message needs role "user" or "assistant" and content.', {
        status: 400,
        code: 'invalid_request',
      });
    }
  }
  if (req.maxTokens != null && (!Number.isInteger(req.maxTokens) || req.maxTokens < 1 || req.maxTokens > 128000)) {
    throw new GatewayError('"maxTokens" must be an integer between 1 and 128000.', {
      status: 400,
      code: 'invalid_request',
    });
  }
}
