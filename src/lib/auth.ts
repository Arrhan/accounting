import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// <epoch ms>.<64 lowercase hex chars>; \d{1,15} keeps Number() exact (< 2^53).
const TOKEN_RE = /^\d{1,15}\.[0-9a-f]{64}$/;

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** Mint a session token: `<expiryEpochMs>.<hex HMAC-SHA256(expiry)>`. */
export function createSessionToken(secret: string, now = Date.now()): string {
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${sign(secret, expiry).toString("hex")}`;
}

export function verifySessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token || !TOKEN_RE.test(token)) return false;
  const [expiry, signature] = token.split(".");
  const expected = sign(secret, expiry);
  const given = Buffer.from(signature, "hex");
  // Length guard before timingSafeEqual (it throws on mismatch). HMAC output
  // length is public knowledge — the guard leaks nothing. Signature checked
  // before expiry so forged tokens can't probe expiry handling.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return false;
  }
  return Number(expiry) > now;
}

/**
 * Constant-time string comparison that leaks neither content nor length:
 * hash both to fixed 32 bytes, then timingSafeEqual. Used for the password.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
