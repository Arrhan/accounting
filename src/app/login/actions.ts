"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSessionToken,
  safeEqual,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "@/lib/auth";

export async function login(formData: FormData) {
  const appPassword = process.env.APP_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  const supplied = formData.get("password");

  if (
    !appPassword ||
    !secret ||
    typeof supplied !== "string" ||
    !safeEqual(supplied, appPassword)
  ) {
    // redirect() throws NEXT_REDIRECT — deliberately not wrapped in try/catch.
    redirect("/login?error=1");
  }

  (await cookies()).set(SESSION_COOKIE, createSessionToken(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  redirect("/");
}
