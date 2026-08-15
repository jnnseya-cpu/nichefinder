// Central configuration for the AI gateway. Every value is overridable via
// environment variables so deployments can tune models and pricing without
// code changes.

export const config = {
  port: Number(process.env.PORT || 8787),

  // Ordered failover chain. A retryable failure (429 / 5xx / network) on one
  // provider moves the request to the next. Non-retryable failures (bad
  // request, auth, refusal) surface immediately.
  fallbackChain: (process.env.AI_FALLBACK_CHAIN || 'claude,gemini,openai')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  providers: {
    claude: {
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    },
    gemini: {
      apiKeyEnv: 'GEMINI_API_KEY',
      model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
    },
    openai: {
      apiKeyEnv: 'OPENAI_API_KEY',
      model: process.env.OPENAI_MODEL || 'gpt-5.1',
    },
  },

  // ACU metering: Application Credit Units consumed per 1K tokens, by
  // provider. Output tokens are weighted heavier than input, mirroring
  // upstream pricing shape. Investor Production Mode multiplies the final
  // ACU cost by 1.4 (the +40% shown in the Search Canvas).
  acu: {
    ratesPer1K: {
      claude: { input: Number(process.env.ACU_CLAUDE_IN || 0.5), output: Number(process.env.ACU_CLAUDE_OUT || 2.5) },
      gemini: { input: Number(process.env.ACU_GEMINI_IN || 0.15), output: Number(process.env.ACU_GEMINI_OUT || 1.0) },
      openai: { input: Number(process.env.ACU_OPENAI_IN || 0.25), output: Number(process.env.ACU_OPENAI_OUT || 1.5) },
      mock: { input: 0, output: 0 },
    },
    investorModeMultiplier: 1.4,
    minimumCharge: Number(process.env.ACU_MINIMUM || 1),
    // Raw upstream provider cost in GBP per 1K tokens (approximate list
    // prices; override per deployment). Used by the fully-loaded profit
    // floor — never shown to users, never below-priced.
    rawCostGBPPer1K: {
      claude: { input: Number(process.env.RAW_CLAUDE_IN || 0.0024), output: Number(process.env.RAW_CLAUDE_OUT || 0.012) },
      gemini: { input: Number(process.env.RAW_GEMINI_IN || 0.0008), output: Number(process.env.RAW_GEMINI_OUT || 0.004) },
      openai: { input: Number(process.env.RAW_OPENAI_IN || 0.0016), output: Number(process.env.RAW_OPENAI_OUT || 0.008) },
      mock: { input: 0, output: 0 },
    },
  },

  defaults: {
    // Deep venture analysis runs adaptive thinking at high effort: the thinking
    // budget plus the structured JSON output must both fit under max_tokens.
    // 16k was too tight for xhigh/max reasoning — give the model real headroom.
    maxTokens: Number(process.env.AI_MAX_TOKENS || 32000),
    streamThreshold: 8000, // above this, upstream calls always stream
  },

  mock: process.env.MOCK_AI === '1',
};

export function apiKeyFor(provider) {
  const envName = config.providers[provider]?.apiKeyEnv;
  return envName ? process.env[envName] : undefined;
}
