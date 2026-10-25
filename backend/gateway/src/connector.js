/* ============================================================================
   Niche Finder — uniform third-party connector wrapper.

   The connector-registry pattern from docs/AI-OS-ARCHITECTURE.md §8, made real:
   every outbound integration call (KYC, CRM, enrichment, comms, maps, …) runs
   through one wrapper that provides, uniformly:
     • timeout (AbortController)                — no call hangs the request path
     • retry with exponential backoff + jitter  — only for idempotent/retryable ops
     • circuit breaker (per connector)          — stop hammering a dead dependency
     • cost / latency / success telemetry        — feeds the API-Integration health board

   Deliberately NOT used by the money path: Stripe/KODA/BitriPay keep their own
   tuned error semantics (a payment retry is never "safe" to assume idempotent
   without the provider's idempotency key). This wrapper is for the many
   read/enrich/notify connectors where a jittered retry + breaker is correct.

   Zero dependencies; pure Node. Usage:

     import { makeConnector } from './connector.js';
     const sumsub = makeConnector('sumsub', { timeoutMs: 8000, retries: 2 });
     const res = await sumsub.call(() => fetch(url, opts), { idempotent: true });
     sumsub.stats(); // { calls, failures, open, p50, p95, lastError, ... }
   ============================================================================ */

export class ConnectorError extends Error {
  constructor(message, { connector, code = 'connector_error', retryable = false, cause } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.connector = connector;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const DEFAULTS = {
  timeoutMs: 10000,
  retries: 2,              // total attempts = retries + 1
  baseBackoffMs: 200,
  maxBackoffMs: 4000,
  breakerThreshold: 5,     // consecutive failures before opening
  breakerCooldownMs: 30000,
  sampleWindow: 200,       // latency samples kept for percentiles
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Full-jitter backoff (AWS "Exponential Backoff and Jitter"): random in [0, cap].
function backoff(attempt, base, max) {
  const cap = Math.min(max, base * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}
function isRetryable(err) {
  if (err instanceof ConnectorError) return err.retryable;
  if (err?.name === 'AbortError') return true;               // our timeout
  const code = err?.cause?.code || err?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)) return true;
  const status = err?.status;                                // a thrown HTTP wrapper may carry status
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  return false;
}

export function makeConnector(name, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const state = {
    calls: 0, successes: 0, failures: 0, retries: 0,
    consecutiveFailures: 0, openUntil: 0, lastError: null,
    totalLatencyMs: 0, samples: [],
  };

  function record(latency, ok, err) {
    state.calls += 1;
    state.totalLatencyMs += latency;
    state.samples.push(latency);
    if (state.samples.length > cfg.sampleWindow) state.samples.shift();
    if (ok) { state.successes += 1; state.consecutiveFailures = 0; }
    else {
      state.failures += 1; state.consecutiveFailures += 1; state.lastError = err?.message || String(err);
      if (state.consecutiveFailures >= cfg.breakerThreshold) state.openUntil = Date.now() + cfg.breakerCooldownMs;
    }
  }

  async function call(fn, { idempotent = false, onTelemetry } = {}) {
    // circuit breaker: fail fast while open
    if (Date.now() < state.openUntil) {
      throw new ConnectorError(`${name} circuit open (cooling down)`, { connector: name, code: 'circuit_open', retryable: false });
    }
    const maxAttempts = idempotent ? cfg.retries + 1 : 1; // never auto-retry a non-idempotent op
    let attempt = 0, lastErr;
    for (;;) {
      const started = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
      try {
        // fn may use ac.signal (we pass it as the 2nd arg too for convenience)
        const result = await fn(ac.signal, ac);
        clearTimeout(timer);
        const latency = Date.now() - started;
        record(latency, true);
        onTelemetry?.({ connector: name, ok: true, latency, attempt });
        return result;
      } catch (err) {
        clearTimeout(timer);
        const latency = Date.now() - started;
        lastErr = (err?.name === 'AbortError' || ac.signal.aborted)
          ? new ConnectorError(`${name} timed out after ${cfg.timeoutMs}ms`, { connector: name, code: 'timeout', retryable: true, cause: err })
          : err;
        attempt += 1;
        const canRetry = attempt < maxAttempts && isRetryable(lastErr);
        record(latency, false, lastErr);
        onTelemetry?.({ connector: name, ok: false, latency, attempt, error: lastErr.message, willRetry: canRetry });
        if (!canRetry) break;
        state.retries += 1;
        await sleep(backoff(attempt, cfg.baseBackoffMs, cfg.maxBackoffMs));
      }
    }
    throw lastErr;
  }

  function percentile(p) {
    if (!state.samples.length) return 0;
    const sorted = [...state.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  return {
    name,
    call,
    stats() {
      return {
        connector: name,
        calls: state.calls, successes: state.successes, failures: state.failures, retries: state.retries,
        successRate: state.calls ? Number((state.successes / state.calls).toFixed(4)) : 1,
        open: Date.now() < state.openUntil,
        openUntil: state.openUntil || null,
        consecutiveFailures: state.consecutiveFailures,
        avgLatencyMs: state.calls ? Math.round(state.totalLatencyMs / state.calls) : 0,
        p50: percentile(50), p95: percentile(95),
        lastError: state.lastError,
      };
    },
    reset() { state.consecutiveFailures = 0; state.openUntil = 0; },
  };
}

// A process-wide registry so the API-Integration health board can enumerate all
// connector stats in one place.
const REGISTRY = new Map();
export function registerConnector(name, opts) {
  if (!REGISTRY.has(name)) REGISTRY.set(name, makeConnector(name, opts));
  return REGISTRY.get(name);
}
export function connectorHealth() {
  return [...REGISTRY.values()].map((c) => c.stats());
}
