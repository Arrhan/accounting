import { and, asc, count, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { categories, merchantMemory, rules, transactions } from "@/db/schema";
import { normalizeMerchant } from "@/lib/normalize";
import type { MerchantCategorizer } from "@/lib/sources/types";
import type { SyncDb } from "@/lib/sync";

export interface CategorizeResult {
  normalized: number;
  byRule: number;
  byMemory: number;
  byLlm: number;
  /** Merchants (not txns) left with categorized_by NULL, retried next run. */
  llmUnresolved: number;
  /** Review-queue size after the run. */
  uncategorized: number;
}

export const LLM_BATCH_SIZE = 40;
export const EXAMPLES_PER_MERCHANT = 3;
const CHUNK = 1000;

// Repeated inside every UPDATE's WHERE: closes the select-then-update race
// against a concurrent manual fix. Manual categorization is never overwritten.
const notManual = () =>
  or(
    isNull(transactions.categorizedBy),
    ne(transactions.categorizedBy, "manual"),
  );

/**
 * Single source of truth for the review-queue predicate (page, nav, pipeline).
 * Needs attention = never categorized, OR machine-assigned Uncategorized. A
 * manual "Uncategorized" is a settled human decision and drops out of the queue.
 */
export function reviewQueueWhere(uncategorizedId: number | null) {
  if (uncategorizedId === null) return isNull(transactions.categoryId);
  return or(
    isNull(transactions.categoryId),
    and(
      eq(transactions.categoryId, uncategorizedId),
      ne(transactions.categorizedBy, "manual"),
    ),
  );
}

type Candidate = {
  id: number;
  description: string;
  normalizedMerchant: string | null;
  categoryId: number | null;
  categorizedBy: string | null;
};

async function applyGrouped(
  db: SyncDb,
  assign: Map<number, number[]>,
  categorizedBy: "rule" | "memory" | "llm",
  now: Date,
): Promise<number> {
  let changed = 0;
  for (const [categoryId, ids] of assign) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await db
        .update(transactions)
        .set({ categoryId, categorizedBy, updatedAt: now })
        .where(and(inArray(transactions.id, ids.slice(i, i + CHUNK)), notManual()))
        .returning({ id: transactions.id });
      changed += rows.length;
    }
  }
  return changed;
}

function push<K>(assign: Map<K, number[]>, key: K, id: number) {
  const list = assign.get(key) ?? [];
  list.push(id);
  assign.set(key, list);
}

/**
 * The categorization pipeline (ARCHITECTURE order, first hit wins):
 * rules → merchant memory → LLM fallback → stays in the review queue.
 * Retroactive by design: rules and memory re-apply to every non-manual
 * transaction on every run. The LLM is only consulted for never-categorized
 * transactions, one question per normalized merchant.
 */
