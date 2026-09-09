import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in — skip the form.
  const secret = process.env.SESSION_SECRET;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (secret && verifySessionToken(secret, token)) redirect("/");

  const { error } = await searchParams;
  const configured = Boolean(secret && process.env.APP_PASSWORD);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xs flex-col justify-center gap-6 p-8">
      <h1 className="text-xl font-semibold">Spending Tracker</h1>
      {configured ? (
        <form action={login} className="flex flex-col gap-3">
          <input
            name="password"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            aria-label="Password"
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3"
          />
          {error && <p className="text-destructive text-sm">Wrong password.</p>}
          <Button type="submit">Sign in</Button>
        </form>
      ) : (
        <p className="text-destructive text-sm">
          Server is missing APP_PASSWORD or SESSION_SECRET.
        </p>
      )}
    </main>
  );
}
