/**
 * Estimated API spend in USD for a single message, from token counts and model id.
 * Rates are per 1M tokens (input / output). Update when providers change pricing.
 * Model ids should match the app model picker (MainView, status menu) and chat routes.
 */

type Rates = { inputPerMillion: number; outputPerMillion: number };

/** Exact ids used in-app plus common API aliases. */
const RATES_BY_MODEL: Record<string, Rates> = {
  // Google — ai.google.dev standard tier (≤200k-token prompts for Pro tier splits)
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.5-flash-preview": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-pro-preview": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gemini-2.0-flash-001": { inputPerMillion: 0.1, outputPerMillion: 0.4 },

  // Anthropic — docs.anthropic.com standard (non-batch) list pricing
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-3-5-sonnet-20241022": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-sonnet-latest": { inputPerMillion: 3, outputPerMillion: 15 },

  // OpenAI (default: gpt-4o)
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

const DEFAULT_FALLBACK: Rates = { inputPerMillion: 2.5, outputPerMillion: 10 };

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

function ratesForModel(model: string): Rates {
  const key = normalizeModelId(model);
  if (RATES_BY_MODEL[key]) return RATES_BY_MODEL[key];

  if (key.startsWith("gemini-")) {
    if (key.includes("-pro")) {
      return RATES_BY_MODEL["gemini-2.5-pro"] ?? DEFAULT_FALLBACK;
    }
    return RATES_BY_MODEL["gemini-2.5-flash"] ?? DEFAULT_FALLBACK;
  }
  if (key.startsWith("claude-")) {
    if (key.includes("opus")) {
      return RATES_BY_MODEL["claude-opus-4-7"] ?? DEFAULT_FALLBACK;
    }
    if (key.includes("haiku")) {
      return RATES_BY_MODEL["claude-haiku-4-5-20251001"] ?? DEFAULT_FALLBACK;
    }
    return RATES_BY_MODEL["claude-sonnet-4-6"] ?? DEFAULT_FALLBACK;
  }
  if (key.startsWith("gpt-") || key.startsWith("o1") || key.startsWith("o3")) {
    return RATES_BY_MODEL["gpt-4o"] ?? DEFAULT_FALLBACK;
  }

  return DEFAULT_FALLBACK;
}

/**
 * Returns total USD (not cents). Undefined-safe callers should gate on tokens + model.
 */
export function estimateMessageCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const { inputPerMillion, outputPerMillion } = ratesForModel(model);
  const raw =
    (tokensIn / 1_000_000) * inputPerMillion +
    (tokensOut / 1_000_000) * outputPerMillion;
  return Math.round(raw * 1_000_000) / 1_000_000;
}
