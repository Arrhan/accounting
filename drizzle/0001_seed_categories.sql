-- Seed the v1 category taxonomy (PRD). is_spend = false only for Income and
-- Transfers; Uncategorized outflows still count as spend.
INSERT INTO "categories" ("name", "is_spend") VALUES
  ('Rent & Utilities', true),
  ('Groceries', true),
  ('Dining', true),
  ('Transport', true),
  ('Travel', true),
  ('Subscriptions', true),
  ('Shopping', true),
  ('Fitness & Health', true),
  ('Entertainment', true),
  ('Fees & Interest', true),
  ('Income', false),
  ('Transfers', false),
  ('Uncategorized', true)
ON CONFLICT ("name") DO NOTHING;
