export function StatTile({
  label,
  value,
  negative = false,
}: {
  label: string;
  value: string;
  negative?: boolean;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={`text-2xl font-semibold tabular-nums ${negative ? "text-destructive" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}
