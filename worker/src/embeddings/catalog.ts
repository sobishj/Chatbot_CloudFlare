/**
 * Embedding models offered in Settings → Embeddings, with what admins need to choose between them.
 *
 * On Cloudflare the Workers AI model runs inside Cloudflare (no download, ready at once). The local
 * Hugging Face models stay listed but need the self-hosted version. Cloud models run at the provider
 * and are requested at 1024 dimensions, the size of the Vectorize index.
 * Speeds and prices are rough guides for the UI; measured speed replaces the guess after indexing.
 */

export interface EmbeddingOption {
  backend: "local" | "api"; // "local": runs here (Workers AI on Cloudflare) | "api": provider HTTP API
  provider: string; // "workers_ai" | "huggingface" | "openai" | "gemini" | "mistral"
  model: string;
  label: string;
  dim: number;
  languages: string;
  summary: string;
  cpu_chunks_per_s: number | null;
  gpu_chunks_per_s: number | null;
  api_chunks_per_s: number | null;
  usd_per_m_tokens: number | null; // list price, cloud only
  query_prefix: string;
  passage_prefix: string;
  recommended: boolean;
}

export function optionKey(backend: string, provider: string, model: string): string {
  return `${backend}:${provider}:${model}`;
}

function opt(
  backend: "local" | "api",
  provider: string,
  model: string,
  label: string,
  dim: number,
  languages: string,
  summary: string,
  extra: Partial<EmbeddingOption> = {},
): EmbeddingOption {
  return {
    backend, provider, model, label, dim, languages, summary,
    cpu_chunks_per_s: null, gpu_chunks_per_s: null, api_chunks_per_s: null, usd_per_m_tokens: null,
    query_prefix: "", passage_prefix: "", recommended: false,
    ...extra,
  };
}

export const VECTOR_DIM = 1024; // dimensions of the Vectorize index

export const OPTIONS: EmbeddingOption[] = [
  // ------------------------------------------------------------------ Cloudflare
  opt(
    "local", "workers_ai", "@cf/baai/bge-m3", "BGE-M3 (Cloudflare Workers AI)", 1024,
    "100+ languages incl. Malayalam, Hindi, Arabic",
    "The same BGE-M3 model, run by Cloudflare Workers AI: ready at once, no download. Uses the free daily Workers AI allowance.",
    { api_chunks_per_s: 20, recommended: true },
  ),
  // ------------------------------------------------------------------ local (self-hosted version only)
  opt(
    "local", "huggingface", "BAAI/bge-m3", "BGE-M3", 1024,
    "100+ languages incl. Malayalam, Hindi, Arabic",
    "Best search quality of the local models. Slow on a CPU: large documents need a GPU or a lot of patience.",
    { cpu_chunks_per_s: 0.5, gpu_chunks_per_s: 40 },
  ),
  opt(
    "local", "huggingface", "intfloat/multilingual-e5-small", "Multilingual E5 small", 384,
    "~100 languages incl. Malayalam, Hindi, Arabic",
    "About 10x faster than BGE-M3 on a CPU, with somewhat weaker search. A good local choice for large document sets.",
    { cpu_chunks_per_s: 5, gpu_chunks_per_s: 200, query_prefix: "query: ", passage_prefix: "passage: " },
  ),
  opt(
    "local", "huggingface", "BAAI/bge-small-en-v1.5", "BGE small (English)", 384,
    "English only",
    "Fast on a CPU and good for English-only content. Do not use it for other languages.",
    { cpu_chunks_per_s: 6, gpu_chunks_per_s: 250 },
  ),
  // ------------------------------------------------------------------ cloud
  opt(
    "api", "openai", "text-embedding-3-small", "OpenAI text-embedding-3-small", 1024,
    "Multilingual",
    "Very fast and very cheap: thousands of pages in a minute or two. Document text is sent to OpenAI.",
    { api_chunks_per_s: 60, usd_per_m_tokens: 0.02, recommended: true },
  ),
  opt(
    "api", "openai", "text-embedding-3-large", "OpenAI text-embedding-3-large", 1024,
    "Multilingual",
    "OpenAI's most accurate embedding model (shortened to 1024 dimensions to fit the search index). Document text is sent to OpenAI.",
    { api_chunks_per_s: 50, usd_per_m_tokens: 0.13 },
  ),
  opt(
    "api", "gemini", "gemini-embedding-001", "Google gemini-embedding-001", 1024,
    "100+ languages incl. Malayalam, Hindi, Arabic",
    "Strong multilingual quality; has a free tier with rate limits. Document text is sent to Google.",
    { api_chunks_per_s: 30, usd_per_m_tokens: 0.15 },
  ),
  opt(
    "api", "mistral", "mistral-embed", "Mistral mistral-embed", 1024,
    "Mainly European languages",
    "Fast and inexpensive, best for English and European languages. Document text is sent to Mistral.",
    { api_chunks_per_s: 30, usd_per_m_tokens: 0.1 },
  ),
];

export const API_PROVIDERS: Record<string, string> = { openai: "OpenAI", gemini: "Google Gemini", mistral: "Mistral" };

export function findOption(backend: string, provider: string, model: string): EmbeddingOption | null {
  const key = optionKey(backend, provider, model);
  return OPTIONS.find((o) => optionKey(o.backend, o.provider, o.model) === key) ?? null;
}

export function optionAsDict(o: EmbeddingOption): Record<string, any> {
  return { ...o, key: optionKey(o.backend, o.provider, o.model) };
}

export const LOCAL_EMBEDDINGS_MESSAGE =
  "Local embedding models need the self-hosted version of Website Assistant (github.com/sobishj/Chatbot); " +
  "this installation runs on Cloudflare. Choose BGE-M3 (Cloudflare Workers AI) or a cloud model instead.";
