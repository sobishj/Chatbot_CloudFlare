// Test doubles for the bindings that have no local simulator (Vectorize, Workers AI), and an
// outbound-fetch router (like tests/fakes.py and httpx.MockTransport in the Python tests).
import { env } from "cloudflare:test";
import type { Env } from "../src/env";

/** Bag-of-words embedding: deterministic, and texts sharing words are similar. */
export function fakeVector(text: string, dim = 1024): number[] {
  const v = new Array(dim).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
    v[Math.abs(h) % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class FakeAI {
  calls = 0;
  async run(_model: string, input: { text: string[] }): Promise<{ data: number[][]; shape: number[] }> {
    this.calls++;
    return { data: input.text.map((t) => fakeVector(t)), shape: [input.text.length, 1024] };
  }
  async toMarkdown(files: { name: string; blob: Blob } | { name: string; blob: Blob }[]): Promise<any> {
    const list = Array.isArray(files) ? files : [files];
    const out = await Promise.all(
      list.map(async (f) => {
        const text = await f.blob.text();
        if (text.startsWith("%PDF-SCANNED")) return { name: f.name, format: "markdown", mimetype: "application/pdf", tokens: 0, data: "" };
        if (text.startsWith("CORRUPT")) return { name: f.name, format: "error", mimetype: "application/pdf", error: "Could not parse the file" };
        return { name: f.name, format: "markdown", mimetype: "application/pdf", tokens: 10, data: text.replace(/^%PDF[^\n]*\n/, "") };
      }),
    );
    return Array.isArray(files) ? out : out[0];
  }
}

interface Stored {
  id: string;
  values: number[];
  namespace?: string;
}

export class FakeVectorize {
  vectors = new Map<string, Stored>();
  async upsert(vectors: Stored[]) {
    for (const v of vectors) this.vectors.set(v.id, v);
    return { ids: vectors.map((v) => v.id), count: vectors.length };
  }
  async deleteByIds(ids: string[]) {
    for (const id of ids) this.vectors.delete(id);
    return { ids, count: ids.length };
  }
  async query(vector: number[], options: { topK?: number; namespace?: string }) {
    const scored = [...this.vectors.values()]
      .filter((v) => (options.namespace ?? undefined) === v.namespace)
      .map((v) => ({ id: v.id, score: v.values.reduce((s, x, i) => s + x * vector[i], 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK ?? 5);
    return { matches: scored, count: scored.length };
  }
  async describe() {
    return { id: "fake", name: "chunks", config: { dimensions: 1024, metric: "cosine" }, vectorsCount: this.vectors.size };
  }
}

/** A test Env: real local D1 and KV, fake Vectorize and AI. */
export function testEnv(overrides: Partial<Env> = {}): Env & { AI: FakeAI; VECTORIZE: FakeVectorize } {
  return {
    DB: env.DB,
    FILES_KV: env.FILES_KV,
    SECRET_KEY: env.SECRET_KEY,
    AI: new FakeAI() as any,
    VECTORIZE: new FakeVectorize() as any,
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as any,
    ADMIN_HOSTNAME: "",
    ...overrides,
  } as any;
}

export type Route = (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>;

/** Replace global fetch with a router for the duration of a test. Returns the list of requested URLs. */
export function routeFetch(route: Route): { seen: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(url.href);
    const resp = await route(url, init);
    if (!resp) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    Object.defineProperty(resp, "url", { value: url.href });
    return resp;
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = original) };
}

/** Empty every table between tests. */
export async function resetDb(): Promise<void> {
  const tables = ["crawl_frontier", "action_calls", "action_sessions", "questions", "chunks", "pages", "documents", "client_actions", "jobs", "user_clients", "users", "clients", "ai_models", "settings", "rate_limits"];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const listing = await env.FILES_KV.list({ limit: 1000 });
  for (const k of listing.keys) await env.FILES_KV.delete(k.name);
}