export async function categorizeTransactions({
  db,
  categorizer,
  now = new Date(),
}: {
  db: SyncDb;
  categorizer: MerchantCategorizer | null;
  now?: Date;
}): Promise<CategorizeResult> {
  // Step 0 — backfill normalized_merchant where missing.
  const missing = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      payee: transactions.payee,
    })
    .from(transactions)
    .where(isNull(transactions.normalizedMerchant));
  const byValue = new Map<string, number[]>();
  for (const row of missing) {
    const norm = normalizeMerchant(row.description, row.payee);
    if (norm) push(byValue, norm, row.id);
  }
  let normalized = 0;
  for (const [value, ids] of byValue) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await db
        .update(transactions)
        .set({ normalizedMerchant: value, updatedAt: now })
        .where(inArray(transactions.id, ids.slice(i, i + CHUNK)));
    }
    normalized += ids.length;
  }

  const cats = await db.select().from(categories);
  const catByName = new Map(cats.map((c) => [c.name, c.id]));
  const uncategorizedId = catByName.get("Uncategorized") ?? null;
  const categoryNames = cats.map((c) => c.name);

  const candidates: Candidate[] = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      categorizedBy: transactions.categorizedBy,
    })
    .from(transactions)
    .where(notManual());

  // Step 1 — rules (priority asc, first hit wins).
  const allRules = await db
    .select()
    .from(rules)
    .orderBy(asc(rules.priority), asc(rules.id));
  const compiled: { categoryId: number; test: (d: string) => boolean }[] = [];
  for (const r of allRules) {
    const regexBody = r.pattern.match(/^\/(.+)\/$/);
    if (regexBody) {
      try {
        const re = new RegExp(regexBody[1], "i");
        compiled.push({ categoryId: r.categoryId, test: (d) => re.test(d) });
      } catch {
        console.warn(`Skipping rule ${r.id}: invalid regex pattern`);
      }
    } else {
      const needle = r.pattern.toLowerCase();
      compiled.push({
        categoryId: r.categoryId,
        test: (d) => d.toLowerCase().includes(needle),
      });
    }
  }

  const ruleAssign = new Map<number, number[]>();
  const afterRules: Candidate[] = [];
  for (const c of candidates) {
    const hit = compiled.find((r) => r.test(c.description));
    if (hit) {
      if (c.categoryId !== hit.categoryId || c.categorizedBy !== "rule") {
        push(ruleAssign, hit.categoryId, c.id);
      }
      // Rule-matched rows never fall through to memory/LLM.
    } else {
      afterRules.push(c);
    }
  }
  const byRule = await applyGrouped(db, ruleAssign, "rule", now);

  // Step 2 — merchant memory (outranks llm; overwrites 'memory'/'llm' rows).
  const memRows = await db.select().from(merchantMemory);
  const memory = new Map(memRows.map((m) => [m.normalizedMerchant, m.categoryId]));
  const memAssign = new Map<number, number[]>();
  const afterMemory: Candidate[] = [];
  for (const c of afterRules) {
    const target = c.normalizedMerchant
      ? memory.get(c.normalizedMerchant)
      : undefined;
    if (target !== undefined) {
      if (c.categoryId !== target || c.categorizedBy !== "memory") {
        push(memAssign, target, c.id);
      }
    } else {
      afterMemory.push(c);
    }
  }
  const byMemory = await applyGrouped(db, memAssign, "memory", now);

  // Step 3 — LLM fallback, only for never-categorized txns with a merchant.
  const byMerchant = new Map<string, { ids: number[]; examples: string[] }>();
  for (const c of afterMemory) {
    if (c.categorizedBy !== null || !c.normalizedMerchant) continue;
    const entry = byMerchant.get(c.normalizedMerchant) ?? { ids: [], examples: [] };
    entry.ids.push(c.id);
    if (
      entry.examples.length < EXAMPLES_PER_MERCHANT &&
      !entry.examples.includes(c.description)
    ) {
      entry.examples.push(c.description);
    }
    byMerchant.set(c.normalizedMerchant, entry);
  }

  let byLlm = 0;
  let llmUnresolved = 0;
  if (categorizer && uncategorizedId !== null && byMerchant.size > 0) {
    const merchants = [...byMerchant.entries()].map(([merchant, v]) => ({
      merchant,
      examples: v.examples,
    }));
    for (let i = 0; i < merchants.length; i += LLM_BATCH_SIZE) {
      const batch = merchants.slice(i, i + LLM_BATCH_SIZE);
      let answers: Map<string, { category: string; confident: boolean }>;
      try {
        answers = await categorizer.categorize(batch, categoryNames);
      } catch (err) {
        // Redaction-safe: message only, never the error object.
        console.error(
          "LLM categorization batch failed:",
          err instanceof Error ? err.message : "unknown error",
        );
        llmUnresolved += batch.length;
        continue;
      }
      const llmAssign = new Map<number, number[]>();
      for (const { merchant } of batch) {
        const answer = answers.get(merchant);
        if (!answer) {
          llmUnresolved += 1; // stays NULL; retried next run
          continue;
        }
        const target = answer.confident
          ? (catByName.get(answer.category) ?? uncategorizedId)
          : uncategorizedId;
        for (const id of byMerchant.get(merchant)!.ids) {
          push(llmAssign, target, id);
        }
      }
      byLlm += await applyGrouped(db, llmAssign, "llm", now);
    }
  } else {
    llmUnresolved = byMerchant.size;
  }

  const [queue] = await db
    .select({ n: count() })
    .from(transactions)
    .where(
      and(eq(transactions.isTransfer, false), reviewQueueWhere(uncategorizedId)),
    );

  return {
    normalized,
    byRule,
    byMemory,
    byLlm,
    llmUnresolved,
    uncategorized: queue.n,
  };
}

/**
 * Retroactively apply a merchant-memory entry (used by the pipeline's memory
 * pass counterpart in /review after a manual fix). Only claims rows owned by
 * nothing ('NULL'), 'memory', or 'llm' — never 'manual', and never 'rule'
 * (rules outrank memory; converting a rule row would flap back next run).
 */
export async function applyMemoryToMerchant({
  db,
  normalizedMerchant,
  categoryId,
  now = new Date(),
}: {
  db: SyncDb;
  normalizedMerchant: string;
  categoryId: number;
  now?: Date;
}): Promise<number> {
  const changed = await db
    .update(transactions)
    .set({ categoryId, categorizedBy: "memory", updatedAt: now })
    .where(
      and(
        eq(transactions.normalizedMerchant, normalizedMerchant),
        or(
          isNull(transactions.categorizedBy),
          inArray(transactions.categorizedBy, ["memory", "llm"]),
        ),
        // Skip rows that already carry exactly this categorization.
        or(
          isNull(transactions.categoryId),
          ne(transactions.categoryId, categoryId),
          isNull(transactions.categorizedBy),
          ne(transactions.categorizedBy, "memory"),
        ),
      ),
    )
    .returning({ id: transactions.id });
  return changed.length;
}
