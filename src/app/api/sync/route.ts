import { NextResponse } from "next/server";
import { db } from "@/db";
import { createSimpleFinSource } from "@/lib/sources/simplefin";
import { runSync } from "@/lib/sync";

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

  try {
    const result = await runSync({
      db,
      source: createSimpleFinSource(accessUrl),
    });
    return NextResponse.json(result);
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
