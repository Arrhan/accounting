"use client";

import { useOptimistic, useTransition } from "react";
import { categorizeTxn } from "@/app/review/actions";

type Category = { id: number; name: string };

/**
 * Auto-saving category dropdown. Selecting a category persists immediately
 * (a manual fix — memorized + applied retroactively) and updates in place.
 *
 * The displayed value derives from the server prop, with an optimistic
 * override only while this row's own save is in flight. That means sibling
 * rows of the same merchant repaint to their new category as soon as the
 * server revalidates — no reload needed.
 */
export function CategorySelect({
  txnId,
  categories,
  currentCategoryId,
}: {
  txnId: number;
  categories: Category[];
  currentCategoryId: number | null;
}) {
  const serverValue = currentCategoryId != null ? String(currentCategoryId) : "";
  const [value, setOptimistic] = useOptimistic(serverValue);
  const [pending, startTransition] = useTransition();

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    startTransition(async () => {
      setOptimistic(next); // instant feedback on the edited row
      const form = new FormData();
      form.set("txnId", String(txnId));
      form.set("categoryId", next);
      await categorizeTxn(form);
      // On completion the server prop reflects the new value; the optimistic
      // override falls away and every affected row shows server truth.
    });
  }

  return (
    <select
      aria-label="Category"
      value={value}
      onChange={handleChange}
      disabled={pending}
      className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-7 rounded-lg border px-1.5 text-xs outline-none focus-visible:ring-3 disabled:opacity-50"
    >
      <option value="" disabled>
        —
      </option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
