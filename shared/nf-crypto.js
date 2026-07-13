/* ============================================================================
   Niche Finder — SHARED encryption module (end-to-end encryption law, Addendum A).
   AES-256-GCM via WebCrypto, usable in the browser AND Node (>=19) — both expose
   globalThis.crypto.subtle. Only declares locals and assigns globalThis.NF_CRYPTO,
   so it loads as a classic script or an ES module.

   Honest scope note (governance): true end-to-end encryption requires a user
   key that never sits beside the data. In production, deriveKey() runs on the
   user's credentials at sign-in (PBKDF2-SHA256, 310k iterations) and wraps
   per-document data keys — the server stores ciphertext only. In the local
   prototype there are no accounts yet, so this module ships and is exercised
   by the backend's encrypted wallet store (key held in the WALLET_STORE_KEY
   environment variable, never beside the data it protects).
   ============================================================================ */
(function () {
  'use strict';

  var subtle = globalThis.crypto && globalThis.crypto.subtle;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function toB64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  /* Derive an AES-256-GCM key from a passphrase (user credential) + salt. */
  function deriveKey(passphrase, saltB64) {
    var salt = saltB64 ? fromB64(saltB64) : globalThis.crypto.getRandomValues(new Uint8Array(16));
    return subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: 310000, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
      })
      .then(function (key) { return { key: key, salt: toB64(salt.buffer || salt) }; });
  }

  /* Encrypt any JSON-serialisable value → compact envelope string "NFE1:iv:ct". */
  function encryptJSON(key, value) {
    var iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(value)))
      .then(function (ct) { return 'NFE1:' + toB64(iv.buffer) + ':' + toB64(ct); });
  }

  /* Decrypt an "NFE1:iv:ct" envelope back to the original value.
     Rejects (never returns garbage) if the ciphertext was tampered with — GCM
     authentication is the tamper-evidence layer. */
  function decryptJSON(key, envelope) {
    if (typeof envelope !== 'string' || envelope.indexOf('NFE1:') !== 0) {
      return Promise.reject(new Error('Not an NFE1 envelope'));
    }
    var parts = envelope.split(':');
    return subtle.decrypt({ name: 'AES-GCM', iv: fromB64(parts[1]) }, key, fromB64(parts[2]))
      .then(function (pt) { return JSON.parse(dec.decode(pt)); });
  }

  function isEnvelope(v) { return typeof v === 'string' && v.indexOf('NFE1:') === 0; }

  globalThis.NF_CRYPTO = {
    available: Boolean(subtle),
    deriveKey: deriveKey,
    encryptJSON: encryptJSON,
    decryptJSON: decryptJSON,
    isEnvelope: isEnvelope
  };
})();
