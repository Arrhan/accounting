import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, connections, transactions } from "@/db/schema";
import { formatCents } from "@/lib/format";
import { categorizeTxn } from "@/app/review/actions";
import { Button } from "@/components/ui/button";
import { Nav } from "@/components/nav";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

// Daily cron cadence + Vercel Hobby's 59-minute firing window + slack.
const STALE_MS = 36 * 60 * 60 * 1000;

type Connection = typeof connections.$inferSelect;

function syncHealth(conns: Connection[]) {
  const errored = conns.filter((c) => c.status === "error");
  const newestSync = conns.reduce<Date | null>(
    (max, c) =>
      c.lastSyncedAt && (!max || c.lastSyncedAt > max) ? c.lastSyncedAt : max,
    null,
  );
  const stale =
    conns.length > 0 &&
    (!newestSync || Date.now() - newestSync.getTime() > STALE_MS);
  return { errored, newestSync, stale };
}

export default async function Home() {
  const [conns, cats, rows] = await Promise.all([
    db.select().from(connections),
    db.select().from(categories).orderBy(asc(categories.name)),
    db
      .select({
        id: transactions.id,
        postedAt: transactions.postedAt,
        accountName: accounts.name,
        description: transactions.description,
        payee: transactions.payee,
        amountCents: transactions.amountCents,
        currency: accounts.currency,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .orderBy(desc(transactions.postedAt))
      .limit(200),
  ]);

  const { errored, newestSync, stale } = syncHealth(conns);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Nav active="transactions" />
      <h1 className="mb-6 text-xl font-semibold">Transactions</h1>
      {(errored.length > 0 || stale) && (
        <div className="border-destructive/50 bg-destructive/10 text-destructive mb-4 rounded-lg border p-3 text-sm">
          {errored.map((c) => (
            <p key={c.id}>
              {c.name}: sync error{c.lastError ? ` — ${c.lastError}` : ""}
            </p>
          ))}
          {stale && (
            <p>
              Last sync:{" "}
              {newestSync
                ? `${newestSync.toISOString().slice(0, 16).replace("T", " ")} UTC`
                : "never"}{" "}
              — data may be out of date.
            </p>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No transactions yet — run a sync.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Posted</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {row.postedAt.toISOString().slice(0, 10)}
                </TableCell>
                <TableCell>{row.accountName}</TableCell>
                <TableCell>{row.description}</TableCell>
                <TableCell>{row.payee ?? ""}</TableCell>
                <TableCell>
                  {/* Saving counts as a manual fix: memorized for the merchant
                      and applied retroactively, never overwritten by automation. */}
                  <form action={categorizeTxn} className="flex items-center gap-1">
                    <input type="hidden" name="txnId" value={row.id} />
                    <select
                      name="categoryId"
                      required
                      defaultValue={row.categoryId ?? ""}
                      className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-7 rounded-lg border px-1.5 text-xs outline-none focus-visible:ring-3"
                    >
                      <option value="" disabled>
                        —
                      </option>
                      {cats.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" size="sm" variant="ghost">
                      Save
                    </Button>
                  </form>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCents(row.amountCents, row.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
