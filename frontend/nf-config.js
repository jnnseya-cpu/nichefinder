/* Niche Finder — deployment configuration (single place to wire a live backend).
   Leave NF_GATEWAY_URL empty for the fully offline demo: searches use the built-in
   demo dataset and the ACU wallet lives in this browser's localStorage.

   To go live:
   1. Deploy the gateway (see backend/gateway/README.md) with your provider API keys set
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
      // Capability-grade id: ~130 bits of CSPRNG entropy. Until account auth
      // lands, this id IS the wallet credential — treat it like one.
      var bytes = new Uint8Array(16);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes)
        : bytes.forEach(function (_, i) { bytes[i] = Math.floor(Math.random() * 256); });
      id = 'op_' + Array.from(bytes, function (b) { return (b % 36).toString(36); }).join('') +
        Date.now().toString(36);
      localStorage.setItem('nf_user_id', id);
    }
    return id;
  } catch (e) { return 'op_anonymous'; }
})();

/* In-house human verification (no third-party vendor). Fetches a proof-of-work
   challenge from the gateway and solves it in the browser — a few hundred ms
   for a human, prohibitively expensive at bot scale. Call NF_verifyHuman()
   before signup/login/sensitive actions when a gateway is configured. */
window.NF_verifyHuman = function () {
  var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base || typeof fetch !== 'function' || !(window.crypto && crypto.subtle)) return Promise.resolve({ human: true, skipped: true });
  return fetch(base + '/v1/human/challenge').then(function (r) { return r.json(); }).then(function (ch) {
    var enc = new TextEncoder();
    function lz(buf){ var b=0; for(var i=0;i<buf.length;i++){ var v=buf[i]; if(v===0){b+=8;continue;} b+=Math.clz32(v)-24; break;} return b; }
    function solve(n){
      return crypto.subtle.digest('SHA-256', enc.encode(ch.challenge + n)).then(function(d){
        if (lz(new Uint8Array(d)) >= ch.difficulty) return String(n);
        if (n > 5000000) throw new Error('challenge timeout');
        return solve(n + 1);
      });
    }
    return solve(0).then(function (nonce) {
      return fetch(base + '/v1/human/verify', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: ch.challenge, nonce: nonce }) }).then(function (r) { return r.json(); });
    });
  }).catch(function () { return { human: false }; });
};

/* Like NF_verifyHuman, but returns the solved { challenge, nonce } WITHOUT
   redeeming it at /v1/human/verify — so it can be attached to a signup/forgot
   request and verified server-side (each challenge is single-use). Returns null
   if no gateway is configured or the browser lacks WebCrypto. */
window.NF_humanProof = function () {
  var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base || typeof fetch !== 'function' || !(window.crypto && crypto.subtle)) return Promise.resolve(null);
  return fetch(base + '/v1/human/challenge').then(function (r) { return r.json(); }).then(function (ch) {
    var enc = new TextEncoder();
    function lz(buf){ var b=0; for(var i=0;i<buf.length;i++){ var v=buf[i]; if(v===0){b+=8;continue;} b+=Math.clz32(v)-24; break;} return b; }
    function solve(n){
      return crypto.subtle.digest('SHA-256', enc.encode(ch.challenge + n)).then(function(d){
        if (lz(new Uint8Array(d)) >= ch.difficulty) return String(n);
        if (n > 5000000) throw new Error('challenge timeout');
        return solve(n + 1);
      });
    }
    return solve(0).then(function (nonce) { return { challenge: ch.challenge, nonce: nonce }; });
  }).catch(function () { return null; });
};
