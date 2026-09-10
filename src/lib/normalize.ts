// Merchant normalization: uppercase, strip processor/wallet prefixes, *-code
// suffixes, trailing store numbers, and city/state tails.
//
// Guiding rule: STABILITY over beauty. The output keys merchant_memory, so the
// same merchant must always produce the same string; a truncated-but-stable
// string (fixed-width bank fields glue city names onto merchants) is fine.

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
]);

// Wallet/processor prefixes, loop-stripped to handle stacking ("APLPAY TST* …").
// APLPAY requires a trailing space so a merchant literally named APLPAYX survives.
const PREFIX_RE =
  /^(?:APLPAY\s+|TST\s?\*\s*|SQ\s?\*\s*|BT\*DD\s?\*?\s*|PAYPAL\s?\*\s*|PY\s?\*\s*)/;

/**
 * Normalize a merchant identity from a transaction. Prefers the institution's
 * `payee` field (usually cleaner) and falls back to the raw description.
 * Returns null when nothing usable remains.
 */
export function normalizeMerchant(
  description: string,
  payee: string | null,
): string | null {
  const src = payee && payee.trim() ? payee : description;
  let s = src.toUpperCase().trim();

  while (PREFIX_RE.test(s)) s = s.replace(PREFIX_RE, "");
  s = s.replace(/^[*\s]+/, "");

  // Truncate at the first remaining "*": covers per-txn codes
  // (AMAZON MKTPL*1N2G895M3) and star-joined tails (ANTHROPIC* CLAUDE SUB).
  const star = s.indexOf("*");
  if (star > 0) s = s.slice(0, star);
  s = s.trim();

  // Trailing "<one city word> <state>". One word only, deliberately: glued
  // multi-word cities can't be recovered, and one word keeps description- and
  // payee-derived forms in agreement.
  const m = s.match(/^(.+?)\s+\S+\s+([A-Z]{2})$/);
  if (m && US_STATES.has(m[2])) s = m[1];

  // Trailing store number; the [A-Z]* tail eats digit+glued-city fragments
  // like "1857SAN".
  s = s.replace(/\s+(?:#\d{1,5}|\d{3,5}[A-Z]*)$/, "");

  s = s.replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}
