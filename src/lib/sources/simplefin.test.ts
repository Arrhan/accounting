import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSimpleFinSource,
  epochToDate,
  parseAccountsResponse,
  parseAmountToCents,
} from "./simplefin";
import {
  simplefinV2ErrlistFixture,
  simplefinV2Fixture,
} from "./__fixtures__/simplefin-v2";

describe("parseAmountToCents", () => {
  it.each([
    ["-15.50", -1550],
    ["1960.00", 196000],
    ["0", 0],
    ["0.00", 0],
    ["-0.00", 0],
    ["1.5", 150],
    ["105884.8", 10588480],
    ["115385.51", 11538551],
    ["-0.01", -1],
    ["42", 4200],
  ])("parses %s to %i cents", (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it.each([
    "1.234",
    "1e5",
    "",
    " 1.00",
    "1.00 ",
    "+1.00",
    "1,000.00",
    "1.",
    ".50",
    "--1.00",
    "abc",
    "NaN",
    "Infinity",
  ])("rejects %j", (input) => {
    expect(() => parseAmountToCents(input)).toThrow(/expected decimal amount/);
  });

  it("rejects non-strings without echoing the value", () => {
    for (const bad of [15.5, null, undefined, {}, []]) {
      expect(() => parseAmountToCents(bad, "txn.amount")).toThrow(
        "txn.amount: expected decimal amount string",
      );
    }
  });
});

describe("epochToDate", () => {
  it("converts Unix epoch seconds", () => {
    expect(epochToDate(1785758924).getTime()).toBe(1785758924000);
  });

  it.each(["1785758924", 0, -1, 1.5, NaN, null, undefined])(
    "rejects %j",
    (input) => {
      expect(() => epochToDate(input)).toThrow(/expected positive integer/);
    },
  );
});

describe("parseAccountsResponse", () => {
  it("parses the v2 fixture into normalized shapes", () => {
    const result = parseAccountsResponse(simplefinV2Fixture);

    expect(result.errors).toEqual([]);
    expect(result.connections).toEqual([
      { simplefinConnId: "CON-SIMPLEFIN-DEMO", name: "SimpleFIN Demo" },
    ]);
    expect(result.accounts).toHaveLength(3);

    const [checking, savings, empty] = result.accounts;
    expect(checking.simplefinAccountId).toBe("Demo Checking");
    expect(checking.balanceCents).toBe(120436);
    expect(checking.balanceDate.getTime()).toBe(1788307200000);
    expect(checking.transactions).toHaveLength(2);

    const [bait, payday] = checking.transactions;
    expect(bait).toEqual({
      simplefinTxnId: "TXN-001",
      postedAt: new Date(1785758924000),
      transactedAt: new Date(1785758924000),
      amountCents: -1550,
      description: "Fishing bait",
      payee: "John's Fishin Shack",
      memo: "JOHNS FISHIN SHACK BAIT",
      mcc: "5812",
    });
    expect(payday.amountCents).toBe(196000);
    expect(payday.mcc).toBeNull(); // mcc: null in payload

    // Same txn id as checking, different amount; optional fields absent.
    const [savingsBait] = savings.transactions;
    expect(savingsBait.simplefinTxnId).toBe("TXN-001");
    expect(savingsBait.amountCents).toBe(-1996);
    expect(savingsBait.payee).toBeNull();
    expect(savingsBait.memo).toBeNull();
    expect(savingsBait.mcc).toBeNull();
    expect(savingsBait.transactedAt).toBeNull();

    expect(empty.transactions).toEqual([]);
    expect(empty.balanceCents).toBe(0);
  });

  it("returns errlist entries as data instead of throwing", () => {
    const result = parseAccountsResponse(simplefinV2ErrlistFixture);
    expect(result.errors).toEqual([
      {
        code: "gen.api",
        message:
          "Requested date range exceeds limit of 90 days and was capped.",
        connId: undefined,
        accountId: undefined,
      },
      {
        code: "conn.auth",
        message: "Institution login needs attention.",
        connId: "CON-SIMPLEFIN-DEMO",
        accountId: undefined,
      },
    ]);
    expect(result.accounts).toEqual([]);
  });

  it("skips accounts whose conn_id has no matching connection", () => {
    const payload = {
      errlist: [],
      connections: simplefinV2Fixture.connections,
      accounts: [
        { ...simplefinV2Fixture.accounts[0], conn_id: "CON-UNKNOWN" },
      ],
    };
    const result = parseAccountsResponse(payload);
    expect(result.accounts).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("app.unknown_connection");
  });

  it("throws path-only errors for malformed amounts", () => {
    const payload = {
      errlist: [],
      connections: simplefinV2Fixture.connections,
      accounts: [
        {
          ...simplefinV2Fixture.accounts[2],
          transactions: [
            { id: "T", posted: 1785758924, amount: "12.345", description: "x" },
          ],
        },
      ],
    };
    expect(() => parseAccountsResponse(payload)).toThrow(
      "accounts[0].transactions[0].amount: expected decimal amount string",
    );
    // Raw values never appear in errors.
    try {
      parseAccountsResponse(payload);
    } catch (e) {
      expect((e as Error).message).not.toContain("12.345");
    }
  });
});

describe("createSimpleFinSource", () => {
  const DEMO_URL = "https://demo:demo@beta-bridge.simplefin.org/simplefin";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects access URLs without embedded credentials", () => {
    expect(() =>
      createSimpleFinSource("https://beta-bridge.simplefin.org/simplefin"),
    ).toThrow(/must embed Basic Auth/);
    expect(() => createSimpleFinSource("not a url")).toThrow(
      /not a valid URL/,
    );
  });

  it("requests v2 with start-date, credentials stripped into a Basic header", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(simplefinV2Fixture), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const source = createSimpleFinSource(DEMO_URL);
    const startDate = new Date("2026-08-01T00:00:00Z");
    const result = await source.fetchAccounts({ startDate });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe(
      "https://beta-bridge.simplefin.org/simplefin/accounts?version=2&start-date=1785542400",
    );
    expect(target).not.toContain("demo:");
    expect(target).not.toContain("pending");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from("demo:demo").toString("base64"),
    );
    expect(result.accounts).toHaveLength(3);
  });

  it("redacts credentials from HTTP error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );
    const source = createSimpleFinSource(DEMO_URL);
    const err = await source
      .fetchAccounts({ startDate: new Date() })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("SimpleFIN request failed: HTTP 403");
    expect((err as Error).message).not.toContain("demo");
    expect((err as Error).cause).toBeUndefined();
  });

  it("redacts credentials and URLs from network error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed for ${DEMO_URL}`);
      }),
    );
    const source = createSimpleFinSource(DEMO_URL);
    const err = await source
      .fetchAccounts({ startDate: new Date() })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "SimpleFIN request failed: network error",
    );
    expect((err as Error).message).not.toContain("demo");
    expect((err as Error).cause).toBeUndefined();
  });

  it("rejects non-JSON bodies with a static message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>oops</html>", { status: 200 })),
    );
    const source = createSimpleFinSource(DEMO_URL);
    await expect(
      source.fetchAccounts({ startDate: new Date() }),
    ).rejects.toThrow("SimpleFIN response was not valid JSON");
  });
});
