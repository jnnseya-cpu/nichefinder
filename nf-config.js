/* Niche Finder — deployment configuration (single place to wire a live backend).
   Leave NF_GATEWAY_URL empty for the fully offline demo: searches use the built-in
   demo dataset and the ACU wallet lives in this browser's localStorage.

   To go live:
   1. Deploy the gateway (see gateway/README.md) with your provider API keys set
      as environment variables — keys never belong in this repo.
   2. Put its public URL below, e.g. 'https://gateway.nichefinderhq.com'.
   Search then runs against live AI (claude → gemini → openai failover) and the
   wallet syncs to the server-side ACU ledger (P0 of the AI-OS roadmap). */
window.NF_GATEWAY_URL = '';

/* Wallet identity sent to the gateway. Replaced by real auth (JWT) in P1;
   until then a stable per-browser id keeps server balances consistent. */
window.NF_WALLET_USER = (function () {
  try {
    var id = localStorage.getItem('nf_user_id');
    if (!id) {
      id = 'op_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('nf_user_id', id);
    }
    return id;
  } catch (e) { return 'op_anonymous'; }
})();
