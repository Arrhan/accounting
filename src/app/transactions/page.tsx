import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, transactions } from "@/db/schema";
import { formatCents } from "@/lib/format";
import { CategorySelect } from "@/components/category-select";
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

export default async function TransactionsPage() {
  const [cats, rows] = await Promise.all([
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
        isTransfer: transactions.isTransfer,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .orderBy(desc(transactions.postedAt))
      .limit(200),
  ]);

  return (
    <main className="mx-auto w-full max-w-[1600px] p-8">
      <Nav active="transactions" />
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
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className={row.isTransfer ? "opacity-60" : ""}
              >
                <TableCell className="whitespace-nowrap">
                  {row.postedAt.toISOString().slice(0, 10)}
                </TableCell>
                <TableCell className="whitespace-normal">{row.accountName}</TableCell>
                <TableCell className="whitespace-normal break-words">{row.description}</TableCell>
                <TableCell className="whitespace-normal">{row.payee ?? ""}</TableCell>
                <TableCell>
                  {row.isTransfer ? (
                    <span
                      className="text-muted-foreground text-xs"
                      title="Inter-account transfer — excluded from spending totals"
                    >
                      ⇄ transfer
                    </span>
                  ) : (
                    <CategorySelect
                      txnId={row.id}
                      categories={cats}
                      currentCategoryId={row.categoryId}
                    />
                  )}
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
