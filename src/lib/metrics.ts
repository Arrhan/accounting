import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { accounts, categories, transactions } from "@/db/schema";
import type { SyncDb } from "@/lib/sync";

export type RangePreset = "last-week" | "last-month" | "month-to-date" | "custom";

export interface DateRange {
  preset: RangePreset;
  start: Date;
  end: Date;
}

/** Label used for spend whose transaction has no category assigned. */
export const UNCATEGORIZED_LABEL = "(uncategorized)";
/** Label used for spend whose transaction has no normalized merchant. */
export const UNKNOWN_MERCHANT_LABEL = "(unknown)";

export interface CategorySpend {
  name: string;
  totalCents: number;
  /** % of the list's denominator; null when that denominator is ≤ 0. */
  pct: number | null;
  /** Bar width 0–100, scaled to the largest magnitude in the list. */
  barPct: number;
}

export interface MerchantSpend extends CategorySpend {
  count: number;
}

export interface CategoryDrilldown {
  name: string;
  totalCents: number;
  /** Top merchants within the category; % is the share of the category total. */
  rows: MerchantSpend[];
}

export interface Metrics {
  range: DateRange;
  incomeCents: number;
  totalSpendCents: number;
  netCashFlowCents: number;
  /** net / income; null when income ≤ 0. */
  savingsRate: number | null;
  /** Net moved into Savings & Investments: contributions positive, withdrawals negative. */
  savedCents: number;
  spendByCategory: CategorySpend[];
  spendByMerchant: MerchantSpend[];
  incomeBySource: MerchantSpend[];
  savingsByMerchant: MerchantSpend[];
  /** Present only when a category was requested. */
  categoryDrilldown: CategoryDrilldown | null;
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

// Predicate fragments — the single source of truth for what counts as what.
// See docs/ARCHITECTURE.md decision log ("Metric definitions").

// Spend: not a matched transfer, not an income/savings category, and not a
// checking inflow (that's income). Contribution = -amount, so refunds on a
// card reduce their category.
const spendContributes = sql`(
  ${transactions.isTransfer} = false
  AND (${categories.name} IS NULL OR ${categories.name} NOT IN ('Income', 'Savings & Investments'))
  AND NOT (${transactions.amountCents} > 0 AND ${accounts.type} = 'checking')
)`;

// Income: money arriving in checking that isn't a transfer or a withdrawal
// back from savings/investments. Category is deliberately ignored so
// mislabeled payroll still counts.
const incomeContributes = sql`(
  ${transactions.isTransfer} = false
  AND ${transactions.amountCents} > 0
  AND ${accounts.type} = 'checking'
  AND (${categories.name} IS NULL OR ${categories.name} <> 'Savings & Investments')
)`;

// Savings & Investments: anything in that category that isn't a matched
// transfer. Contribution = -amount, so contributions are positive and
// withdrawals back to checking are negative.
const savingsContributes = sql`(
  ${transactions.isTransfer} = false
  AND ${categories.name} = 'Savings & Investments'
)`;

function withPct<T extends { totalCents: number }>(
  rows: T[],
  denominatorCents: number,
): (T & { pct: number | null; barPct: number })[] {
  const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.totalCents)), 0);
  return rows.map((r) => ({
    ...r,
    pct: denominatorCents > 0 ? (r.totalCents / denominatorCents) * 100 : null,
    barPct: maxAbs > 0 ? Math.round((Math.abs(r.totalCents) / maxAbs) * 100) : 0,
  }));
}

export async function computeMetrics(
  db: SyncDb,
  range: DateRange,
  opts: { category?: string } = {},
): Promise<Metrics> {
  const inRange = and(
    gte(transactions.postedAt, range.start),
    lte(transactions.postedAt, range.end),
  );
  const outflowSum = sql<number>`sum(-${transactions.amountCents})::bigint`.mapWith(
    Number,
  );
  const inflowSum = sql<number>`sum(${transactions.amountCents})::bigint`.mapWith(
    Number,
  );
  const merchantLabel = sql<string>`coalesce(${transactions.normalizedMerchant}, ${UNKNOWN_MERCHANT_LABEL})`;
  const rowCount = sql<number>`count(*)::int`.mapWith(Number);

  const base = () =>
    db
      .select({ name: merchantLabel, totalCents: outflowSum, count: rowCount })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id));

  // Drill into one category's merchants. The synthetic "(uncategorized)"
  // label maps back to transactions with no category at all.
  const category = opts.category;
  const categoryFilter =
    category === undefined
      ? null
      : category === UNCATEGORIZED_LABEL
        ? isNull(categories.name)
        : eq(categories.name, category);

  const [categoryRows, merchantRows, incomeRows, savingsRows, drillRows, [totals]] =
    await Promise.all([
      db
        .select({
          name: sql<string>`coalesce(${categories.name}, ${UNCATEGORIZED_LABEL})`,
          totalCents: outflowSum,
        })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(and(inRange, spendContributes))
        .groupBy(categories.name)
        .orderBy(desc(outflowSum)),
      base()
        .where(and(inRange, spendContributes))
        .groupBy(transactions.normalizedMerchant)
        .orderBy(desc(outflowSum))
        .limit(15),
      db
        .select({ name: merchantLabel, totalCents: inflowSum, count: rowCount })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(and(inRange, incomeContributes))
        .groupBy(transactions.normalizedMerchant)
        .orderBy(desc(inflowSum))
        .limit(15),
      base()
        .where(and(inRange, savingsContributes))
        .groupBy(transactions.normalizedMerchant)
        .orderBy(desc(outflowSum)),
      categoryFilter
        ? base()
            .where(and(inRange, spendContributes, categoryFilter))
            .groupBy(transactions.normalizedMerchant)
            .orderBy(desc(outflowSum))
            .limit(15)
        : Promise.resolve([]),
      db
        .select({
          spend: sql<number>`coalesce(sum(case when ${spendContributes}
            then -${transactions.amountCents} else 0 end), 0)::bigint`.mapWith(Number),
          income: sql<number>`coalesce(sum(case when ${incomeContributes}
            then ${transactions.amountCents} else 0 end), 0)::bigint`.mapWith(Number),
          saved: sql<number>`coalesce(sum(case when ${savingsContributes}
            then -${transactions.amountCents} else 0 end), 0)::bigint`.mapWith(Number),
        })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(and(inRange, eq(transactions.isTransfer, false))),
    ]);

  const totalSpendCents = totals.spend;
  const incomeCents = totals.income;
  const savedCents = totals.saved;
  const netCashFlowCents = incomeCents - totalSpendCents;

  let categoryDrilldown: CategoryDrilldown | null = null;
  if (category !== undefined) {
    // The category list already holds every category's total for this range,
    // so the drilldown's denominator reconciles with the bar it was opened from.
    const categoryTotal =
      categoryRows.find((r) => r.name === category)?.totalCents ?? 0;
    categoryDrilldown = {
      name: category,
      totalCents: categoryTotal,
      rows: withPct(drillRows, categoryTotal),
    };
  }

  return {
    range,
    incomeCents,
    totalSpendCents,
    netCashFlowCents,
    savingsRate: incomeCents > 0 ? netCashFlowCents / incomeCents : null,
    savedCents,
    spendByCategory: withPct(categoryRows, totalSpendCents),
    spendByMerchant: withPct(merchantRows, totalSpendCents),
    incomeBySource: withPct(incomeRows, incomeCents),
    savingsByMerchant: withPct(savingsRows, savedCents),
    categoryDrilldown,
  };
}
