
---

## Root cause of "0 results / Discovery temporarily unavailable"

The flagship discovery call (`search.html` → `/v1/generate`) sent **no output-
token budget**, so the server reserved and capped the provider at the small
plain-chat default (2000). Adaptive thinking at `high` effort consumes much of
that budget *before* any output, and discovery demands 3 fully-structured
niches (scores, 3-year financials, risks, roadmap, an 11-field brief each). The
response hit `max_tokens`, returned **truncated JSON**, and the client's parse
failed — showing "Discovery is temporarily unavailable" every time.

Fixed:

- Structured requests (a `jsonSchema` is present) now default to
  `STRUCTURED_DEFAULT_OUTPUT` (12000) instead of 2000.
- The hard ceiling `MAX_GEN_OUTPUT` is 16000 (was 8000), matching the documented
  design and un-truncating the deep-dive documents too. Both are env-overridable
  (raise `MAX_GEN_OUTPUT` toward 24000 if the largest GTM doc still truncates).
- The provider logs `OUTPUT TRUNCATED at max_tokens` whenever it happens, and
  `/v1/admin/diag` reports `generation.maxOutputTokens` / `structuredDefaultTokens`.
- The client sends an explicit `maxTokens: 16000`, parses defensively (extracts
  the outermost JSON object, errors clearly on an empty result), and surfaces the
  gateway's real status + message to the console.

The reservation is still the billing basis (metered cost ≤ reserved, released on
failure), so a bigger budget raises only the *hold*, never the final charge.
