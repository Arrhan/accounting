import Link from "next/link";
import { formatCents } from "@/lib/format";

export interface RankedRow {
  name: string;
  totalCents: number;
  pct: number | null;
  barPct: number;
  count?: number;
  /** When set, the label becomes a link (e.g. to drill into the row). */
  href?: string;
  /** Highlights the row as the currently selected one. */
  active?: boolean;
}

export function RankedBars({
  rows,
  emptyMessage = "No spending in this range.",
}: {
  rows: RankedRow[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyMessage}</p>;
  }
  return (
    <div className="space-y-0.5">
      {rows.map((row) => {
        const negative = row.totalCents < 0;
        const labelClass = `w-40 shrink-0 truncate text-sm ${
          row.active ? "font-semibold" : ""
        }`;
        return (
          <div
            key={row.name}
            className="flex items-center gap-3"
            title={`${row.name} — ${formatCents(row.totalCents)}${
              row.count != null ? ` · ${row.count} txns` : ""
            }`}
          >
            {row.href ? (
              <Link href={row.href} className={`${labelClass} hover:underline`}>
                {row.name}
              </Link>
            ) : (
              <span className={labelClass}>{row.name}</span>
            )}
            <div className="bg-muted relative h-6 flex-1 rounded-sm">
              <div
                className={
                  negative
                    ? "border-primary/40 h-full rounded-sm border bg-transparent"
                    : "bg-primary h-full rounded-sm"
                }
                style={{ width: `${row.barPct}%` }}
              />
            </div>
            <span
              className={`w-24 shrink-0 text-right text-sm tabular-nums ${
                negative ? "text-muted-foreground" : ""
              }`}
            >
              {formatCents(row.totalCents)}
            </span>
            <span className="text-muted-foreground w-12 shrink-0 text-right text-xs tabular-nums">
              {row.pct == null ? "—" : `${row.pct.toFixed(0)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
