import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/db/schema";
import {
  applyMemoryToMerchant,
  categorizeTransactions,
} from "@/lib/categorize";
import type { MerchantCategorizer } from "@/lib/sources/types";

const { accounts, categories, connections, merchantMemory, rules, transactions } =
  schema;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let accountId: number;
let catId: Record<string, number>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  const cats = await db.select().from(categories);
  catId = Object.fromEntries(cats.map((c) => [c.name, c.id]));
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE connections, accounts, balance_snapshots, transactions, rules, merchant_memory RESTART IDENTITY CASCADE`,
  );
  const [conn] = await db
    .insert(connections)
    .values({ simplefinConnId: "CON-1", name: "Test Bank" })
    .returning({ id: connections.id });
  const [acct] = await db
    .insert(accounts)
    .values({
      connectionId: conn.id,
      simplefinAccountId: "ACC-1",
      name: "Checking",
      currency: "USD",
    })
    .returning({ id: accounts.id });
  accountId = acct.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

let txnSeq = 0;
async function seedTxn(overrides: Partial<typeof transactions.$inferInsert> = {}) {
  txnSeq += 1;
  const [row] = await db
    .insert(transactions)
    .values({
      accountId,
      simplefinTxnId: `T${txnSeq}`,
      postedAt: new Date("2026-09-01T00:00:00Z"),
      amountCents: -1000,
      description: "SOME MERCHANT",
      ...overrides,
    })
    .returning();
  return row;
}

/** Fake categorizer: answers from a lookup, records every batch it receives. */
function fakeCategorizer(
  answers: Record<string, { category: string; confident: boolean }>,
) {
  const calls: { merchant: string; examples: string[] }[][] = [];
  const categorizer: MerchantCategorizer = {
    async categorize(merchants) {
      calls.push(merchants);
      const out = new Map<string, { category: string; confident: boolean }>();
      for (const m of merchants) {
        if (answers[m.merchant]) out.set(m.merchant, answers[m.merchant]);
      }
      return out;
    },
  };
  return { calls, categorizer };
}

async function getTxn(id: number) {
  const [row] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
}

describe("categorizeTransactions", () => {
  it("backfills normalized_merchant from payee/description", async () => {
    const a = await seedTxn({
      description: "AplPay TST* BURMA LOSAN FRANCISCO CA",
      payee: null,
    });
    const b = await seedTxn({ description: "X", payee: "DoorDash" });

    const result = await categorizeTransactions({ db, categorizer: null });
    expect(result.normalized).toBe(2);
    expect((await getTxn(a.id)).normalizedMerchant).toBe("BURMA LOSAN");
    expect((await getTxn(b.id)).normalizedMerchant).toBe("DOORDASH");
  });

  it("applies rules by priority, first hit wins, substring case-insensitive", async () => {
    await db.insert(rules).values([
      { pattern: "uber", categoryId: catId["Transport"], priority: 10 },
      { pattern: "UBER EATS", categoryId: catId["Dining"], priority: 20 },
    ]);
    const t = await seedTxn({ description: "UBER EATS SAN FRANCISCO" });

    const result = await categorizeTransactions({ db, categorizer: null });
    expect(result.byRule).toBe(1);
    const row = await getTxn(t.id);
    // priority 10 ("uber" → Transport) outranks the more specific rule.
    expect(row.categoryId).toBe(catId["Transport"]);
    expect(row.categorizedBy).toBe("rule");
  });

  it("supports /regex/ patterns and skips invalid ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.insert(rules).values([
      { pattern: "/^payroll/", categoryId: catId["Income"], priority: 5 },
      { pattern: "/([bad/", categoryId: catId["Dining"], priority: 1 },
    ]);
    const t = await seedTxn({ description: "PAYROLL ACME CORP" });

    await categorizeTransactions({ db, categorizer: null });
    expect((await getTxn(t.id)).categoryId).toBe(catId["Income"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid regex"));
  });

  it("memory outranks llm and reclaims llm rows", async () => {
    const t = await seedTxn({
      description: "CHIPOTLE 123",
      normalizedMerchant: "CHIPOTLE",
      categoryId: catId["Shopping"],
      categorizedBy: "llm",
    });
    await db.insert(merchantMemory).values({
      normalizedMerchant: "CHIPOTLE",
      categoryId: catId["Dining"],
    });

    const result = await categorizeTransactions({ db, categorizer: null });
    expect(result.byMemory).toBe(1);
    const row = await getTxn(t.id);
    expect(row.categoryId).toBe(catId["Dining"]);
    expect(row.categorizedBy).toBe("memory");
  });

  it("never touches manual rows in any pass", async () => {
    await db.insert(rules).values({
      pattern: "chipotle",
      categoryId: catId["Shopping"],
      priority: 1,
    });
    await db.insert(merchantMemory).values({
      normalizedMerchant: "CHIPOTLE",
      categoryId: catId["Groceries"],
    });
    const t = await seedTxn({
      description: "CHIPOTLE 123",
      normalizedMerchant: "CHIPOTLE",
      categoryId: catId["Dining"],
      categorizedBy: "manual",
    });

    const { calls, categorizer } = fakeCategorizer({});
    await categorizeTransactions({ db, categorizer });
    const row = await getTxn(t.id);
    expect(row.categoryId).toBe(catId["Dining"]);
    expect(row.categorizedBy).toBe("manual");
    expect(calls.flat()).toHaveLength(0); // manual row never reaches the LLM
  });

  it("asks the LLM once per merchant and fans the answer out", async () => {
    const a = await seedTxn({ description: "DD DOORDASH 1", payee: "DoorDash" });
    const b = await seedTxn({ description: "DD DOORDASH 2", payee: "DoorDash" });
    const { calls, categorizer } = fakeCategorizer({
      DOORDASH: { category: "Dining", confident: true },
    });

    const result = await categorizeTransactions({ db, categorizer });
    expect(result.byLlm).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1); // one merchant, not two txns
    expect((await getTxn(a.id)).categoryId).toBe(catId["Dining"]);
    expect((await getTxn(b.id)).categorizedBy).toBe("llm");
  });

  it("does not re-ask the LLM for already-llm-categorized rows", async () => {
    await seedTxn({ description: "X", payee: "DoorDash" });
    const first = fakeCategorizer({
      DOORDASH: { category: "Dining", confident: true },
    });
    await categorizeTransactions({ db, categorizer: first.categorizer });
    expect(first.calls).toHaveLength(1);

    const second = fakeCategorizer({});
    const result = await categorizeTransactions({
      db,
      categorizer: second.categorizer,
    });
    expect(second.calls).toHaveLength(0);
    expect(result.byLlm).toBe(0);
    expect(result.byMemory).toBe(0); // idempotent, no memory churn either
  });

  it("routes low-confidence and unknown category names to Uncategorized", async () => {
    const low = await seedTxn({ description: "A", payee: "Mystery Shop" });
    const unknown = await seedTxn({ description: "B", payee: "Weird Inc" });
    const { categorizer } = fakeCategorizer({
      "MYSTERY SHOP": { category: "Dining", confident: false },
      "WEIRD INC": { category: "Not A Real Category", confident: true },
    });

    await categorizeTransactions({ db, categorizer });
    for (const t of [low, unknown]) {
      const row = await getTxn(t.id);
      expect(row.categoryId).toBe(catId["Uncategorized"]);
      expect(row.categorizedBy).toBe("llm");
    }
  });

  it("leaves unanswered merchants NULL and retries them next run", async () => {
    const t = await seedTxn({ description: "X", payee: "Silent Partner" });
    const first = fakeCategorizer({}); // answers nothing
    const r1 = await categorizeTransactions({ db, categorizer: first.categorizer });
    expect(r1.llmUnresolved).toBe(1);
    expect((await getTxn(t.id)).categorizedBy).toBeNull();

    const second = fakeCategorizer({
      "SILENT PARTNER": { category: "Shopping", confident: true },
    });
    const r2 = await categorizeTransactions({ db, categorizer: second.categorizer });
    expect(second.calls).toHaveLength(1); // re-asked
    expect(r2.byLlm).toBe(1);
    expect((await getTxn(t.id)).categoryId).toBe(catId["Shopping"]);
  });

  it("skips the LLM entirely when no categorizer is configured", async () => {
    await seedTxn({ description: "X", payee: "DoorDash" });
    const result = await categorizeTransactions({ db, categorizer: null });
    expect(result.byLlm).toBe(0);
    expect(result.llmUnresolved).toBe(1);
    expect(result.uncategorized).toBe(1);
  });

  it("excludes transfers from the queue count", async () => {
    await seedTxn({ description: "CARD PAYMENT", isTransfer: true });
    await seedTxn({ description: "REAL SPEND" });
    const result = await categorizeTransactions({ db, categorizer: null });
    expect(result.uncategorized).toBe(1);
  });

  it("drops manually-Uncategorized rows from the queue but keeps machine ones", async () => {
    // Human gave up on this one — a settled decision, should leave the queue.
    await seedTxn({
      description: "MYSTERY CHARGE",
      normalizedMerchant: "MYSTERY CHARGE",
      categoryId: catId["Uncategorized"],
      categorizedBy: "manual",
    });
    // Machine wasn't sure — still needs a human, stays in the queue.
    await seedTxn({
      description: "ODD ONE",
      normalizedMerchant: "ODD ONE",
      categoryId: catId["Uncategorized"],
      categorizedBy: "llm",
    });
    const result = await categorizeTransactions({ db, categorizer: null });
    expect(result.uncategorized).toBe(1);
  });
});

describe("applyMemoryToMerchant", () => {
  it("claims NULL/memory/llm rows but never manual or rule rows", async () => {
    const nullRow = await seedTxn({ normalizedMerchant: "CAFE" });
    const llmRow = await seedTxn({
      normalizedMerchant: "CAFE",
      categoryId: catId["Shopping"],
      categorizedBy: "llm",
    });
    const ruleRow = await seedTxn({
      normalizedMerchant: "CAFE",
      categoryId: catId["Transport"],
      categorizedBy: "rule",
    });
    const manualRow = await seedTxn({
      normalizedMerchant: "CAFE",
      categoryId: catId["Groceries"],
      categorizedBy: "manual",
    });

    const changed = await applyMemoryToMerchant({
      db,
      normalizedMerchant: "CAFE",
      categoryId: catId["Dining"],
    });
    expect(changed).toBe(2);
    expect((await getTxn(nullRow.id)).categoryId).toBe(catId["Dining"]);
    expect((await getTxn(llmRow.id)).categoryId).toBe(catId["Dining"]);
    expect((await getTxn(ruleRow.id)).categoryId).toBe(catId["Transport"]);
    expect((await getTxn(manualRow.id)).categoryId).toBe(catId["Groceries"]);
  });

  it("is idempotent: already-correct rows are not rewritten", async () => {
    await seedTxn({
      normalizedMerchant: "CAFE",
      categoryId: catId["Dining"],
      categorizedBy: "memory",
    });
    const changed = await applyMemoryToMerchant({
      db,
      normalizedMerchant: "CAFE",
      categoryId: catId["Dining"],
    });
    expect(changed).toBe(0);
  });
});
