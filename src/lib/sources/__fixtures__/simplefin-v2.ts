// Static SimpleFIN v2 fixtures modeled on a live probe of the public demo
// bridge. The live demo regenerates txn ids per request, so tests must use
// these frozen payloads, never the network.

export const simplefinV2Fixture = {
  errlist: [],
  connections: [
    {
      conn_id: "CON-SIMPLEFIN-DEMO",
      name: "SimpleFIN Demo",
      org_id: "simplefin.demoorg",
      org_name: "SimpleFIN Bridge",
      org_url: "https://beta-bridge.simplefin.org",
      sfin_url: "https://beta-bridge.simplefin.org/simplefin",
    },
  ],
  accounts: [
    {
      id: "Demo Checking",
      name: "SimpleFIN Checking",
      currency: "USD",
      balance: "1204.36",
      "available-balance": "1204.36",
      "balance-date": 1788307200,
      conn_id: "CON-SIMPLEFIN-DEMO",
      holdings: [],
      transactions: [
        {
          id: "TXN-001",
          posted: 1785758924,
          amount: "-15.50",
          description: "Fishing bait",
          payee: "John's Fishin Shack",
          memo: "JOHNS FISHIN SHACK BAIT",
          transacted_at: 1785758924,
          mcc: "5812",
        },
        {
          id: "TXN-002",
          posted: 1786781324,
          amount: "1960.00",
          description: "Pay day!",
          payee: "You",
          memo: "PAY DAY - FROM YER JOB",
          transacted_at: 1786781324,
          mcc: null,
        },
      ],
    },
    {
      id: "Demo Savings",
      name: "SimpleFIN Savings",
      currency: "USD",
      balance: "115385.51",
      "available-balance": "115385.51",
      "balance-date": 1788307200,
      conn_id: "CON-SIMPLEFIN-DEMO",
      holdings: [
        {
          id: "25bc4910-4cb4-437b-9924-ee98003651c5",
          created: 345427200,
          cost_basis: "55.00",
          currency: "USD",
          description: "Shares of Apple",
          market_value: "105884.8",
          purchase_price: "0.10",
          shares: "550.0",
          symbol: "AAPL",
        },
      ],
      transactions: [
        // Same txn id as checking's TXN-001, different amount — the dedup key
        // (account_id, simplefin_txn_id) must treat these as distinct rows.
        // Also exercises: missing payee/memo/mcc/transacted_at, unknown key.
        {
          id: "TXN-001",
          posted: 1785758924,
          amount: "-19.96",
          description: "Fishing bait",
          some_future_field: "tolerate me",
        },
      ],
    },
    {
      id: "Demo Empty Account",
      name: "SimpleFIN Empty",
      currency: "USD",
      balance: "0.00",
      "available-balance": "0.00",
      "balance-date": 1788307200,
      conn_id: "CON-SIMPLEFIN-DEMO",
      holdings: [],
      transactions: [],
    },
  ],
  some_future_top_level_key: { ignored: true },
};

// Variant with the 90-day-cap warning the bridge returns as HTTP 200 + errlist.
export const simplefinV2ErrlistFixture = {
  errlist: [
    {
      code: "gen.api",
      msg: "Requested date range exceeds limit of 90 days and was capped.",
    },
    {
      code: "conn.auth",
      msg: "Institution login needs attention.",
      conn_id: "CON-SIMPLEFIN-DEMO",
    },
  ],
  connections: [
    {
      conn_id: "CON-SIMPLEFIN-DEMO",
      name: "SimpleFIN Demo",
      org_id: "simplefin.demoorg",
      org_name: "SimpleFIN Bridge",
      org_url: "https://beta-bridge.simplefin.org",
      sfin_url: "https://beta-bridge.simplefin.org/simplefin",
    },
  ],
  accounts: [],
};
