import {
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const accountType = pgEnum("account_type", ["checking", "credit"]);

export const connections = pgTable("connections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  simplefinConnId: text("simplefin_conn_id").notNull().unique(),
  name: text("name").notNull(),
  status: text("status", { enum: ["ok", "error"] }).notNull().default("ok"),
  lastError: text("last_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});

export const accounts = pgTable(
  "accounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id),
    simplefinAccountId: text("simplefin_account_id").notNull(),
    name: text("name").notNull(),
    // SimpleFIN does not report an account type; set manually per account.
    type: accountType("type"),
    currency: text("currency").notNull(),
  },
  (t) => [
    uniqueIndex("accounts_connection_sfid_uq").on(
      t.connectionId,
      t.simplefinAccountId,
    ),
  ],
);

export const balanceSnapshots = pgTable(
  "balance_snapshots",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    // UTC date of the SimpleFIN balance-date timestamp.
    date: date("date").notNull(),
    balanceCents: integer("balance_cents").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.date] })],
);

export const categories = pgTable("categories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull().unique(),
  isSpend: boolean("is_spend").notNull().default(true),
});

export const transactions = pgTable(
  "transactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    simplefinTxnId: text("simplefin_txn_id").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    transactedAt: timestamp("transacted_at", { withTimezone: true }),
    // Signed; positive = money into this account.
    amountCents: integer("amount_cents").notNull(),
    description: text("description").notNull(),
    payee: text("payee"),
    memo: text("memo"),
    mcc: text("mcc"),
    normalizedMerchant: text("normalized_merchant"),
    categoryId: integer("category_id").references(() => categories.id),
    isTransfer: boolean("is_transfer").notNull().default(false),
    transferPairId: integer("transfer_pair_id").references(
      (): AnyPgColumn => transactions.id,
    ),
    categorizedBy: text("categorized_by", {
      enum: ["rule", "memory", "llm", "manual"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Dedup key: SimpleFIN txn ids repeat across accounts.
    uniqueIndex("transactions_account_sfid_uq").on(
      t.accountId,
      t.simplefinTxnId,
    ),
  ],
);

export const rules = pgTable("rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  pattern: text("pattern").notNull(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id),
  priority: integer("priority").notNull().default(100),
});

export const merchantMemory = pgTable("merchant_memory", {
  normalizedMerchant: text("normalized_merchant").primaryKey(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id),
});
