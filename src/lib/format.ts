/** Format integer cents for display. Integer math only — no float division. */
export function formatCents(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const rem = abs % 100;
  const whole = (abs - rem) / 100; // exact: numerator is divisible by 100
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${sign}${symbol}${whole.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}
