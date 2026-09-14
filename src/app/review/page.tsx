import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, transactions } from "@/db/schema";
import { reviewQueueWhere } from "@/lib/categorize";
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

export default async function ReviewPage() {
  const [uncat] = await db
    .select()
    .from(categories)
    .where(eq(categories.name, "Uncategorized"));

  const [cats, rows] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.name)),
    db
      .select({
        id: transactions.id,
        postedAt: transactions.postedAt,
        accountName: accounts.name,
        description: transactions.description,
        normalizedMerchant: transactions.normalizedMerchant,
        amountCents: transactions.amountCents,
        currency: accounts.currency,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(
        and(
          eq(transactions.isTransfer, false),
          reviewQueueWhere(uncat?.id ?? null),
        ),
      )
      .orderBy(desc(transactions.postedAt))
      .limit(200),
  ]);

  return (
    <main className="mx-auto w-full max-w-[1600px] p-8">
      <Nav active="review" />
      <h1 className="mb-6 text-xl font-semibold">Review queue</h1>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing to review — everything is categorized.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Posted</TableHead>
              <TableHead>Merchant</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Category</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {row.postedAt.toISOString().slice(0, 10)}
                </TableCell>
                <TableCell>{row.normalizedMerchant ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground whitespace-normal break-words">
                  {row.description}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCents(row.amountCents, row.currency)}
                </TableCell>
                <TableCell>
                  <CategorySelect
                    txnId={row.id}
                    categories={cats}
                    currentCategoryId={null}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
