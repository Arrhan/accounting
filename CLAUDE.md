# CLAUDE.md — Spending Tracker

Personal single-user spending tracker. Read `docs/PRD.md` (what/why) and `docs/ARCHITECTURE.md` (how) before proposing changes. Those docs are authoritative; if a task conflicts with them, stop and ask.

## Commands

- `npm run dev` — local dev server
- `npm run typecheck` — tsc, must pass before any task is "done"
- `npm run lint` — eslint, must pass
- `npm run test` — vitest, must pass
- `npm run db:generate` / `npm run db:migrate` — Drizzle migrations

Run typecheck + lint + test before declaring any task complete.

## Conventions

- TypeScript strict. Server components by default; client components only where interactivity requires.
- Drizzle for all DB access — no raw SQL strings in app code (SQL in migrations is fine).
- Money is integer cents everywhere in code and DB. Parse SimpleFIN's string amounts with a decimal parser. Never use floating point for money.
- All external I/O (SimpleFIN, Anthropic API) goes through `src/lib/sources/` behind interfaces; app code never calls fetch directly to third parties.
- Small, focused commits; one vertical slice per branch.

## Gotchas (violating these corrupts financial data)

- Transaction dedup key is `(account_id, simplefin_txn_id)` — txn IDs repeat across accounts.
- SimpleFIN: pin `version=2`; do NOT pass `pending=1` — this app is posted-only by design (see ARCHITECTURE.md decision log). Never add pending handling "to be safe."
- Amount sign is per-account: positive = money into that account. A card payment is negative in checking, positive on the card.
- Transfers and card payments must be excluded from spend/income metrics via `is_transfer`.
- Timestamps from SimpleFIN are Unix epoch seconds.

## Security — non-negotiable

- Never log, print, or echo the SimpleFIN Access URL or its Basic Auth credentials, including in error messages and tests.
- Secrets come from env vars only; never commit them; never send them to the client.
- `/api/sync` requires the `CRON_SECRET` header.

## Workflow expectations

- For any non-trivial task: propose a plan first and wait for approval before writing code.
- When a design decision is made, append it to the Decision log in `docs/ARCHITECTURE.md` with one line of reasoning.
- Prefer editing existing files over creating new ones; keep the file tree flat until growth forces structure.
- Database access via DATABASE_URL (Supabase transaction pooler, prepare: false). Never use the Supabase JS client.