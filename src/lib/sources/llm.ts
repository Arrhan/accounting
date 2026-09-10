import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { MerchantCategorizer } from "./types";

// Structured-output schemas require an object root.
const ResponseSchema = z.object({
  results: z.array(
    z.object({
      merchant: z.string(),
      category: z.string(),
      confident: z.boolean(),
    }),
  ),
});

export function buildSystemPrompt(categoryNames: string[]): string {
  return [
    "You categorize merchants for a personal spending tracker.",
    `For each merchant, pick exactly one category from this list: ${categoryNames.join(" · ")}.`,
    "Each merchant includes up to 3 raw bank-statement descriptions for context.",
    'Guidance: "Transfers" is for inter-account moves and credit-card payments;',
    '"Income" is for payroll and deposits; "Going Out" (if listed) is for bars,',
    'clubs, concerts, and events, while restaurants stay "Dining";',
    '"Cash & ATM" (if listed) is for ATM withdrawals and cash;',
    '"Savings & Investments" (if listed) is for brokerage transfers and investment contributions;',
    'use "Uncategorized" only when nothing fits.',
    'Set "confident": false whenever you are unsure — unsure answers go to a human',
    "review queue, so a wrong guess is worse than an unsure one.",
    "Return every merchant exactly once, echoing the merchant string unchanged.",
  ].join(" ");
}

export function buildUserPrompt(
  merchants: { merchant: string; examples: string[] }[],
): string {
  return JSON.stringify({ merchants }, null, 2);
}

/** Keep only answers for merchants we actually asked about; last answer wins. */
export function mapResponse(
  requested: { merchant: string }[],
  results: { merchant: string; category: string; confident: boolean }[],
): Map<string, { category: string; confident: boolean }> {
  const wanted = new Set(requested.map((m) => m.merchant));
  const out = new Map<string, { category: string; confident: boolean }>();
  for (const r of results) {
    if (wanted.has(r.merchant)) {
      out.set(r.merchant, { category: r.category, confident: r.confident });
    }
  }
  return out;
}

/**
 * Claude-backed merchant categorizer. The API key is injected explicitly and
 * never logged; callers treat thrown errors as "batch unresolved".
 * Model: claude-haiku-4-5 — ARCHITECTURE's documented "small model" choice.
 */
export function createClaudeCategorizer(apiKey: string): MerchantCategorizer {
  const client = new Anthropic({ apiKey });
  return {
    async categorize(merchants, categoryNames) {
      const response = await client.messages.parse({
        model: "claude-haiku-4-5",
        max_tokens: 4096,
        system: buildSystemPrompt(categoryNames),
        messages: [{ role: "user", content: buildUserPrompt(merchants) }],
        output_config: { format: zodOutputFormat(ResponseSchema) },
      });
      // Parse failure → empty map → caller leaves rows NULL to retry next run.
      if (!response.parsed_output) return new Map();
      return mapResponse(merchants, response.parsed_output.results);
    },
  };
}
