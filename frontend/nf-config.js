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

/* Synchronous SHA-256 (hex) — pure JS, byte-identical to Node's crypto. Used to
   solve the proof-of-work challenge in a tight loop; the browser's WebCrypto
   digest is async-only, which makes tens of thousands of sequential hashes far
   too slow (the signup "Verifying…" hang). This runs the whole search in a few
   hundred milliseconds. */
window.NF_sha256hex = (function () {
  var K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
  return function (msg) {
    var H0=0x6a09e667,H1=0xbb67ae85,H2=0x3c6ef372,H3=0xa54ff53a,H4=0x510e527f,H5=0x9b05688c,H6=0x1f83d9ab,H7=0x5be0cd19;
    var bytes = [];
    for (var i = 0; i < msg.length; i++) {
      var c = msg.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
      else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    var origBits = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var i = 7; i >= 0; i--) bytes.push((Math.floor(origBits / Math.pow(2, i * 8))) & 0xff);
    var w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = (bytes[off+i*4]<<24)|(bytes[off+i*4+1]<<16)|(bytes[off+i*4+2]<<8)|(bytes[off+i*4+3]);
      for (var i = 16; i < 64; i++) {
        var s0 = rr(w[i-15],7)^rr(w[i-15],18)^(w[i-15]>>>3);
        var s1 = rr(w[i-2],17)^rr(w[i-2],19)^(w[i-2]>>>10);
        w[i] = (w[i-16]+s0+w[i-7]+s1)|0;
      }
      var a=H0,b=H1,c=H2,d=H3,e=H4,f=H5,g=H6,h=H7;
      for (var i = 0; i < 64; i++) {
        var S1=rr(e,6)^rr(e,11)^rr(e,25); var ch2=(e&f)^((~e)&g); var t1=(h+S1+ch2+K[i]+w[i])|0;
        var S0=rr(a,2)^rr(a,13)^rr(a,22); var maj=(a&b)^(a&c)^(b&c); var t2=(S0+maj)|0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      H0=(H0+a)|0;H1=(H1+b)|0;H2=(H2+c)|0;H3=(H3+d)|0;H4=(H4+e)|0;H5=(H5+f)|0;H6=(H6+g)|0;H7=(H7+h)|0;
    }
    function hx(x){ return ((x>>>0).toString(16)).padStart(8,'0'); }
    return hx(H0)+hx(H1)+hx(H2)+hx(H3)+hx(H4)+hx(H5)+hx(H6)+hx(H7);
  };
})();

/* Leading zero BITS of a hex digest — matches the gateway's difficulty check. */
function NF_leadingZeroBits(hex) {
  var b = 0;
  for (var i = 0; i < hex.length; i++) { var v = parseInt(hex[i], 16); if (v === 0) { b += 4; continue; } b += Math.clz32(v) - 28; break; }
  return b;
}

/* Solve a fetched proof-of-work challenge synchronously. Returns { challenge,
   nonce } or null. A human's browser finishes in a few hundred ms. */
function NF_solveChallenge(ch) {
  for (var n = 0; n < 20000000; n++) {
    if (NF_leadingZeroBits(window.NF_sha256hex(ch.challenge + n)) >= ch.difficulty) return { challenge: ch.challenge, nonce: String(n) };
  }
  return null;
}

/* In-house human verification (no third-party vendor). Fetches a proof-of-work
   challenge, solves it, and redeems it at /v1/human/verify. Call before
   sensitive actions when a gateway is configured. */
window.NF_verifyHuman = function () {
  var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base || typeof fetch !== 'function') return Promise.resolve({ human: true, skipped: true });
  return fetch(base + '/v1/human/challenge').then(function (r) { return r.json(); }).then(function (ch) {
    var proof = NF_solveChallenge(ch);
    if (!proof) return { human: false };
    return fetch(base + '/v1/human/verify', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proof) }).then(function (r) { return r.json(); });
  }).catch(function () { return { human: false }; });
};

/* Like NF_verifyHuman, but returns the solved { challenge, nonce } WITHOUT
   redeeming it — so it can be attached to a signup/forgot request and verified
   server-side (each challenge is single-use). Returns null if no gateway. */
window.NF_humanProof = function () {
  var base = (window.NF_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base || typeof fetch !== 'function') return Promise.resolve(null);
  return fetch(base + '/v1/human/challenge').then(function (r) { return r.json(); })
    .then(function (ch) { return NF_solveChallenge(ch); })
    .catch(function () { return null; });
};
