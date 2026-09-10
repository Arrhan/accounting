"use client";

import { useState, useTransition } from "react";
import { categorizeTxn } from "@/app/review/actions";

type Category = { id: number; name: string };

/**
 * Auto-saving category dropdown. Selecting a category persists immediately
 * (a manual fix — memorized + applied retroactively) and updates in place,
 * so there's no Save button and no full-table flash.
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
  const [value, setValue] = useState(
    currentCategoryId != null ? String(currentCategoryId) : "",
  );
  const [pending, startTransition] = useTransition();

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    const previous = value;
    setValue(next); // reflect the choice instantly
    startTransition(async () => {
      try {
        const form = new FormData();
        form.set("txnId", String(txnId));
        form.set("categoryId", next);
        await categorizeTxn(form);
      } catch {
        setValue(previous); // revert if the save failed
      }
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
