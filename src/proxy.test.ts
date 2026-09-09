import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth";

// next/experimental/testing/server expects the web-runtime AsyncLocalStorage
// global; provide Node's before importing (hence the dynamic imports).
(
  globalThis as unknown as { AsyncLocalStorage?: typeof AsyncLocalStorage }
).AsyncLocalStorage ??= AsyncLocalStorage;

// next@16.3.4 ships only the middleware-named helper (its docs advertise
// unstable_doesProxyMatch, but the export doesn't exist yet).
const { unstable_doesMiddlewareMatch, getRedirectUrl } = await import(
  "next/experimental/testing/server"
);
const { NextRequest } = await import("next/server");
const { proxy, config } = await import("@/proxy");

const nextConfig = {};

function matches(url: string): boolean {
  return unstable_doesMiddlewareMatch({ config, nextConfig, url });
}

describe("proxy matcher", () => {
  it.each(["/", "/some/deep/path", "/api/other"])("gates %s", (url) => {
    expect(matches(url)).toBe(true);
  });

  it.each([
    "/login",
    "/login?error=1",
    "/login/x",
    "/api/sync",
    "/api/sync?window=60",
    "/_next/static/chunk.js",
    "/_next/image?url=x",
    "/favicon.ico",
  ])("excludes %s (cron must never see a redirect)", (url) => {
    expect(matches(url)).toBe(false);
  });
});

describe("proxy function", () => {
  const SECRET = "proxy-test-secret";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function request(cookie?: string) {
    return new NextRequest("http://localhost:3000/", {
      headers: cookie ? { cookie } : {},
    });
  }

  it("redirects to /login without a cookie", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const res = proxy(request());
    expect(getRedirectUrl(res)).toBe("http://localhost:3000/login");
  });

  it("passes through with a valid session cookie", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = createSessionToken(SECRET);
    const res = proxy(request(`session=${token}`));
    expect(getRedirectUrl(res)).toBeNull();
  });

  it("redirects on a garbage cookie", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const res = proxy(request("session=not-a-token"));
    expect(getRedirectUrl(res)).toBe("http://localhost:3000/login");
  });

  it("fails closed when SESSION_SECRET is unset, even with a valid-shaped token", () => {
    const token = createSessionToken(SECRET);
    vi.stubEnv("SESSION_SECRET", "");
    const res = proxy(request(`session=${token}`));
    expect(getRedirectUrl(res)).toBe("http://localhost:3000/login");
  });
});
