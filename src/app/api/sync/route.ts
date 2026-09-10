import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  categorizeTransactions,
  type CategorizeResult,
} from "@/lib/categorize";
import { createClaudeCategorizer } from "@/lib/sources/llm";
import { createSimpleFinSource } from "@/lib/sources/simplefin";
import { runSync } from "@/lib/sync";
import { matchTransfers } from "@/lib/transfers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Fail closed: no configured secret means no access.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (!accessUrl) {
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }

  // Optional ?window=N (days, 1-90) for the one-time 60-day backfill and
  // catch-up after outages. The bridge caps ranges at 90 days.
  const windowParam = Number(new URL(request.url).searchParams.get("window"));
  const windowDays =
    Number.isInteger(windowParam) && windowParam >= 1 && windowParam <= 90
      ? windowParam
      : 30;

  try {
    const result = await runSync({
      db,
      source: createSimpleFinSource(accessUrl),
      windowDays,
    });

    // Categorize after sync; a categorization failure must not fail the sync.
    let categorization: CategorizeResult | null = null;
    let categorizeError: string | undefined;
    try {
      const claudeKey = process.env.CLAUDE_KEY;
      categorization = await categorizeTransactions({
        db,
        categorizer: claudeKey ? createClaudeCategorizer(claudeKey) : null,
      });
    } catch (err) {
      console.error(
        "Categorization failed:",
        err instanceof Error ? err.message : "unknown error",
      );
      categorizeError = "categorize_failed";
    }

    // Match inter-account transfers; a failure here must not fail the sync.
    let transfers: Awaited<ReturnType<typeof matchTransfers>> | null = null;
    let transfersError: string | undefined;
    try {
      transfers = await matchTransfers({ db });
    } catch (err) {
      console.error(
        "Transfer matching failed:",
        err instanceof Error ? err.message : "unknown error",
      );
      transfersError = "transfers_failed";
    }

    return NextResponse.json({
      ...result,
      categorization,
      categorizeError,
      transfers,
      transfersError,
    });
  } catch (err) {
    // Client errors are redaction-safe by contract; log message only, never
    // the error object (causes could embed URLs).
    console.error(
      "Sync failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ error: "sync_failed" }, { status: 500 });
  }
}
