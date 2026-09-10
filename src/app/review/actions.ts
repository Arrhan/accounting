"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { categories, merchantMemory, transactions } from "@/db/schema";
import { applyMemoryToMerchant } from "@/lib/categorize";

export async function categorizeTxn(formData: FormData): Promise<void> {
  const txnId = Number(formData.get("txnId"));
  const categoryId = Number(formData.get("categoryId"));
  if (!Number.isInteger(txnId) || !Number.isInteger(categoryId)) return;

  // Reject forged category ids.
  const [cat] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId));
  if (!cat) return;

  const now = new Date();
  const [txn] = await db
    .update(transactions)
    .set({ categoryId, categorizedBy: "manual", updatedAt: now })
    .where(eq(transactions.id, txnId))
    .returning({ normalizedMerchant: transactions.normalizedMerchant });

  // Every manual fix teaches merchant memory and re-applies retroactively.
  if (txn?.normalizedMerchant) {
    await db
      .insert(merchantMemory)
      .values({ normalizedMerchant: txn.normalizedMerchant, categoryId })
      .onConflictDoUpdate({
        target: merchantMemory.normalizedMerchant,
        set: { categoryId },
      });
    await applyMemoryToMerchant({
      db,
      normalizedMerchant: txn.normalizedMerchant,
      categoryId,
      now,
    });
  }

  revalidatePath("/review");
  revalidatePath("/transactions");
  revalidatePath("/"); // dashboard metrics change
}
