// Normalized error shape shared by all providers, so the router can make
// one failover decision regardless of which SDK threw.

export class GatewayError extends Error {
  constructor(message, { provider, status = 500, code = 'provider_error', retryable = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      provider: this.provider,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

// 429, 5xx, and connection-level failures are worth trying on the next
// provider; 4xx request/auth problems are not.
export function classifyStatus(status) {
  if (status === 429 || status >= 500) return true;
  return false;
}
