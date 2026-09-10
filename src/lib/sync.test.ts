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
import type { FetchResult, TransactionSource } from "@/lib/sources/types";
import { runSync } from "@/lib/sync";

const { accounts, balanceSnapshots, categories, connections, transactions } =
  schema;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  // Run the real drizzle-kit migrations — the tests must exercise the exact
  // DDL (composite unique indexes) that production gets.
  await migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  // categories keeps its seed — the taxonomy migration is part of the fixture.
  await db.execute(
    sql`TRUNCATE connections, accounts, balance_snapshots, transactions RESTART IDENTITY CASCADE`,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-09-01T12:00:00Z");

// Base fixture: one connection, two accounts sharing a txn id (the dedup key
// must treat them as distinct rows), plus balances.
function baseFixture(): FetchResult {
  return {
    connections: [{ simplefinConnId: "CON-1", name: "Demo Bank" }],
    accounts: [
      {
        simplefinAccountId: "ACC-A",
        simplefinConnId: "CON-1",
        name: "Checking",
        currency: "USD",
        balanceCents: 120436,
        balanceDate: new Date("2026-09-01T00:00:00Z"),
        transactions: [
          {
            simplefinTxnId: "T1",
            postedAt: new Date("2026-08-20T10:00:00Z"),
            transactedAt: new Date("2026-08-20T10:00:00Z"),
            amountCents: -1550,
            description: "Fishing bait",
            payee: "John's Fishin Shack",
            memo: "BAIT",
            mcc: "5812",
          },
          {
            simplefinTxnId: "T2",
            postedAt: new Date("2026-08-25T10:00:00Z"),
            transactedAt: null,
            amountCents: 196000,
            description: "Pay day!",
            payee: null,
            memo: null,
            mcc: null,
          },
        ],
      },
      {
        simplefinAccountId: "ACC-B",
        simplefinConnId: "CON-1",
        name: "Savings",
        currency: "USD",
        balanceCents: 11538551,
        balanceDate: new Date("2026-09-01T00:00:00Z"),
        transactions: [
          {
            simplefinTxnId: "T1", // same id as ACC-A's T1, different amount
            postedAt: new Date("2026-08-20T10:00:00Z"),
            transactedAt: null,
            amountCents: -1996,
            description: "Fishing bait",
            payee: null,
            memo: null,
            mcc: null,
          },
        ],
      },
    ],
    errors: [],
  };
}

function sourceOf(result: FetchResult): TransactionSource {
  return { fetchAccounts: async () => result };
}

async function allTxns() {
  return db
    .select()
    .from(transactions)
    .orderBy(transactions.accountId, transactions.simplefinTxnId);
}

describe("runSync", () => {
  it("inserts connections, accounts, transactions, and snapshots", async () => {
    const result = await runSync({ db, source: sourceOf(baseFixture()), now: NOW });

    expect(result).toMatchObject({
      connections: 1,
      accounts: 2,
      transactionsChanged: 3,
      snapshotsChanged: 2,
      anomalies: 0,
      errors: [],
    });

    const txns = await allTxns();
    expect(txns).toHaveLength(3);
    // Same simplefin_txn_id in two accounts stays two distinct rows.
    const t1s = txns.filter((t) => t.simplefinTxnId === "T1");
    expect(t1s).toHaveLength(2);
    expect(new Set(t1s.map((t) => t.amountCents))).toEqual(
      new Set([-1550, -1996]),
    );

    const snaps = await db.select().from(balanceSnapshots);
    expect(snaps).toHaveLength(2);
    expect(snaps.every((s) => s.date === "2026-09-01")).toBe(true);

    const [conn] = await db.select().from(connections);
    expect(conn.status).toBe("ok");
    expect(conn.lastSyncedAt?.getTime()).toBe(NOW.getTime());
  });

  it("is idempotent: an identical re-sync changes nothing", async () => {
    await runSync({ db, source: sourceOf(baseFixture()), now: NOW });
    const before = await allTxns();

    const later = new Date(NOW.getTime() + 60_000);
    const result = await runSync({
      db,
      source: sourceOf(baseFixture()),
      now: later,
    });

    expect(result.transactionsChanged).toBe(0);
    expect(result.snapshotsChanged).toBe(0);

    const after = await allTxns();
    expect(after).toHaveLength(before.length);
    // updated_at (and everything else) is byte-identical: setWhere skipped
    // the no-op update.
    expect(after).toEqual(before);
  });

  it("updates provider data but preserves enrichment columns", async () => {
    await runSync({ db, source: sourceOf(baseFixture()), now: NOW });

    // Simulate a later slice enriching a row.
    await db
      .update(transactions)
      .set({ categoryId: 1, isTransfer: true, categorizedBy: "manual" })
      .where(eq(transactions.simplefinTxnId, "T2"));

    const changed = baseFixture();
    changed.accounts[0].transactions[1].amountCents = 200000; // T2

    const later = new Date(NOW.getTime() + 60_000);
    const result = await runSync({ db, source: sourceOf(changed), now: later });
    expect(result.transactionsChanged).toBe(1);

    const [t2] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.simplefinTxnId, "T2"));
    expect(t2.amountCents).toBe(200000);
    expect(t2.updatedAt.getTime()).toBe(later.getTime());
    expect(t2.createdAt.getTime()).toBe(NOW.getTime());
    // Enrichment survived the re-sync.
    expect(t2.categoryId).toBe(1);
    expect(t2.isTransfer).toBe(true);
    expect(t2.categorizedBy).toBe("manual");
  });

  it("dedupes intra-batch duplicate keys (last wins)", async () => {
    const fixture = baseFixture();
    fixture.accounts[0].transactions.push({
      ...fixture.accounts[0].transactions[0], // duplicate of T1 in ACC-A
      amountCents: -9999,
    });

    const result = await runSync({ db, source: sourceOf(fixture), now: NOW });
    expect(result.transactionsChanged).toBe(3);

    const txns = await allTxns();
    expect(txns).toHaveLength(3);
    const accA = await db
      .select()
      .from(accounts)
      .where(eq(accounts.simplefinAccountId, "ACC-A"));
    const [t1a] = txns.filter(
      (t) => t.accountId === accA[0].id && t.simplefinTxnId === "T1",
    );
    expect(t1a.amountCents).toBe(-9999);
  });

  it("upserts same-day balance snapshots in place", async () => {
    await runSync({ db, source: sourceOf(baseFixture()), now: NOW });

    const changed = baseFixture();
    changed.accounts[0].balanceCents = 130000;
    const result = await runSync({
      db,
      source: sourceOf(changed),
      now: new Date(NOW.getTime() + 3_600_000),
    });
    // Only the changed account's snapshot counts as changed.
    expect(result.snapshotsChanged).toBe(1);

    const snaps = await db.select().from(balanceSnapshots);
    expect(snaps).toHaveLength(2);
    expect(new Set(snaps.map((s) => s.balanceCents))).toEqual(
      new Set([130000, 11538551]),
    );
  });

  it("persists connection errors and recovers on a clean sync", async () => {
    const withError = baseFixture();
    withError.errors = [
      {
        code: "conn.auth",
        message: "Institution login needs attention.",
        connId: "CON-1",
      },
      { code: "gen.api", message: "Range capped." }, // global, no conn_id
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runSync({ db, source: sourceOf(withError), now: NOW });
    expect(result.errors).toEqual([
      { code: "gen.api", message: "Range capped." },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gen.api"),
    );

    let [conn] = await db.select().from(connections);
    expect(conn.status).toBe("error");
    expect(conn.lastError).toBe("conn.auth: Institution login needs attention.");

    await runSync({ db, source: sourceOf(baseFixture()), now: NOW });
    [conn] = await db.select().from(connections);
    expect(conn.status).toBe("ok");
    expect(conn.lastError).toBeNull();
  });

  it("logs previously-seen transactions missing from the window, never deletes", async () => {
    await runSync({ db, source: sourceOf(baseFixture()), now: NOW });

    const missingT2 = baseFixture();
    missingT2.accounts[0].transactions = [
      missingT2.accounts[0].transactions[0], // drop T2
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runSync({ db, source: sourceOf(missingT2), now: NOW });
    expect(result.anomalies).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("T2"));

    // The row is still there.
    const txns = await allTxns();
    expect(txns).toHaveLength(3);
  });

  it("has the seeded category taxonomy from migrations", async () => {
    const cats = await db.select().from(categories);
    expect(cats).toHaveLength(15);
    const nonSpend = cats.filter((c) => !c.isSpend).map((c) => c.name);
    expect(nonSpend.sort()).toEqual(["Income", "Transfers"]);
  });
});
