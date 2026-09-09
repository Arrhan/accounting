import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  safeEqual,
  SESSION_TTL_MS,
  verifySessionToken,
} from "./auth";

const SECRET = "test-secret";
const NOW = 1_757_400_000_000;

describe("createSessionToken / verifySessionToken", () => {
  it("round-trips a valid token", () => {
    const token = createSessionToken(SECRET, NOW);
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(token.startsWith(`${NOW + SESSION_TTL_MS}.`)).toBe(true);
    expect(verifySessionToken(SECRET, token, NOW)).toBe(true);
    // Still valid one ms before expiry.
    expect(verifySessionToken(SECRET, token, NOW + SESSION_TTL_MS - 1)).toBe(
      true,
    );
  });

  it("rejects expired tokens (strictly greater-than)", () => {
    const token = createSessionToken(SECRET, NOW);
    const expiry = NOW + SESSION_TTL_MS;
    expect(verifySessionToken(SECRET, token, expiry)).toBe(false);
    expect(verifySessionToken(SECRET, token, expiry + 1)).toBe(false);
  });

  it("rejects tokens signed with a different secret", () => {
    const token = createSessionToken("other-secret", NOW);
    expect(verifySessionToken(SECRET, token, NOW)).toBe(false);
  });

  it("rejects tampered expiry", () => {
    const token = createSessionToken(SECRET, NOW);
    const [expiry, sig] = token.split(".");
    const bumped = String(Number(expiry) + 1) + "." + sig;
    expect(verifySessionToken(SECRET, bumped, NOW)).toBe(false);
  });

  it.each([
    undefined,
    "",
    "abc",
    "123.",
    "." + "a".repeat(64),
    "123." + "a".repeat(63),
    "123." + "a".repeat(65),
    "123." + "A".repeat(64), // uppercase hex not minted by us
    "1.2." + "a".repeat(64),
    "9".repeat(16) + "." + "a".repeat(64), // expiry too long for exact Number
    "123.zz" + "a".repeat(62), // non-hex
  ])("rejects malformed token %j", (token) => {
    expect(verifySessionToken(SECRET, token as string | undefined, NOW)).toBe(
      false,
    );
  });
});

describe("safeEqual", () => {
  it("matches equal strings", () => {
    expect(safeEqual("hunter2", "hunter2")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
  });

  it("rejects different strings, including different lengths", () => {
    expect(safeEqual("hunter2", "hunter3")).toBe(false);
    expect(safeEqual("hunter2", "hunter22")).toBe(false);
    expect(safeEqual("a", "")).toBe(false);
  });
});
