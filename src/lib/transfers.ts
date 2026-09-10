import { eq } from "drizzle-orm";
import { accounts, transactions } from "@/db/schema";
import type { SyncDb } from "@/lib/sync";

const MAX_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MatchTxn {
  id: number;
  accountId: number;
  accountType: "checking" | "credit" | "savings" | null;
  /** UTC date, YYYY-MM-DD. */
  date: string;
  amountCents: number;
}

function daysApart(a: string, b: string): number {
  return Math.abs(
    (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / DAY_MS,
  );
}

/**
 * Find inter-account transfer pairs (card payments, internal moves): money
 * leaving checking (negative) landing on a credit/savings account (positive),
 * equal magnitude, within 5 calendar days. Nearest-date greedy, one-to-one —
 * so the closest pair wins when several share an amount. Refunds (credit
 * negatives) and peer-to-peer payments never satisfy the direction/type rule.
 * Pure and deterministic.
 */
export function findTransferPairs(txns: MatchTxn[]): [number, number][] {
  const checkingOut = txns.filter(
    (t) => t.accountType === "checking" && t.amountCents < 0,
  );
  const otherIn = txns.filter(
    (t) =>
      (t.accountType === "credit" || t.accountType === "savings") &&
      t.amountCents > 0,
  );

  type Candidate = { dist: number; c: MatchTxn; o: MatchTxn };
  const candidates: Candidate[] = [];
  for (const c of checkingOut) {
    for (const o of otherIn) {
      if (c.accountId === o.accountId) continue; // paranoia; types already differ
      if (c.amountCents !== -o.amountCents) continue;
      const dist = daysApart(c.date, o.date);
      if (dist > MAX_DAYS) continue;
      candidates.push({ dist, c, o });
    }
  }

  // Nearest first; deterministic tiebreak so re-runs are identical.
  candidates.sort(
    (x, y) =>
      x.dist - y.dist ||
      x.c.date.localeCompare(y.c.date) ||
      x.o.date.localeCompare(y.o.date) ||
      x.c.id - y.c.id ||
      x.o.id - y.o.id,
  );

  const used = new Set<number>();
  const pairs: [number, number][] = [];
  for (const { c, o } of candidates) {
    if (used.has(c.id) || used.has(o.id)) continue;
    used.add(c.id);
    used.add(o.id);
    pairs.push([c.id, o.id]);
  }
  return pairs;
}

/**
 * Recompute all inter-account transfer links. The matcher solely owns
 * `is_transfer`/`transfer_pair_id` (sync and categorize never set them), so it
 * resets prior links and recomputes from scratch — idempotent by construction.
 */
export async function matchTransfers({
  db,
}: {
  db: SyncDb;
  now?: Date;
}): Promise<{ pairs: number; marked: number }> {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountType: accounts.type,
      postedAt: transactions.postedAt,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id));

  const pairs = findTransferPairs(
    rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      accountType: r.accountType,
      date: r.postedAt.toISOString().slice(0, 10),
      amountCents: r.amountCents,
    })),
  );

  // Clear previous links (this matcher owns the flag), then apply the new set.
  await db
    .update(transactions)
    .set({ isTransfer: false, transferPairId: null })
    .where(eq(transactions.isTransfer, true));

  for (const [a, b] of pairs) {
    await db
      .update(transactions)
      .set({ isTransfer: true, transferPairId: b })
      .where(eq(transactions.id, a));
    await db
      .update(transactions)
      .set({ isTransfer: true, transferPairId: a })
      .where(eq(transactions.id, b));
  }

  return { pairs: pairs.length, marked: pairs.length * 2 };
}
