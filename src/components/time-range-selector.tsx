import Link from "next/link";
import type { RangePreset } from "@/lib/metrics";
import { Button } from "@/components/ui/button";

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "last-week", label: "Last week" },
  { key: "last-month", label: "Last month" },
  { key: "month-to-date", label: "Month to date" },
];

export function TimeRangeSelector({
  active,
  start,
  end,
}: {
  active: RangePreset;
  start?: string;
  end?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-4">
      <div className="flex gap-3 text-sm">
        {PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`/?range=${p.key}`}
            className={
              active === p.key
                ? "font-semibold"
                : "text-muted-foreground hover:text-foreground"
            }
          >
            {p.label}
          </Link>
        ))}
      </div>
      <form method="get" action="/" className="flex items-center gap-2">
        <input type="hidden" name="range" value="custom" />
        <input
          type="date"
          name="start"
          defaultValue={active === "custom" ? start : undefined}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3"
        />
        <span className="text-muted-foreground text-sm">to</span>
        <input
          type="date"
          name="end"
          defaultValue={active === "custom" ? end : undefined}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3"
        />
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
      </form>
    </div>
  );
}
