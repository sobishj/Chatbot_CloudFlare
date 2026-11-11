/** Choosing the embedding model (Workers AI or cloud), measured speed, and indexing-time estimates. */

import type { Env } from "../env";
import { API_PROVIDERS, findOption, LOCAL_EMBEDDINGS_MESSAGE, OPTIONS, optionAsDict, VECTOR_DIM, type EmbeddingOption } from "../embeddings/catalog";
import { EmbeddingAPIError, embedderName, isWorkersAI, newApiEmbedder, newWorkersAIEmbedder } from "../embeddings/embedder";
import { decryptSecret, encryptSecret } from "../security/crypto";
import { all } from "../util/db";
import { UserFacingError } from "../util/http";
import * as jobService from "./jobs";
import { getSetting, getSettingsMap, setSetting, updateSettingDict } from "./settings";

export const CHUNKS_PER_PAGE = 1.2; // a dense page is ~600 tokens; chunks hold ~500
export const TOKENS_PER_CHUNK = 500;
const OCR_PAGES_PER_S = 2.0;
export const LARGE_DOCUMENT_SECONDS = 10 * 60; // ask before the current model spends longer than this on one upload

/** Invalid embedding choice; the message is safe to show in the UI. */
export class EmbeddingChoiceError extends UserFacingError {}

/** Stable name of the configured model (cloud models are prefixed with their provider). */
export function modelIdentity(config: Record<string, any>): string | null {
  return embedderName(config);
}

// ----------------------------------------------------------------------------- speed
/** Remember measured embedding speed (chunks/s) per model and device; smoothed across runs. */
export async function recordRate(db: D1Database, name: string, device: string, chunks: number, seconds: number): Promise<void> {
  if (chunks < 8 || seconds <= 0) return;
  const rates = { ...((await getSetting(db, "embedding_rate")) || {}) };
  const perModel = { ...(rates[name] || {}) };
  const measured = chunks / seconds;
  const previous = perModel[device];
  perModel[device] = Math.round((previous === undefined || previous === null ? measured : 0.5 * previous + 0.5 * measured) * 1000) / 1000;
  rates[name] = perModel;
  await setSetting(db, "embedding_rate", rates);
}

/** (speed, measured?) for a model: the measured speed here, else the catalog guess. Nothing runs on a local CPU/GPU here. */
function chunksPerSecond(rates: Record<string, any>, option: EmbeddingOption | null, name: string | null): [number, boolean] {
  const measured = (rates[name || ""] || {}).api;
  if (measured) return [measured, true];
  return [(option?.api_chunks_per_s ?? null) || 20.0, false];
}

// ----------------------------------------------------------------------------- estimates
/** Rough page count from the file size (PDF pages are counted from the file when it says). */
export function estimatePages(filename: string, size: number, head?: Uint8Array): [number, boolean] {
  if (filename.toLowerCase().endsWith(".pdf") && head) {
    const text = new TextDecoder("latin1").decode(head);
    const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    const counts2 = [...text.matchAll(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1]));
    const best = Math.max(0, ...counts, ...counts2);
    if (best > 0) return [best, false];
  }
  // Office and text files: about 3 KB of text per page.
  return [Math.max(1, Math.floor(size / 3000)), false];
}

function duration(pages: number, scanned: boolean, rate: number): number {
  let seconds = (pages * CHUNKS_PER_PAGE) / rate;
  if (scanned) seconds += pages / OCR_PAGES_PER_S;
  return seconds;
}

/** Estimated time with the current model and with each cloud model, plus cloud cost. */
export async function estimateIndexing(db: D1Database, pages: number, scanned = false): Promise<Record<string, any>> {
  const values = await getSettingsMap(db, ["embedding", "embedding_rate"]);
  const config = values.embedding || {};
  const rates = values.embedding_rate || {};
  const backend = config.backend || "local";
  const name = modelIdentity(config);
  const current = findOption(backend, config.provider || "huggingface", config.model || "");
  const [rate, measured] = chunksPerSecond(rates, current, name);
  const tokens = pages * CHUNKS_PER_PAGE * TOKENS_PER_CHUNK;
  const cloud = OPTIONS.filter((o) => o.backend === "api").map((option) => {
    const [optionRate] = chunksPerSecond(rates, option, `${option.provider}/${option.model}`);
    return {
      key: optionAsDict(option).key,
      label: option.label,
      provider: option.provider,
      model: option.model,
      seconds: Math.round(duration(pages, scanned, optionRate)),
      usd: option.usd_per_m_tokens !== null ? Math.round((tokens / 1e6) * option.usd_per_m_tokens * 10000) / 10000 : null,
      recommended: option.recommended,
    };
  });
  return {
    pages,
    scanned,
    chunks: Math.round(pages * CHUNKS_PER_PAGE),
    current: { backend, label: current ? current.label : name, model: name, device: "api", seconds: Math.round(duration(pages, scanned, rate)), measured },
    cloud,
  };
}

/** An estimate to show before indexing, when the current model would take too long; else null. */
export async function largeUploadWarning(db: D1Database, files: { filename: string; size: number; head?: Uint8Array }[]): Promise<Record<string, any> | null> {
  const config = (await getSetting(db, "embedding")) || {};
  if ((config.backend || "local") === "api" || !files.length) return null;
  let pages = 0;
  let scannedPages = 0;
  const listed = files.map((f) => {
    const [n, scanned] = estimatePages(f.filename, f.size, f.head);
    pages += n;
    scannedPages += scanned ? n : 0;
    return { filename: f.filename, pages: n, scanned };
  });
  const estimate = await estimateIndexing(db, pages, scannedPages * 2 > pages);
  if (estimate.current.seconds < LARGE_DOCUMENT_SECONDS) return null;
  return { ...estimate, files: listed };
}

