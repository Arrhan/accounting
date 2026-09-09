import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Single-user gate. Cookie-only optimistic check — proxy runs on every
// request including prefetches, so no DB access here.
export function proxy(request: NextRequest) {
  // Read at request time; unset secret fails closed (nothing verifies).
  const secret = process.env.SESSION_SECRET;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!secret || !verifySessionToken(secret, token)) {
    return NextResponse.redirect(new URL("/login", request.nextUrl));
  }
  return NextResponse.next();
}

export const config = {
  // /login must stay excluded (redirect loop + it receives the login server
  // action's POST). /api/sync must stay excluded: Vercel cron does not follow
  // redirects, and the route has its own CRON_SECRET gate.
  matcher: ["/((?!login|api/sync|_next/static|_next/image|favicon.ico).*)"],
};
