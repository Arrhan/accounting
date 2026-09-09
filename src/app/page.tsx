import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, transactions } from "@/db/schema";
import { formatCents } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function Home() {
  const rows = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      accountName: accounts.name,
      description: transactions.description,
      payee: transactions.payee,
      amountCents: transactions.amountCents,
      currency: accounts.currency,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .orderBy(desc(transactions.postedAt))
    .limit(200);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="mb-6 text-xl font-semibold">Transactions</h1>
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
