/**
 * Embedders: Workers AI (@cf/baai/bge-m3) and the cloud HTTP APIs (OpenAI, Google Gemini, Mistral).
 *
 * Cloud models are requested at 1024 dimensions to fit the Vectorize index (OpenAI ``dimensions``,
 * Gemini ``outputDimensionality``; Mistral is 1024 already). Rate limits (HTTP 429) and server
 * errors are retried with backoff.
 */

import type { Env } from "../env";
import { decryptSecret } from "../security/crypto";
import { getProvider } from "../llm/providers";
import { LOCAL_EMBEDDINGS_MESSAGE, VECTOR_DIM } from "./catalog";

export interface Embedder {
  name: string;
  dim: number;
  device: string;
  encode(texts: string[]): Promise<number[][]>;
  encodeQueries(texts: string[]): Promise<number[][]>;
  countTokens(text: string): number;
}

/** The embedding model is not usable yet (see Settings → Embeddings). */
export class EmbeddingNotReady extends Error {}

/** A provider call failed; the message is safe to show in the admin UI. */
export class EmbeddingAPIError extends Error {}

/**
 * Conservative token estimate for sizing ~500-token chunks (the real tokenizers can't run here).
 * Latin words count ~1 token per 4 letters, punctuation 1 each, and every other letter or mark
 * 0.6 (Indic, Arabic and CJK scripts take far more tokens per character than English).
 */
export function countTokens(text: string): number {
  let tokens = 0;
  let word = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) {
      if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        word++;
        continue;
      }
      if (word) {
        tokens += Math.ceil(word / 4);
        word = 0;
      }
      if (code > 32) tokens += 1;
    } else {
      if (word) {
        tokens += Math.ceil(word / 4);
        word = 0;
      }
      if (!/\s/u.test(ch)) tokens += 0.6;
    }
  }
  if (word) tokens += Math.ceil(word / 4);
  return Math.ceil(tokens);
}

function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((x) => x / norm);
}

export const WORKERS_AI_BATCH = 50;

class WorkersAIEmbedder implements Embedder {
  device = "api";
  dim = VECTOR_DIM;
  constructor(private ai: Ai, public name: string) {}

  async encode(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += WORKERS_AI_BATCH) {
      const batch = texts.slice(i, i + WORKERS_AI_BATCH);
      let res: any;
      try {
        res = await this.ai.run(this.name as any, { text: batch } as any);
      } catch (exc) {
        throw new EmbeddingAPIError(`Workers AI embedding failed: ${String((exc as Error)?.message ?? exc).slice(0, 300)}`);
      }
      const data: number[][] | undefined = res?.data;
      if (!Array.isArray(data) || data.length !== batch.length) throw new EmbeddingAPIError("The provider returned the wrong number of embeddings.");
      for (const v of data) out.push(normalize(v));
    }
    return out;
  }

  encodeQueries(texts: string[]): Promise<number[][]> {
    return this.encode(texts);
  }

  countTokens(text: string): number {
    return countTokens(text);
  }
}

const BATCH: Record<string, number> = { openai: 128, gemini: 100, mistral: 16 }; // inputs per request (provider limits)
const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 60_000;

class ApiEmbedder implements Embedder {
  device = "api";
  name: string;
  private base: string;
  constructor(public provider: string, public model: string, public apiKey: string, public dim: number) {
    if (!(provider in BATCH)) throw new EmbeddingAPIError(`Unsupported embedding provider: ${provider}`);
    this.name = `${provider}/${model}`;
    this.base = getProvider(provider).default_base_url.replace(/\/+$/, "");
  }

  encode(texts: string[]): Promise<number[][]> {
    return this.encodeAll(texts, false);
  }

  encodeQueries(texts: string[]): Promise<number[][]> {
    return this.encodeAll(texts, true);
  }

  countTokens(text: string): number {
    return countTokens(text);
  }

