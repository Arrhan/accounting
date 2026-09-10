-- User taxonomy edit: "Savings & Investments" for brokerage transfers
-- (e.g. Interactive Brokers). Not spending and not an inter-account transfer
-- in our model — excluded from spend and from net cash flow / income.
INSERT INTO "categories" ("name", "is_spend") VALUES ('Savings & Investments', false)
ON CONFLICT ("name") DO NOTHING;
