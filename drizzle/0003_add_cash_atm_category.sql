-- User taxonomy edit: "Cash & ATM" for cash withdrawals, which leave the
-- tracked accounts as physical cash (counts as spend; not a transfer).
INSERT INTO "categories" ("name", "is_spend") VALUES ('Cash & ATM', true)
ON CONFLICT ("name") DO NOTHING;
