// In-house human verification — NO third-party vendor (no Turnstile/reCAPTCHA).
// A server-issued proof-of-work challenge: the browser must find a nonce whose
// SHA-256(challenge + nonce) has `difficulty` leading zero bits. Trivial for one
// human (a few hundred ms), expensive at bot scale, and impossible to farm out
// because each challenge is single-use, IP-bound, HMAC-signed, and short-lived.
// Pairs with the honeypot + submission-timing + Sentinel layers already in place.
import crypto from 'node:crypto';

const SECRET = process.env.HUMAN_CHALLENGE_SECRET || process.env.WALLET_STORE_KEY || 'nf-human-challenge-dev';
const TTL_MS = 5 * 60 * 1000;
const used = new Map(); // challenge id -> expiry, single-use guard

function leadingZeroBits(hexDigest) {
  let bits = 0;
  for (const ch of hexDigest) {
    const v = parseInt(ch, 16);
    if (v === 0) { bits += 4; continue; }
    bits += Math.clz32(v) - 28; // leading zeros within this nibble
    break;
  }
  return bits;
}

/* Issue a challenge bound to the caller's IP. difficulty ~16 bits ≈ a few
   hundred ms of synchronous browser work; raise for hotter endpoints. */
export function issueChallenge(ip, difficulty = 16) {
  const salt = crypto.randomBytes(12).toString('hex');
  const exp = Date.now() + TTL_MS;
  const payload = `${salt}~${ip}~${difficulty}~${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 24);
  return { challenge: `${payload}~${sig}`, difficulty, ttlMs: TTL_MS };
}

/* Verify a solved challenge. Returns { human: true } only when the signature
   is valid, unexpired, IP-matched, single-use, and the proof-of-work holds. */
export function verifyChallenge(ip, challenge, nonce) {
  if (typeof challenge !== 'string' || typeof nonce !== 'string') return { human: false, reason: 'malformed' };
  const parts = challenge.split("~");
  if (parts.length !== 5) return { human: false, reason: 'malformed' };
  const [salt, cip, diffStr, expStr, sig] = parts;
  const payload = `${salt}~${cip}~${diffStr}~${expStr}`;
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 24);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { human: false, reason: 'bad_signature' };
  if (cip !== ip) return { human: false, reason: 'ip_mismatch' };
  if (Date.now() > Number(expStr)) return { human: false, reason: 'expired' };
  if (used.has(salt)) return { human: false, reason: 'replayed' };

  const digest = crypto.createHash('sha256').update(`${challenge}${nonce}`).digest('hex');
  if (leadingZeroBits(digest) < Number(diffStr)) return { human: false, reason: 'insufficient_work' };

  used.set(salt, Number(expStr));
  if (used.size > 20000) { const now = Date.now(); for (const [k, e] of used) if (e < now) used.delete(k); }
  return { human: true };
}
