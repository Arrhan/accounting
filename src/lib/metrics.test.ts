import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { computeMetrics, resolveRange } from "@/lib/metrics";

const { accounts, categories, connections, transactions } = schema;

describe("resolveRange", () => {
  const now = new Date("2026-09-15T18:00:00.000Z");

  it("month-to-date is the default", () => {
    const r = resolveRange(undefined, now);
    expect(r.preset).toBe("month-to-date");
    expect(r.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(r.end).toBe(now);
  });

  it("last-week spans the trailing 7 days", () => {
    const r = resolveRange("last-week", now);
    expect(r.start.toISOString()).toBe("2026-09-09T00:00:00.000Z");
    expect(r.end).toBe(now);
  });

  it("last-month is the previous full calendar month", () => {
    const r = resolveRange("last-month", now);
    expect(r.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-08-31T23:59:59.999Z");
  });

  it("last-month rolls over the year in January", () => {
    const r = resolveRange("last-month", new Date("2026-01-10T00:00:00.000Z"));
    expect(r.start.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2025-12-31T23:59:59.999Z");
  });

  it("accepts a valid custom range", () => {
    const r = resolveRange("custom", now, "2026-08-01", "2026-08-31");
    expect(r.preset).toBe("custom");
    expect(r.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-08-31T23:59:59.999Z");
  });

  it("falls back to month-to-date on invalid custom input", () => {
    expect(resolveRange("custom", now, "nope", "2026-08-31").preset).toBe("month-to-date");
    expect(resolveRange("custom", now, "2026-08-31", "2026-08-01").preset).toBe("month-to-date");
    expect(resolveRange("custom", now).preset).toBe("month-to-date");
    expect(resolveRange("bogus", now).preset).toBe("month-to-date");
  });
});

describe("computeMetrics", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let checkingId: number;
  let creditId: number;
  let cat: Record<string, number>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    const cats = await db.select().from(categories);
    cat = Object.fromEntries(cats.map((c) => [c.name, c.id]));
  });

  afterAll(async () => {
    await client.close();
  });

  let seq = 0;
  async function seedTxn(opts: {
    accountId: number;
    amountCents: number;
    categoryId?: number | null;
    normalizedMerchant?: string | null;
    isTransfer?: boolean;
    postedAt?: string;
  }) {
    seq += 1;
    await db.insert(transactions).values({
      accountId: opts.accountId,
      simplefinTxnId: `T${seq}`,
      postedAt: new Date(`${opts.postedAt ?? "2026-09-10"}T12:00:00Z`),
      amountCents: opts.amountCents,
      description: "x",
      categoryId: opts.categoryId ?? null,
      normalizedMerchant: opts.normalizedMerchant ?? null,
      isTransfer: opts.isTransfer ?? false,
    });
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE connections, accounts, balance_snapshots, transactions RESTART IDENTITY CASCADE`,
    );
    const [conn] = await db
      .insert(connections)
      .values({ simplefinConnId: "CON-1", name: "Bank" })
      .returning({ id: connections.id });
    const [chk] = await db
      .insert(accounts)
      .values({ connectionId: conn.id, simplefinAccountId: "CHK", name: "Checking", type: "checking", currency: "USD" })
      .returning({ id: accounts.id });
    const [crd] = await db
      .insert(accounts)
      .values({ connectionId: conn.id, simplefinAccountId: "CRD", name: "Card", type: "credit", currency: "USD" })
      .returning({ id: accounts.id });
    checkingId = chk.id;
    creditId = crd.id;
  });

  const septMTD = () => resolveRange("month-to-date", new Date("2026-09-30T00:00:00Z"));

  it("computes all three metrics with every rule branch", async () => {
    await seedTxn({ accountId: creditId, amountCents: -5000, categoryId: cat["Dining"], normalizedMerchant: "CHIPOTLE" }); // spend
    await seedTxn({ accountId: checkingId, amountCents: -2000, categoryId: cat["Transfers"], normalizedMerchant: "ARJUN" }); // P2P out → spend
    await seedTxn({ accountId: checkingId, amountCents: 3000, categoryId: cat["Transfers"], normalizedMerchant: "AADIT" }); // P2P in → income
    await seedTxn({ accountId: creditId, amountCents: 1500, categoryId: cat["Shopping"], normalizedMerchant: "OLDNAVY" }); // refund → negative spend
    await seedTxn({ accountId: checkingId, amountCents: 400000, categoryId: cat["Subscriptions"], normalizedMerchant: "MICROSOFT" }); // payroll mislabeled → income only
    await seedTxn({ accountId: checkingId, amountCents: -100000, categoryId: cat["Savings & Investments"], normalizedMerchant: "IBKR" }); // excluded
    await seedTxn({ accountId: checkingId, amountCents: 50000, categoryId: cat["Savings & Investments"], normalizedMerchant: "IBKR" }); // excluded from income
    await seedTxn({ accountId: checkingId, amountCents: -900, categoryId: cat["Transfers"], normalizedMerchant: null, isTransfer: true }); // matched transfer → excluded
    await seedTxn({ accountId: creditId, amountCents: 900, categoryId: cat["Transfers"], normalizedMerchant: null, isTransfer: true });
    await seedTxn({ accountId: creditId, amountCents: -800, categoryId: null, normalizedMerchant: null }); // null category spend
    await seedTxn({ accountId: creditId, amountCents: -99999, categoryId: cat["Dining"], postedAt: "2026-07-01" }); // out of range

    const m = await computeMetrics(db, septMTD());

    // spend = 5000 + 2000 - 1500 (refund) + 800 (null cat) = 6300
    expect(m.totalSpendCents).toBe(6300);
    // income = 3000 (P2P in) + 400000 (payroll) = 403000
    expect(m.incomeCents).toBe(403000);
    expect(m.netCashFlowCents).toBe(403000 - 6300);
    expect(m.savingsRate).toBeCloseTo((403000 - 6300) / 403000, 6);

    const byName = Object.fromEntries(m.spendByCategory.map((r) => [r.name, r.totalCents]));
    expect(byName["Dining"]).toBe(5000);
    expect(byName["Transfers"]).toBe(2000); // P2P out only
    expect(byName["Shopping"]).toBe(-1500); // refund → negative
    expect(byName["(uncategorized)"]).toBe(800);
    expect(byName["Savings & Investments"]).toBeUndefined();
    expect(byName["Subscriptions"]).toBeUndefined(); // payroll excluded from spend

    // category sums reconcile with the Spend tile
    const sum = m.spendByCategory.reduce((s, r) => s + r.totalCents, 0);
    expect(sum).toBe(m.totalSpendCents);

    // descending order by total
    const totals = m.spendByCategory.map((r) => r.totalCents);
    expect([...totals]).toEqual([...totals].sort((a, b) => b - a));

    // merchant grouping
    const chipotle = m.spendByMerchant.find((r) => r.name === "CHIPOTLE");
    expect(chipotle?.totalCents).toBe(5000);
    expect(chipotle?.count).toBe(1);
    expect(chipotle?.pct).toBeCloseTo((5000 / 6300) * 100, 4);

    // savings & investments: 100000 out − 50000 withdrawn back = 50000 net
    expect(m.savedCents).toBe(50000);
    const ibkr = m.savingsByMerchant.find((r) => r.name === "IBKR");
    expect(ibkr?.totalCents).toBe(50000);
    expect(ibkr?.count).toBe(2);
    expect(ibkr?.pct).toBeCloseTo(100, 4);
    expect(m.savingsByMerchant.reduce((t, r) => t + r.totalCents, 0)).toBe(m.savedCents);

    // income sources: payroll + P2P in, % against total income
    const bySource = Object.fromEntries(m.incomeBySource.map((r) => [r.name, r]));
    expect(bySource["MICROSOFT"].totalCents).toBe(400000);
    expect(bySource["MICROSOFT"].count).toBe(1);
    expect(bySource["MICROSOFT"].pct).toBeCloseTo((400000 / 403000) * 100, 4);
    expect(bySource["AADIT"].totalCents).toBe(3000);
    expect(bySource["IBKR"]).toBeUndefined(); // savings withdrawal is not income
    expect(m.incomeBySource.reduce((t, r) => t + r.totalCents, 0)).toBe(m.incomeCents);
  });

  it("returns savingsRate null when there is no income", async () => {
    await seedTxn({ accountId: creditId, amountCents: -5000, categoryId: cat["Dining"] });
    const m = await computeMetrics(db, septMTD());
    expect(m.incomeCents).toBe(0);
    expect(m.savingsRate).toBeNull();
  });

  it("returns pct null when total spend is not positive", async () => {
    // only a refund → total spend negative
    await seedTxn({ accountId: creditId, amountCents: 1500, categoryId: cat["Shopping"] });
    const m = await computeMetrics(db, septMTD());
    expect(m.totalSpendCents).toBe(-1500);
    expect(m.spendByCategory[0].pct).toBeNull();
  });

  it("returns empty lists for a range with no data", async () => {
    await seedTxn({ accountId: creditId, amountCents: -5000, categoryId: cat["Dining"], postedAt: "2026-07-01" });
    const m = await computeMetrics(db, septMTD());
    expect(m.spendByCategory).toEqual([]);
    expect(m.spendByMerchant).toEqual([]);
    expect(m.totalSpendCents).toBe(0);
    expect(m.incomeBySource).toEqual([]);
    expect(m.savingsByMerchant).toEqual([]);
    expect(m.savedCents).toBe(0);
  });

  it("drills into one category's top merchants for the range", async () => {
    await seedTxn({ accountId: creditId, amountCents: -5000, categoryId: cat["Dining"], normalizedMerchant: "CHIPOTLE" });
    await seedTxn({ accountId: creditId, amountCents: -3000, categoryId: cat["Dining"], normalizedMerchant: "SWEETGREEN" });
    await seedTxn({ accountId: creditId, amountCents: -2000, categoryId: cat["Shopping"], normalizedMerchant: "OLDNAVY" });
    await seedTxn({ accountId: creditId, amountCents: -700, categoryId: null, normalizedMerchant: "MYSTERY" });
    await seedTxn({ accountId: creditId, amountCents: -9999, categoryId: cat["Dining"], normalizedMerchant: "OLD", postedAt: "2026-07-01" }); // out of range

    const dining = await computeMetrics(db, septMTD(), { category: "Dining" });
    expect(dining.categoryDrilldown?.name).toBe("Dining");
    expect(dining.categoryDrilldown?.totalCents).toBe(8000);
    expect(dining.categoryDrilldown?.rows.map((r) => [r.name, r.totalCents, r.count])).toEqual([
      ["CHIPOTLE", 5000, 1],
      ["SWEETGREEN", 3000, 1],
    ]);
    // share is of the category total, not of overall spend
    expect(dining.categoryDrilldown?.rows[0].pct).toBeCloseTo(62.5, 4);
    // the rest of the dashboard is unaffected by the drilldown
    expect(dining.totalSpendCents).toBe(10700);

    const uncat = await computeMetrics(db, septMTD(), { category: "(uncategorized)" });
    expect(uncat.categoryDrilldown?.totalCents).toBe(700);
    expect(uncat.categoryDrilldown?.rows.map((r) => r.name)).toEqual(["MYSTERY"]);

    const travel = await computeMetrics(db, septMTD(), { category: "Travel" });
    expect(travel.categoryDrilldown).toEqual({ name: "Travel", totalCents: 0, rows: [] });

    expect((await computeMetrics(db, septMTD())).categoryDrilldown).toBeNull();
  });
});
