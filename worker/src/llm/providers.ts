/**
 * Provider presets for the "Add model" form.
 *
 * ``litellm_prefix`` is kept for the admin UI (it was how LiteLLM routed the call). Calls now go
 * through fetch-based adapters: "anthropic" and "gemini" use their native APIs, everything else
 * the OpenAI-compatible chat completions API.
 */

import { hostnameOf, urlparse } from "../util/pyurl";

export interface Provider {
  key: string;
  label: string;
  litellm_prefix: string;
  default_base_url: string;
  cloud: boolean; // sends data outside the server (warning in on-premise mode)
  needs_api_key: boolean;
  example_model: string;
  // Native routes know their own endpoint; only a changed base URL is used.
  openai_compatible: boolean;
}

function p(key: string, label: string, prefix: string, base: string, cloud: boolean, needsKey: boolean, example: string, compatible = false): Provider {
  return { key, label, litellm_prefix: prefix, default_base_url: base, cloud, needs_api_key: needsKey, example_model: example, openai_compatible: compatible };
}

export const PROVIDERS: Record<string, Provider> = Object.fromEntries(
  [
    p("openai", "OpenAI (GPT)", "openai", "https://api.openai.com/v1", true, true, "gpt-4o-mini"),
    p("anthropic", "Anthropic (Claude)", "anthropic", "https://api.anthropic.com", true, true, "claude-haiku-5-5"),
    p("gemini", "Google (Gemini)", "gemini", "https://generativelanguage.googleapis.com", true, true, "gemini-3.5-flash"),
    p("moonshot", "Moonshot (Kimi)", "openai", "https://api.moonshot.ai/v1", true, true, "kimi-k2-0905-preview", true),
    p("deepseek", "DeepSeek", "deepseek", "https://api.deepseek.com", true, true, "deepseek-chat"),
    p("mistral", "Mistral", "mistral", "https://api.mistral.ai/v1", true, true, "mistral-small-latest"),
    p("groq", "Groq", "groq", "https://api.groq.com/openai/v1", true, true, "llama-3.3-70b-versatile"),
    p("openrouter", "OpenRouter", "openrouter", "https://openrouter.ai/api/v1", true, true, "openai/gpt-4o-mini"),
    // Hosted open models (Qwen, Llama, DeepSeek …): run Qwen without a GPU of your own.
    p("deepinfra", "DeepInfra (Qwen, Llama and other open models)", "deepinfra", "https://api.deepinfra.com/v1/openai", true, true, "Qwen/Qwen3-235B-A22B-Instruct-2507"),
    p("bionic", "Bionic (local, OpenAI-compatible)", "openai", "http://host.docker.internal:7800/v1", false, false, "qwen", true),
    p("ollama", "Ollama (local)", "openai", "http://host.docker.internal:11434/v1", false, false, "qwen2.5:7b", true),
    p("vllm", "vLLM (local)", "openai", "http://host.docker.internal:8000/v1", false, false, "Qwen/Qwen2.5-7B-Instruct", true),
    p("lmstudio", "LM Studio (local)", "openai", "http://host.docker.internal:1234/v1", false, false, "qwen2.5-7b-instruct", true),
    p("openai_compatible", "Other OpenAI-compatible server", "openai", "", false, false, "model-name", true),
  ].map((x) => [x.key, x]),
);

export function getProvider(key: string): Provider {
  const provider = PROVIDERS[key];
  if (!provider) throw new Error(`Unknown provider: ${key}`);
  return provider;
}

/** True for localhost/127.x URLs (shown as a warning on the model). */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = (hostnameOf(urlparse(url).netloc) || "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}
