// Normalized, provider-agnostic shapes. Everything downstream of a
// TransactionSource sees integer cents and Date objects only.

export interface SourceTransaction {
  simplefinTxnId: string;
  postedAt: Date;
  transactedAt: Date | null;
  /** Signed; positive = money into the account. */
  amountCents: number;
  description: string;
  payee: string | null;
  memo: string | null;
  mcc: string | null;
}

export interface SourceAccount {
  simplefinAccountId: string;
  simplefinConnId: string;
  name: string;
  currency: string;
  balanceCents: number;
  balanceDate: Date;
  transactions: SourceTransaction[];
}

export interface SourceConnection {
  simplefinConnId: string;
  name: string;
}

export interface SourceError {
  code: string;
  message: string;
  connId?: string;
  accountId?: string;
}

export interface FetchResult {
  connections: SourceConnection[];
  accounts: SourceAccount[];
  /** Provider-reported errors (errlist). Returned as data, never thrown. */
  errors: SourceError[];
}

export interface TransactionSource {
  fetchAccounts(opts: { startDate: Date }): Promise<FetchResult>;
}
