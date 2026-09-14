import Link from "next/link";
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

type DashboardParams = {
  range?: string;
  start?: string;
  end?: string;
  category?: string;
};

/** Build a dashboard URL that keeps the current range and toggles the category. */
function dashboardHref(params: DashboardParams): string {
  const p = new URLSearchParams();
  if (params.range) p.set("range", params.range);
  if (params.start) p.set("start", params.start);
  if (params.end) p.set("end", params.end);
  if (params.category) p.set("category", params.category);
  const qs = p.toString();
  return qs ? `/?${qs}` : "/";
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<DashboardParams>;
}) {
  const { range, start, end, category } = await searchParams;
  const resolved = resolveRange(range, new Date(), start, end);

  const [conns, metrics] = await Promise.all([
    db.select().from(connections),
    computeMetrics(db, resolved, { category }),
  ]);
  const { errored, newestSync, stale } = syncHealth(conns);

  // Each category label links to its own drilldown; the open one links back out.
  const categoryRows = metrics.spendByCategory.map((row) => ({
    ...row,
    active: row.name === category,
    href: dashboardHref({
      range,
      start,
      end,
      category: row.name === category ? undefined : row.name,
    }),
  }));

  return (
    <main className="mx-auto w-full max-w-[1600px] p-8">
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

      <TimeRangeSelector
        active={resolved.preset}
        start={start}
        end={end}
        category={category}
      />

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-5">
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
        <StatTile
          label="Saved & invested"
          value={formatCents(metrics.savedCents)}
        />
      </div>

      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Spend by category</h2>
          {!metrics.categoryDrilldown && (
            <span className="text-muted-foreground text-xs">
              Click a category to see its top merchants
            </span>
          )}
        </div>
        <RankedBars rows={categoryRows} />
      </section>

      {metrics.categoryDrilldown && (
        <section className="mb-8">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-medium">
              Top merchants in {metrics.categoryDrilldown.name}
              <span className="text-muted-foreground ml-2 font-normal tabular-nums">
                {formatCents(metrics.categoryDrilldown.totalCents)}
              </span>
            </h2>
            <Link
              href={dashboardHref({ range, start, end })}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              Clear ×
            </Link>
          </div>
          <RankedBars
            rows={metrics.categoryDrilldown.rows}
            emptyMessage="No spending in this category for this range."
          />
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Spend by merchant</h2>
        <RankedBars rows={metrics.spendByMerchant} />
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Income sources</h2>
        <RankedBars
          rows={metrics.incomeBySource}
          emptyMessage="No income in this range."
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Savings &amp; investments</h2>
        <RankedBars
          rows={metrics.savingsByMerchant}
          emptyMessage="Nothing moved to savings or investments in this range."
        />
      </section>
    </main>
  );
}
