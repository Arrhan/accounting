import type {
  FetchResult,
  SourceAccount,
  SourceConnection,
  SourceError,
  SourceTransaction,
  TransactionSource,
} from "./types";

// Validation errors carry JSON paths only, never raw values — a malformed
// response must not leak amounts or descriptions into logs.

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

/** Parse a SimpleFIN decimal amount string into integer cents. No floats. */
export function parseAmountToCents(value: unknown, path = "amount"): number {
  if (typeof value !== "string" || !AMOUNT_RE.test(value)) {
    throw new Error(`${path}: expected decimal amount string`);
  }
  const negative = value.startsWith("-");
  const [whole, frac = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${path}: amount out of safe integer range`);
  }
  return negative && cents !== 0 ? -cents : cents;
}

/** Convert SimpleFIN Unix epoch seconds to a Date. */
export function epochToDate(value: unknown, path = "epoch"): Date {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path}: expected positive integer epoch seconds`);
  }
  return new Date(value * 1000);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path}: expected string`);
  return value;
}

function optionalString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return asString(value, path);
}

function parseTransaction(value: unknown, path: string): SourceTransaction {
  const txn = asRecord(value, path);
  return {
    simplefinTxnId: asString(txn.id, `${path}.id`),
    postedAt: epochToDate(txn.posted, `${path}.posted`),
    transactedAt:
      txn.transacted_at === undefined || txn.transacted_at === null
        ? null
        : epochToDate(txn.transacted_at, `${path}.transacted_at`),
    amountCents: parseAmountToCents(txn.amount, `${path}.amount`),
    description: asString(txn.description, `${path}.description`),
    payee: optionalString(txn.payee, `${path}.payee`),
    memo: optionalString(txn.memo, `${path}.memo`),
    mcc: optionalString(txn.mcc, `${path}.mcc`),
  };
}

/** Parse and validate a SimpleFIN v2 /accounts response. Unknown keys are ignored. */
export function parseAccountsResponse(json: unknown): FetchResult {
  const root = asRecord(json, "response");

  const errors: SourceError[] = asArray(root.errlist ?? [], "errlist").map(
    (item, i) => {
      const err = asRecord(item, `errlist[${i}]`);
      return {
        code: asString(err.code, `errlist[${i}].code`),
        message: asString(err.msg, `errlist[${i}].msg`),
        connId: optionalString(err.conn_id, `errlist[${i}].conn_id`) ?? undefined,
        accountId:
          optionalString(err.account_id, `errlist[${i}].account_id`) ?? undefined,
      };
    },
  );

  const connections: SourceConnection[] = asArray(
    root.connections ?? [],
    "connections",
  ).map((item, i) => {
    const conn = asRecord(item, `connections[${i}]`);
    return {
      simplefinConnId: asString(conn.conn_id, `connections[${i}].conn_id`),
      name: asString(conn.name, `connections[${i}].name`),
    };
  });
  const knownConnIds = new Set(connections.map((c) => c.simplefinConnId));

  const accounts: SourceAccount[] = [];
  for (const [i, item] of asArray(root.accounts, "accounts").entries()) {
    const path = `accounts[${i}]`;
    const acct = asRecord(item, path);
    const connId = asString(acct.conn_id, `${path}.conn_id`);
    if (!knownConnIds.has(connId)) {
      errors.push({
        code: "app.unknown_connection",
        message: `${path}: conn_id not present in connections; account skipped`,
      });
      continue;
    }
    accounts.push({
      simplefinAccountId: asString(acct.id, `${path}.id`),
      simplefinConnId: connId,
      name: asString(acct.name, `${path}.name`),
      currency: asString(acct.currency, `${path}.currency`),
      balanceCents: parseAmountToCents(acct.balance, `${path}.balance`),
      balanceDate: epochToDate(acct["balance-date"], `${path}.balance-date`),
      transactions: asArray(acct.transactions, `${path}.transactions`).map(
        (txn, j) => parseTransaction(txn, `${path}.transactions[${j}]`),
      ),
    });
  }

  return { connections, accounts, errors };
}

/**
 * SimpleFIN Bridge client. The access URL (with embedded Basic Auth) never
 * leaves this closure; thrown errors carry at most an HTTP status.
 */
export function createSimpleFinSource(accessUrl: string): TransactionSource {
  let url: URL;
  try {
    url = new URL(accessUrl);
  } catch {
    throw new Error("SimpleFIN access URL is not a valid URL");
  }
  if (!url.username || !url.password) {
    throw new Error("SimpleFIN access URL must embed Basic Auth credentials");
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  // fetch() rejects URLs with embedded credentials, so auth goes in a header.
  const base = url.toString().replace(/\/+$/, "");
  const authHeader =
    "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  return {
    async fetchAccounts({ startDate }) {
      const epoch = Math.floor(startDate.getTime() / 1000);
      // Pinned to protocol v2; posted-only by design — never pass pending=1.
      const target = `${base}/accounts?version=2&start-date=${epoch}`;
      let res: Response;
      try {
        res = await fetch(target, { headers: { Authorization: authHeader } });
      } catch {
        // Original error deliberately dropped: undici errors can embed the URL.
        throw new Error("SimpleFIN request failed: network error");
      }
      if (!res.ok) {
        throw new Error(`SimpleFIN request failed: HTTP ${res.status}`);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new Error("SimpleFIN response was not valid JSON");
      }
      return parseAccountsResponse(json);
    },
  };
}
