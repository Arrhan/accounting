import { db } from "@/db";
import { connections } from "@/db/schema";
import { formatCents } from "@/lib/format";
import { computeMetrics, resolveRange } from "@/lib/metrics";
import { Nav } from "@/components/nav";
import { RankedBars } from "@/components/ranked-bars";
import { StatTile } from "@/components/stat-tile";
import { TimeRangeSelector } from "@/components/time-range-selector";

export const dynamic = "force-dynamic";

// Daily cron cadence + Vercel Hobby's 59-minute firing window + slack.
const STALE_MS = 36 * 60 * 60 * 1000;

type Connection = typeof connections.$inferSelect;

function syncHealth(conns: Connection[]) {
  const errored = conns.filter((c) => c.status === "error");
  const newestSync = conns.reduce<Date | null>(
    (max, c) =>
      c.lastSyncedAt && (!max || c.lastSyncedAt > max) ? c.lastSyncedAt : max,
    null,
  );
  const stale =
    conns.length > 0 &&
    (!newestSync || Date.now() - newestSync.getTime() > STALE_MS);
  return { errored, newestSync, stale };
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; start?: string; end?: string }>;
}) {
  const { range, start, end } = await searchParams;
  const resolved = resolveRange(range, new Date(), start, end);

  const [conns, metrics] = await Promise.all([
    db.select().from(connections),
    computeMetrics(db, resolved),
  ]);
  const { errored, newestSync, stale } = syncHealth(conns);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Nav active="dashboard" />
      <h1 className="mb-6 text-xl font-semibold">Dashboard</h1>

      {(errored.length > 0 || stale) && (
        <div className="border-destructive/50 bg-destructive/10 text-destructive mb-4 rounded-lg border p-3 text-sm">
          {errored.map((c) => (
            <p key={c.id}>
              {c.name}: sync error{c.lastError ? ` — ${c.lastError}` : ""}
            </p>
          ))}
          {stale && (
            <p>
              Last sync:{" "}
              {newestSync
                ? `${newestSync.toISOString().slice(0, 16).replace("T", " ")} UTC`
                : "never"}{" "}
              — data may be out of date.
            </p>
          )}
        </div>
      )}

      <TimeRangeSelector active={resolved.preset} start={start} end={end} />

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Net cash flow"
          value={formatCents(metrics.netCashFlowCents)}
          negative={metrics.netCashFlowCents < 0}
        />
        <StatTile label="Income" value={formatCents(metrics.incomeCents)} />
        <StatTile label="Spend" value={formatCents(metrics.totalSpendCents)} />
        <StatTile
          label="Savings rate"
          value={
            metrics.savingsRate == null
              ? "—"
              : `${(metrics.savingsRate * 100).toFixed(1)}%`
          }
          negative={metrics.savingsRate != null && metrics.savingsRate < 0}
        />
      </div>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Spend by category</h2>
        <RankedBars rows={metrics.spendByCategory} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Spend by merchant</h2>
        <RankedBars rows={metrics.spendByMerchant} />
      </section>
    </main>
  );
}
