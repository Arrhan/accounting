import Link from "next/link";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { categories, transactions } from "@/db/schema";
import { reviewQueueWhere } from "@/lib/categorize";

export async function Nav({ active }: { active: "transactions" | "review" }) {
  const [uncat] = await db
    .select()
    .from(categories)
    .where(eq(categories.name, "Uncategorized"));
  const [{ n }] = await db
    .select({ n: count() })
    .from(transactions)
    .where(
      and(eq(transactions.isTransfer, false), reviewQueueWhere(uncat?.id ?? null)),
    );

  const linkClass = (isActive: boolean) =>
    isActive ? "font-semibold" : "text-muted-foreground hover:text-foreground";

  return (
    <nav className="mb-6 flex gap-4 text-sm">
      <Link href="/" className={linkClass(active === "transactions")}>
        Transactions
      </Link>
      <Link href="/review" className={linkClass(active === "review")}>
        Review{n > 0 ? ` (${n})` : ""}
      </Link>
    </nav>
  );
}
