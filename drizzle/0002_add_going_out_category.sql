-- User taxonomy edit: "Going Out" for bars, clubs, concerts, and events
-- (previously split across Dining and Entertainment).
INSERT INTO "categories" ("name", "is_spend") VALUES ('Going Out', true)
ON CONFLICT ("name") DO NOTHING;
