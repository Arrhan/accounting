// One-time exchange of a SimpleFIN setup token for an access URL.
// Reads SIMPLE_FIN_KEY (base64 setup token) from .env.local, POSTs to the
// decoded claim URL, and writes the returned access URL to
// SIMPLEFIN_ACCESS_URL in .env.local. Prints hosts and statuses only —
// never tokens, credentials, or URLs.
//
// Setup tokens are single-use: a successful claim permanently invalidates
// the token. If the claim fails, generate a fresh token in the bridge UI.
//
// Usage: node scripts/claim-simplefin.mjs
import { readFileSync, writeFileSync } from "node:fs";

const ENV_PATH = ".env.local";
const lines = readFileSync(ENV_PATH, "utf8").split("\n");

const tokenLine = lines.find((l) => /^SIMPLE_FIN_KEY\s*=/.test(l));
if (!tokenLine) {
  console.error("No SIMPLE_FIN_KEY line in .env.local");
  process.exit(1);
}
const token = tokenLine.replace(/^SIMPLE_FIN_KEY\s*=\s*/, "").trim();

const claimUrl = Buffer.from(token, "base64").toString("utf8");
if (!/^https:\/\/[a-z0-9.-]+\/simplefin\/claim\/[A-Za-z0-9_-]+$/.test(claimUrl)) {
  console.error("SIMPLE_FIN_KEY did not decode to a SimpleFIN claim URL");
  process.exit(1);
}
console.log("Claim URL host:", new URL(claimUrl).host);

const res = await fetch(claimUrl, { method: "POST" });
console.log("Claim HTTP status:", res.status);
if (!res.ok) {
  console.error(
    "Claim failed — the token may already be used or expired. Generate a new setup token in the SimpleFIN Bridge UI.",
  );
  process.exit(1);
}

const accessUrl = (await res.text()).trim();
let parsed;
try {
  parsed = new URL(accessUrl);
} catch {
  console.error("Claim response was not a URL");
  process.exit(1);
}
if (parsed.protocol !== "https:" || !parsed.username || !parsed.password) {
  console.error("Access URL is not https or is missing embedded credentials");
  process.exit(1);
}
console.log("Access URL host:", parsed.host);

let replaced = false;
const out = lines.map((l) => {
  if (l.startsWith("SIMPLEFIN_ACCESS_URL=")) {
    replaced = true;
    return "SIMPLEFIN_ACCESS_URL=" + accessUrl;
  }
  return l;
});
if (!replaced) out.push("SIMPLEFIN_ACCESS_URL=" + accessUrl);
writeFileSync(ENV_PATH, out.join("\n"));
console.log("SIMPLEFIN_ACCESS_URL updated in .env.local");
