import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt, mapResponse } from "./llm";

describe("buildSystemPrompt", () => {
  it("includes every category name and the unsure instruction", () => {
    const prompt = buildSystemPrompt(["Dining", "Groceries", "Uncategorized"]);
    expect(prompt).toContain("Dining · Groceries · Uncategorized");
    expect(prompt).toContain('"confident": false');
  });
});

describe("buildUserPrompt", () => {
  it("serializes merchants with examples as JSON", () => {
    const prompt = buildUserPrompt([
      { merchant: "AMAZON MKTPL", examples: ["AMAZON MKTPL*1N2G895M3"] },
    ]);
    const parsed = JSON.parse(prompt);
    expect(parsed.merchants).toHaveLength(1);
    expect(parsed.merchants[0].merchant).toBe("AMAZON MKTPL");
    expect(parsed.merchants[0].examples).toEqual(["AMAZON MKTPL*1N2G895M3"]);
  });
});

describe("mapResponse", () => {
  const requested = [{ merchant: "DOORDASH" }, { merchant: "CHIPOTLE" }];

  it("keeps only requested merchants (exact match)", () => {
    const map = mapResponse(requested, [
      { merchant: "DOORDASH", category: "Dining", confident: true },
      { merchant: "HALLUCINATED CO", category: "Dining", confident: true },
      { merchant: "doordash", category: "Dining", confident: true }, // wrong case
    ]);
    expect([...map.keys()]).toEqual(["DOORDASH"]);
  });

  it("last answer wins on duplicates", () => {
    const map = mapResponse(requested, [
      { merchant: "CHIPOTLE", category: "Groceries", confident: false },
      { merchant: "CHIPOTLE", category: "Dining", confident: true },
    ]);
    expect(map.get("CHIPOTLE")).toEqual({ category: "Dining", confident: true });
  });

  it("missing merchants are simply absent", () => {
    const map = mapResponse(requested, []);
    expect(map.size).toBe(0);
  });
});
