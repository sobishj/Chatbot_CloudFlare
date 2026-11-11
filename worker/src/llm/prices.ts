/**
 * A trimmed list-price table (USD per 1M tokens) for common models, used for cost estimates when
 * the admin has not entered prices for a model (it replaces LiteLLM's price list). Prices change:
 * enter your own in Settings → AI Models for exact figures. Unknown models cost 0 (as before).
 *
 * Entries are matched against the model name: the longest matching prefix wins, so
 * "gpt-4o-mini-2024-07-18" uses the "gpt-4o-mini" price, not "gpt-4o".
 */

type Price = [input: number, output: number];

const PRICES: Record<string, Record<string, Price>> = {
  openai: {
    "gpt-4o-mini": [0.15, 0.6],
    "gpt-4o": [2.5, 10],
    "gpt-4.1-nano": [0.1, 0.4],
    "gpt-4.1-mini": [0.4, 1.6],
    "gpt-4.1": [2, 8],
    "gpt-5-nano": [0.05, 0.4],
    "gpt-5-mini": [0.25, 2],
    "gpt-5": [1.25, 10],
    "o4-mini": [1.1, 4.4],
    "o3-mini": [1.1, 4.4],
    "o3": [2, 8],
    "gpt-3.5-turbo": [0.5, 1.5],
  },
  anthropic: {
    "claude-3-5-haiku": [0.8, 4],
    "claude-3-haiku": [0.25, 1.25],
    "claude-haiku-4-5": [1, 5],
    "claude-3-5-sonnet": [3, 15],
    "claude-3-7-sonnet": [3, 15],
    "claude-sonnet-4": [3, 15],
    "claude-opus-4-1": [15, 75],
    "claude-opus-4-5": [5, 25],
    "claude-opus-4": [15, 75],
  },
  gemini: {
    "gemini-2.0-flash-lite": [0.075, 0.3],
    "gemini-2.0-flash": [0.1, 0.4],
    "gemini-2.5-flash-lite": [0.1, 0.4],
    "gemini-2.5-flash": [0.3, 2.5],
    "gemini-2.5-pro": [1.25, 10],
    "gemini-1.5-flash": [0.075, 0.3],
    "gemini-1.5-pro": [1.25, 5],
  },
  deepseek: {
    "deepseek-chat": [0.27, 1.1],
    "deepseek-reasoner": [0.55, 2.19],
  },
  mistral: {
    "mistral-small": [0.1, 0.3],
    "mistral-medium": [0.4, 2],
    "mistral-large": [2, 6],
    "open-mistral-nemo": [0.15, 0.15],
    "ministral-8b": [0.1, 0.1],
    "ministral-3b": [0.04, 0.04],
  },
  groq: {
    "llama-3.3-70b-versatile": [0.59, 0.79],
    "llama-3.1-8b-instant": [0.05, 0.08],
    "gemma2-9b-it": [0.2, 0.2],
  },
  deepinfra: {
    "Qwen/Qwen3-235B-A22B-Instruct-2507": [0.13, 0.6],
    "Qwen/Qwen2.5-72B-Instruct": [0.23, 0.4],
    "meta-llama/Llama-3.3-70B-Instruct": [0.23, 0.4],
    "meta-llama/Meta-Llama-3.1-8B-Instruct": [0.03, 0.05],
    "deepseek-ai/DeepSeek-V3": [0.38, 0.89],
  },
  moonshot: {
    "kimi-k2": [0.6, 2.5],
    "moonshot-v1-8k": [0.2, 2],
  },
};

/** (input, output) USD per 1M tokens for a provider's model, or null when unknown. */
export function listPrice(provider: string, modelName: string): Price | null {
  let table = PRICES[provider];
  let name = modelName;
  if (provider === "openrouter") {
    // OpenRouter names are "vendor/model": look the model up in the vendor's table.
    const [vendor, ...rest] = modelName.split("/");
    const map: Record<string, string> = { openai: "openai", anthropic: "anthropic", google: "gemini", "meta-llama": "deepinfra", mistralai: "mistral", deepseek: "deepseek" };
    table = PRICES[map[vendor] ?? ""];
    name = vendor === "meta-llama" ? modelName : rest.join("/");
  }
  if (!table) return null;
  if (provider === "gemini") name = name.replace(/^models\//, "");
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (name.toLowerCase().startsWith(key.toLowerCase()) && (best === null || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}
