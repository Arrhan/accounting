import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit does not load .env.local on its own.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Session pooler (:5432). The transaction pooler (:6543) breaks drizzle-kit's
  // prepared statements — never point migrations at it.
  dbCredentials: { url: process.env.DIRECT_URL! },
});