  private async encodeAll(texts: string[], query: boolean): Promise<number[][]> {
    if (!texts.length) return [];
    const size = BATCH[this.provider];
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += size) batches.push(texts.slice(i, i + size));
    const results = await Promise.all(batches.map((b) => this.request(b, query)));
    const vectors = results.flat();
    if (vectors.length !== texts.length) throw new EmbeddingAPIError("The provider returned the wrong number of embeddings.");
    return vectors.map(normalize);
  }

  private build(batch: string[], query: boolean): [string, Record<string, string>, Record<string, any>] {
    if (this.provider === "gemini") {
      const task = query ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
      const requests = batch.map((t) => ({ model: `models/${this.model}`, content: { parts: [{ text: t }] }, taskType: task, outputDimensionality: this.dim }));
      const base = this.base.endsWith("/v1") || this.base.endsWith("/v1beta") ? this.base : `${this.base}/v1beta`;
      return [`${base}/models/${this.model}:batchEmbedContents`, { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" }, { requests }];
    }
    const body: Record<string, any> = { model: this.model, input: batch };
    if (this.provider === "openai") {
      // base64 is the same vectors as float JSON, but far cheaper to parse inside the CPU limit.
      body.encoding_format = "base64";
      if (this.model.startsWith("text-embedding-3")) body.dimensions = this.dim;
    }
    return [`${this.base}/embeddings`, { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body];
  }

  private parse(data: any): number[][] {
    try {
      if (this.provider === "gemini") return data.embeddings.map((e: any) => e.values);
      const items = [...data.data].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
      return items.map((d: any) => (typeof d.embedding === "string" ? decodeBase64Floats(d.embedding) : d.embedding));
    } catch {
      throw new EmbeddingAPIError("The provider returned an unexpected embedding response.");
    }
  }

  private async request(batch: string[], query: boolean): Promise<number[][]> {
    const [url, headers, body] = this.build(batch, query);
    let delay = 1000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let resp: Response | null = null;
      try {
        resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (exc) {
        if (attempt === MAX_ATTEMPTS) throw new EmbeddingAPIError(`Could not reach the ${this.provider} embedding API (${(exc as Error)?.name || "Error"}).`);
      }
      if (resp) {
        if (resp.status === 200) return this.parse(await resp.json());
        if (resp.status === 401 || resp.status === 403) throw new EmbeddingAPIError(`The ${this.provider} API rejected the API key (HTTP ${resp.status}).`);
        if (![408, 429].includes(resp.status) && resp.status < 500) {
          throw new EmbeddingAPIError(`The ${this.provider} embedding API returned HTTP ${resp.status}: ${await errorText(resp)}`);
        }
        if (attempt === MAX_ATTEMPTS) throw new EmbeddingAPIError(`The ${this.provider} embedding API kept failing (HTTP ${resp.status}): ${await errorText(resp)}`);
        const retryAfter = resp.headers.get("retry-after");
        if (retryAfter && /^\d+(\.\d+)?$/.test(retryAfter)) delay = Math.max(delay, Math.min(Number(retryAfter) * 1000, 60_000));
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
    throw new EmbeddingAPIError("Embedding failed.");
  }
}

function decodeBase64Floats(b64: string): number[] {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Array.from(new Float32Array(bytes.buffer));
}

async function errorText(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  try {
    const data = JSON.parse(text);
    const err = data.error ?? data;
    return String(typeof err === "object" && err !== null ? err.message ?? JSON.stringify(err) : err).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Name of the embedder for ``config`` (cloud models are prefixed with their provider). */
export function embedderName(config: Record<string, any>): string | null {
  if (config.backend === "api") return `${config.provider}/${config.model}`;
  return config.model ?? null;
}

export function isWorkersAI(config: Record<string, any>): boolean {
  return config.provider === "workers_ai";
}

/** The embedder for the ``embedding`` setting. */
export async function getEmbedder(env: Env, config: Record<string, any>): Promise<Embedder> {
  if (isWorkersAI(config)) {
    if (config.status !== "ready") throw new EmbeddingNotReady("The embedding model is not set up yet.");
    return new WorkersAIEmbedder(env.AI, String(config.model));
  }
  if (config.backend === "api") return apiEmbedder(env.SECRET_KEY, config);
  throw new EmbeddingNotReady(LOCAL_EMBEDDINGS_MESSAGE);
}

export async function apiEmbedder(secret: string, config: Record<string, any>): Promise<Embedder> {
  if (!["ready", "downloading"].includes(config.status)) throw new EmbeddingNotReady("The embedding model is not set up yet.");
  const apiKey = config.api_key_encrypted ? await decryptSecret(secret, config.api_key_encrypted) : null;
  if (!apiKey) throw new EmbeddingNotReady("The API key of the cloud embedding model is missing or unreadable: enter it again in Settings → Embeddings.");
  return new ApiEmbedder(config.provider, config.model, apiKey, Number(config.dim));
}

export function newApiEmbedder(provider: string, model: string, apiKey: string, dim: number): Embedder {
  return new ApiEmbedder(provider, model, apiKey, dim);
}

export function newWorkersAIEmbedder(ai: Ai, model: string): Embedder {
  return new WorkersAIEmbedder(ai, model);
}
