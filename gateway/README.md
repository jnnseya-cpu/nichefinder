# Niche Finder — AI Gateway

A unified gateway that gives the Niche Finder OS a single interface over three AI providers — **Claude** (Anthropic), **Gemini** (Google), and **OpenAI** — with automatic failover, ACU cost metering, and structured-output support.

## Why a gateway

- **One request shape** for every venture-intelligence action (niche discovery, deep-dive analysis, financial forecasting), regardless of provider.
- **Failover** — a rate limit or outage on one provider transparently retries the next in the chain (`claude → gemini → openai` by default).
- **ACU metering** — every response carries the Application Credit Units it consumed, including the +40% Investor Production Mode multiplier, so billing matches the product's "you see the cost before you commit" promise (`/v1/estimate`).
- **Structured outputs** — pass a JSON schema and it maps to each provider's native structured-output mechanism (Claude `output_config.format`, Gemini `responseSchema`, OpenAI `response_format`).

## Quick start

```bash
cd gateway
npm install

# development, no API keys needed
npm run dev            # boots on :8787 with the mock provider

# production
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=...
export OPENAI_API_KEY=sk-...
npm start
```

Run the keyless test suite: `npm test`

## API

### `POST /v1/generate`

```json
{
  "provider": "auto",
  "system": "You are a world-class venture analyst.",
  "messages": [{ "role": "user", "content": "Generate 3 niche ideas for agribusiness in Kinshasa under $10k." }],
  "maxTokens": 16000,
  "jsonSchema": { "type": "object", "properties": { "niches": { "type": "array" } }, "required": ["niches"], "additionalProperties": false },
  "investorMode": false
}
```

Response:

```json
{
  "provider": "claude",
  "model": "claude-opus-4-8",
  "text": "{\"niches\": [...]}",
  "stopReason": "end_turn",
  "usage": { "inputTokens": 812, "outputTokens": 1490 },
  "acu": 5,
  "latencyMs": 4210
}
```

- `provider`: `"claude"`, `"gemini"`, `"openai"`, or `"auto"` (default — walks the failover chain).
- `investorMode: true` applies the +40% ACU multiplier (Investor Production Mode).
- Failed-over requests include an `attempts` array showing which providers were tried.

### `POST /v1/estimate`
Same body shape; returns `estimatedAcu` without calling any model — for showing the cost before the user commits.

### `GET /v1/health` · `GET /v1/models`
Liveness, configured providers, and the active model per provider.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | — | Provider credentials; a provider without a key is skipped |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Claude model (adaptive thinking always on) |
| `GEMINI_MODEL` | `gemini-2.5-pro` | Gemini model |
| `OPENAI_MODEL` | `gpt-5.1` | OpenAI model |
| `AI_FALLBACK_CHAIN` | `claude,gemini,openai` | Failover order for `provider: "auto"` |
| `ACU_CLAUDE_IN/OUT` etc. | see `src/config.js` | ACU rates per 1K tokens per provider |
| `MOCK_AI` | — | `1` = keyless mock provider (dev/CI) |
| `PORT` | `8787` | Listen port |

## Notes

- Claude requests always run with adaptive thinking and handle the `refusal` stop reason explicitly (surfaced as HTTP 422 `refusal`, never retried).
- Requests with `maxTokens` above 16K automatically stream upstream to avoid HTTP timeouts, while the gateway still returns a single JSON response.
- Retryable failures are 429/5xx/network only; auth and validation errors surface immediately without failover.
