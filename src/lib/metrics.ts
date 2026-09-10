import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { accounts, categories, transactions } from "@/db/schema";
import type { SyncDb } from "@/lib/sync";

export type RangePreset = "last-week" | "last-month" | "month-to-date" | "custom";

export interface DateRange {
  preset: RangePreset;
  start: Date;
  end: Date;
}

export interface CategorySpend {
  name: string;
  totalCents: number;
  /** % of total spend; null when total spend is ≤ 0. */
  pct: number | null;
  /** Bar width 0–100, scaled to the largest magnitude in the list. */
  barPct: number;
}

export interface MerchantSpend extends CategorySpend {
  count: number;
}

export interface Metrics {
  range: DateRange;
  incomeCents: number;
  totalSpendCents: number;
  netCashFlowCents: number;
  /** net / income; null when income ≤ 0. */
  savingsRate: number | null;
  spendByCategory: CategorySpend[];
  spendByMerchant: MerchantSpend[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUTCDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** Resolve a preset (+ optional custom bounds) to a concrete UTC range. Pure. */
export function resolveRange(
  preset: string | undefined,
  now: Date,
  customStart?: string,
  customEnd?: string,
): DateRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  if (preset === "last-week") {
    return {
      preset: "last-week",
      start: startOfUTCDay(new Date(now.getTime() - 6 * DAY_MS)),
      end: now,
    };
  }
  if (preset === "last-month") {
    return {
      preset: "last-month",
      start: new Date(Date.UTC(y, m - 1, 1)),
      end: new Date(Date.UTC(y, m, 1) - 1), // last ms of previous month
    };
  }
  if (preset === "custom") {
    const start = customStart
      ? new Date(`${customStart}T00:00:00.000Z`)
      : new Date(NaN);
    const end = customEnd
      ? new Date(`${customEnd}T23:59:59.999Z`)
      : new Date(NaN);
    if (
      !Number.isNaN(start.getTime()) &&
      !Number.isNaN(end.getTime()) &&
      start.getTime() <= end.getTime()
    ) {
      return { preset: "custom", start, end };
    }
    // fall through to month-to-date on invalid custom input
  }
  return { preset: "month-to-date", start: new Date(Date.UTC(y, m, 1)), end: now };
}

// A transaction contributes to spend unless it is a matched transfer, an
// income/savings category, or a checking inflow (income). See docs/ARCHITECTURE.md.
const spendContributes = sql`
  ${transactions.isTransfer} = false
  AND (${categories.name} IS NULL OR ${categories.name} NOT IN ('Income', 'Savings & Investments'))
  AND NOT (${transactions.amountCents} > 0 AND ${accounts.type} = 'checking')
`;

function withPct<T extends { totalCents: number }>(
  rows: T[],
  totalSpendCents: number,
): (T & { pct: number | null; barPct: number })[] {
  const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.totalCents)), 0);
  return rows.map((r) => ({
    ...r,
    pct: totalSpendCents > 0 ? (r.totalCents / totalSpendCents) * 100 : null,
    barPct: maxAbs > 0 ? Math.round((Math.abs(r.totalCents) / maxAbs) * 100) : 0,
  }));
}

export async function computeMetrics(
  db: SyncDb,
  range: DateRange,
): Promise<Metrics> {
  const inRange = and(
    gte(transactions.postedAt, range.start),
    lte(transactions.postedAt, range.end),
  );
  const spendSum = sql<number>`sum(-${transactions.amountCents})::bigint`.mapWith(
    Number,
  );

  const [categoryRows, merchantRows, [totals]] = await Promise.all([
    db
      .select({
        name: sql<string>`coalesce(${categories.name}, '(uncategorized)')`,
        totalCents: spendSum,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(inRange, spendContributes))
      .groupBy(categories.name)
      .orderBy(desc(spendSum)),
    db
      .select({
        name: sql<string>`coalesce(${transactions.normalizedMerchant}, '(unknown)')`,
        totalCents: spendSum,
        count: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(inRange, spendContributes))
      .groupBy(transactions.normalizedMerchant)
      .orderBy(desc(spendSum))
      .limit(15),
    db
      .select({
        spend: sql<number>`coalesce(sum(case when
          ${transactions.isTransfer} = false
          AND (${categories.name} IS NULL OR ${categories.name} NOT IN ('Income', 'Savings & Investments'))
          AND NOT (${transactions.amountCents} > 0 AND ${accounts.type} = 'checking')
          then -${transactions.amountCents} else 0 end), 0)::bigint`.mapWith(Number),
        income: sql<number>`coalesce(sum(case when
          ${transactions.amountCents} > 0 AND ${accounts.type} = 'checking'
          AND (${categories.name} IS NULL OR ${categories.name} <> 'Savings & Investments')
          then ${transactions.amountCents} else 0 end), 0)::bigint`.mapWith(Number),
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(inRange, eq(transactions.isTransfer, false))),
  ]);

  const totalSpendCents = totals.spend;
  const incomeCents = totals.income;
  const netCashFlowCents = incomeCents - totalSpendCents;

  return {
    range,
    incomeCents,
    totalSpendCents,
    netCashFlowCents,
    savingsRate: incomeCents > 0 ? netCashFlowCents / incomeCents : null,
    spendByCategory: withPct(categoryRows, totalSpendCents),
    spendByMerchant: withPct(merchantRows, totalSpendCents),
  };
}
