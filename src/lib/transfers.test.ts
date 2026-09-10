import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as schema from "@/db/schema";
import { findTransferPairs, matchTransfers, type MatchTxn } from "@/lib/transfers";

const { accounts, connections, transactions } = schema;

let idSeq = 0;
function txn(over: Partial<MatchTxn>): MatchTxn {
  idSeq += 1;
  return {
    id: idSeq,
    accountId: 1,
    accountType: "checking",
    date: "2026-08-01",
    amountCents: -100,
    ...over,
  };
}

describe("findTransferPairs", () => {
  it("matches a card payment: checking-negative to credit-positive", () => {
    const c = txn({ id: 1, accountId: 1, accountType: "checking", amountCents: -196499, date: "2026-07-16" });
    const o = txn({ id: 2, accountId: 2, accountType: "credit", amountCents: 196499, date: "2026-07-15" });
    expect(findTransferPairs([c, o])).toEqual([[1, 2]]);
  });

  it("nearest-date greedy resolves a shared-amount ambiguity", () => {
    // True pair: checking -20 (08-18) <-> Savor +20 (08-18), 0 days.
    // Decoy: a P2P checking -20 (08-15), 3 days from the Savor +20.
    const truePay = txn({ id: 10, accountId: 1, accountType: "checking", amountCents: -2000, date: "2026-08-18" });
    const p2p = txn({ id: 11, accountId: 1, accountType: "checking", amountCents: -2000, date: "2026-08-15" });
    const savor = txn({ id: 12, accountId: 2, accountType: "credit", amountCents: 2000, date: "2026-08-18" });
    const pairs = findTransferPairs([p2p, truePay, savor]);
    expect(pairs).toEqual([[10, 12]]); // p2p (11) left unmatched
  });

  it("does not match same-account opposite amounts (P2P within checking)", () => {
    const out = txn({ id: 20, accountId: 1, accountType: "checking", amountCents: -6700, date: "2026-07-24" });
    const inn = txn({ id: 21, accountId: 1, accountType: "checking", amountCents: 6700, date: "2026-07-24" });
    expect(findTransferPairs([out, inn])).toEqual([]);
  });

  it("does not match a refund (credit-negative) against checking-positive", () => {
    const refund = txn({ id: 30, accountId: 2, accountType: "credit", amountCents: -4600, date: "2026-07-19" });
    const received = txn({ id: 31, accountId: 1, accountType: "checking", amountCents: 4600, date: "2026-07-19" });
    expect(findTransferPairs([refund, received])).toEqual([]);
  });

  it("honors the 5-calendar-day window", () => {
    const mk = (cDate: string, oDate: string) => [
      txn({ id: 40, accountId: 1, accountType: "checking", amountCents: -5000, date: cDate }),
      txn({ id: 41, accountId: 2, accountType: "credit", amountCents: 5000, date: oDate }),
    ];
    expect(findTransferPairs(mk("2026-08-01", "2026-08-06"))).toEqual([[40, 41]]); // 5 days
    expect(findTransferPairs(mk("2026-08-01", "2026-08-07"))).toEqual([]); // 6 days
  });

  it("does not match two credit accounts", () => {
    const a = txn({ id: 50, accountId: 2, accountType: "credit", amountCents: -5000 });
    const b = txn({ id: 51, accountId: 3, accountType: "credit", amountCents: 5000 });
    expect(findTransferPairs([a, b])).toEqual([]);
  });

  it("skips accounts with unknown type", () => {
    const a = txn({ id: 60, accountId: 1, accountType: null, amountCents: -5000 });
    const b = txn({ id: 61, accountId: 2, accountType: "credit", amountCents: 5000 });
    expect(findTransferPairs([a, b])).toEqual([]);
  });

  it("requires equal magnitude", () => {
    const a = txn({ id: 70, accountId: 1, accountType: "checking", amountCents: -5000 });
    const b = txn({ id: 71, accountId: 2, accountType: "credit", amountCents: 4999 });
    expect(findTransferPairs([a, b])).toEqual([]);
  });
});

describe("matchTransfers (PGlite)", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let checkingId: number;
  let creditId: number;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    await client.close();
  });

  let seq = 0;
  async function seed(accountId: number, amountCents: number, date: string) {
    seq += 1;
    const [row] = await db
      .insert(transactions)
      .values({
        accountId,
        simplefinTxnId: `T${seq}`,
        postedAt: new Date(`${date}T12:00:00Z`),
        amountCents,
        description: "x",
      })
      .returning({ id: transactions.id });
    return row.id;
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

  it("marks a matched pair symmetrically and leaves others alone", async () => {
    const payOut = await seed(checkingId, -74343, "2026-08-13");
    const payIn = await seed(creditId, 74343, "2026-08-12");
    const p2p = await seed(checkingId, -6700, "2026-08-13"); // no opposite

    const result = await matchTransfers({ db });
    expect(result).toEqual({ pairs: 1, marked: 2 });

    const all = await db.select().from(transactions);
    const byId = new Map(all.map((t) => [t.id, t]));
    expect(byId.get(payOut)!.isTransfer).toBe(true);
    expect(byId.get(payOut)!.transferPairId).toBe(payIn);
    expect(byId.get(payIn)!.isTransfer).toBe(true);
    expect(byId.get(payIn)!.transferPairId).toBe(payOut);
    expect(byId.get(p2p)!.isTransfer).toBe(false);
    expect(byId.get(p2p)!.transferPairId).toBeNull();
  });

  it("is idempotent across re-runs", async () => {
    await seed(checkingId, -50000, "2026-08-01");
    await seed(creditId, 50000, "2026-08-01");
    const first = await matchTransfers({ db });
    const second = await matchTransfers({ db });
    expect(second).toEqual(first);
    const marked = (await db.select().from(transactions)).filter((t) => t.isTransfer);
    expect(marked).toHaveLength(2);
  });

  it("clears a stale link when the pair no longer matches", async () => {
    const out = await seed(checkingId, -50000, "2026-08-01");
    await seed(creditId, 50000, "2026-08-01");
    await matchTransfers({ db });

    // Change one side's amount so the pair no longer matches, then re-run.
    await db
      .update(transactions)
      .set({ amountCents: -49999 })
      .where(eq(transactions.id, out));
    const result = await matchTransfers({ db });
    expect(result.pairs).toBe(0);

    const all = await db.select().from(transactions);
    for (const t of all) {
      expect(t.isTransfer).toBe(false);
      expect(t.transferPairId).toBeNull();
    }
  });
});
