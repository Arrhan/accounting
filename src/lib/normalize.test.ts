import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "./normalize";

describe("normalizeMerchant", () => {
  // Real patterns sampled from live Capital One / Amex data.
  it.each([
    // [description, payee, expected]
    ["whatever", "DoorDash", "DOORDASH"],
    ["whatever", "Aplpay Burma Losan", "BURMA LOSAN"],
    ["AplPay TST* BURMA LOSAN FRANCISCO CA", null, "BURMA LOSAN"],
    ["AMAZON MKTPL*1N2G895M3", null, "AMAZON MKTPL"],
    ["Amazon.com*5A2481M92", null, "AMAZON.COM"],
    ["AplPay CHIPOTLE 1857SAN FRANCISCO CA", null, "CHIPOTLE"],
    ["ANTHROPIC* CLAUDE SUB", null, "ANTHROPIC"],
    // No separators to work with: stable garbage is accepted by design.
    ["673REBurnham310", null, "673REBURNHAM310"],
    // Glued city tail is unrecoverable; imperfect-but-stable by design.
    ["TORRAKU RAMENSan Francisco CA", null, "TORRAKU RAMENSAN"],
    ["whatever", "McDonald's", "MCDONALD'S"],
    ["AplPay BT*DD *DOORDASAN FRANCISCO CA", null, "DOORDASAN"],
    ["AMEX EPAYMENT", null, "AMEX EPAYMENT"],
    ["SQ *COFFEE CART #12", null, "COFFEE CART"],
    ["Amazon Prime Amazon.com WA", null, "AMAZON PRIME"],
  ])("normalizes %j / payee %j to %j", (description, payee, expected) => {
    expect(normalizeMerchant(description, payee)).toBe(expected);
  });

  it("prefers payee over description, falling back on blank payee", () => {
    expect(normalizeMerchant("RAW DESC LLC", "Nice Name")).toBe("NICE NAME");
    expect(normalizeMerchant("RAW DESC LLC", "   ")).toBe("RAW DESC LLC");
    expect(normalizeMerchant("RAW DESC LLC", null)).toBe("RAW DESC LLC");
  });

  it("is idempotent on its own output", () => {
    for (const input of [
      "AplPay TST* BURMA LOSAN FRANCISCO CA",
      "AMAZON MKTPL*1N2G895M3",
      "AplPay CHIPOTLE 1857SAN FRANCISCO CA",
    ]) {
      const once = normalizeMerchant(input, null);
      expect(once).not.toBeNull();
      expect(normalizeMerchant(once!, null)).toBe(once);
    }
  });

  it("returns null when nothing usable remains", () => {
    expect(normalizeMerchant("", null)).toBeNull();
    expect(normalizeMerchant("   ", null)).toBeNull();
    expect(normalizeMerchant("*", null)).toBeNull();
  });
});