// ----------------------------------------------------------------------------- options for the UI
/** Every catalog model with its estimated time for 1,000 pages. */
export async function optionsView(db: D1Database): Promise<Record<string, any>[]> {
  const savedKeys = new Set((await all<{ provider: string }>(db, "SELECT provider FROM ai_models WHERE api_key_encrypted IS NOT NULL")).map((r) => r.provider));
  const rates = (await getSetting(db, "embedding_rate")) || {};
  return OPTIONS.map((option) => {
    const name = option.backend === "local" ? option.model : `${option.provider}/${option.model}`;
    const [rate, measured] = option.provider === "huggingface" ? [option.cpu_chunks_per_s || 0.5, false] : chunksPerSecond(rates, option, name);
    return {
      ...optionAsDict(option),
      provider_label: API_PROVIDERS[option.provider] ?? (option.provider === "workers_ai" ? "Cloudflare Workers AI" : "Hugging Face (local)"),
      seconds_per_1000_pages: Math.round((1000 * CHUNKS_PER_PAGE) / rate),
      measured,
      usd_per_1000_pages: option.usd_per_m_tokens !== null ? Math.round(((1000 * CHUNKS_PER_PAGE * TOKENS_PER_CHUNK) / 1e6) * option.usd_per_m_tokens * 1000) / 1000 : null,
      saved_key_available: savedKeys.has(option.provider),
    };
  });
}

// ----------------------------------------------------------------------------- switching
export async function queueReindexAll(db: D1Database): Promise<number> {
  const clients = await all<{ id: number }>(db, "SELECT id FROM clients");
  for (const c of clients) await jobService.enqueue(db, "reindex", c.id, {}, "system");
  return clients.length;
}

async function savedKey(db: D1Database, secret: string, provider: string): Promise<string | null> {
  for (const m of await all<{ api_key_encrypted: string }>(db, "SELECT api_key_encrypted FROM ai_models WHERE provider = ? AND api_key_encrypted IS NOT NULL", provider)) {
    const key = await decryptSecret(secret, m.api_key_encrypted);
    if (key) return key;
  }
  return null;
}

/** Verify a cloud embedding model with one call, make it current and re-index if it changed. */
export async function switchToApi(env: Env, provider: string, model: string, apiKey: string | null): Promise<Record<string, any>> {
  const db = env.DB;
  if (!(provider in API_PROVIDERS)) throw new EmbeddingChoiceError("Choose OpenAI, Google Gemini or Mistral for cloud embeddings.");
  model = (model || "").trim();
  if (!model) throw new EmbeddingChoiceError("Enter the embedding model name.");
  const current = (await getSetting(db, "embedding")) || {};
  let key: string | null = (apiKey || "").trim() || null;
  if (key === null && current.backend === "api" && current.provider === provider && current.api_key_encrypted) {
    key = await decryptSecret(env.SECRET_KEY, current.api_key_encrypted);
  }
  key = key || (await savedKey(db, env.SECRET_KEY, provider));
  if (!key) throw new EmbeddingChoiceError(`Enter an API key for ${API_PROVIDERS[provider]}.`);
  let vector: number[];
  try {
    vector = (await newApiEmbedder(provider, model, key, VECTOR_DIM).encode(["Connection test"]))[0];
  } catch (exc) {
    if (exc instanceof EmbeddingAPIError) throw new EmbeddingChoiceError(exc.message);
    throw exc;
  }
  if (vector.length !== VECTOR_DIM) {
    throw new EmbeddingChoiceError(`${model} returned ${vector.length}-dimensional vectors; the search index needs ${VECTOR_DIM}. Choose a model that supports ${VECTOR_DIM} dimensions.`);
  }
  const previous = current.status === "ready" ? modelIdentity(current) : null;
  await updateSettingDict(db, "embedding", {
    backend: "api", provider, model, dim: VECTOR_DIM, path: null, status: "ready",
    error: null, pending_model: null, job_id: null, api_key_encrypted: await encryptSecret(env.SECRET_KEY, key),
  });
  const queued = previous !== `${provider}/${model}` ? await queueReindexAll(db) : 0;
  return { reindex_clients: queued };
}

/** Switch to the Workers AI model (verified with one call): ready at once, re-index if it changed. */
export async function switchToWorkersAI(env: Env, model: string): Promise<Record<string, any>> {
  const db = env.DB;
  const option = findOption("local", "workers_ai", model);
  if (!option) throw new EmbeddingChoiceError(LOCAL_EMBEDDINGS_MESSAGE);
  try {
    await newWorkersAIEmbedder(env.AI, model).encode(["Connection test"]);
  } catch (exc) {
    throw new EmbeddingChoiceError((exc as Error).message);
  }
  const current = (await getSetting(db, "embedding")) || {};
  const previous = current.status === "ready" ? modelIdentity(current) : null;
  await updateSettingDict(db, "embedding", {
    backend: "local", provider: "workers_ai", model, dim: VECTOR_DIM, path: null, status: "ready",
    error: null, pending_model: null, job_id: null, api_key_encrypted: null,
  });
  const queued = previous !== model ? await queueReindexAll(db) : 0;
  return { reindex_clients: queued };
}

export async function embeddingView(db: D1Database): Promise<Record<string, any>> {
  const config = (await getSettingsMap(db, ["embedding"])).embedding || {};
  return {
    model: config.model ?? null,
    dim: config.dim ?? null,
    status: config.status ?? null,
    error: config.error ?? null,
    pending_model: config.pending_model ?? null,
    backend: config.backend || "local",
    provider: config.provider || "huggingface",
    has_api_key: Boolean(config.api_key_encrypted),
  };
}

export { isWorkersAI };
