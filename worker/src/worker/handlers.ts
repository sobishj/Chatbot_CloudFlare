/** Job handlers. Each runs one step per call and returns {done: false} until it has a result. */

import { getEmbedder } from "../embeddings/embedder";
import { newIndexCursor, type IndexCursor } from "../indexer/indexer";
import { crawlStep, reindexPageStep } from "../crawler/service";
import { syncDocumentsStep } from "../documents/service";
import { getById } from "../services/clients";
import { JobCancelled } from "../services/jobs";
import { getSetting } from "../services/settings";
import { first } from "../util/db";
import { handler, type StepContext } from "./runner";

/** The text shown when a feature needs the self-hosted version. */
export const SELF_HOSTED_JOBS: Record<string, string> = {
  download_embedding:
    "Local embedding models need the self-hosted version of Website Assistant (github.com/sobishj/Chatbot); this installation runs on Cloudflare.",
  scan_folder: "Watched folders need the self-hosted version of Website Assistant (github.com/sobishj/Chatbot); this installation runs on Cloudflare.",
};

async function clientOf(ctx: StepContext) {
  const client = ctx.job.client_id ? await getById(ctx.env.DB, ctx.job.client_id) : null;
  if (!client) throw new Error("The client of this job no longer exists.");
  return client;
}

handler("download_embedding", async () => {
  throw new Error(SELF_HOSTED_JOBS.download_embedding);
});

handler("scan_folder", async () => {
  throw new Error(SELF_HOSTED_JOBS.scan_folder);
});

handler("crawl", async (ctx) => crawlStep(ctx, await clientOf(ctx)));

handler("index_docs", async (ctx) => {
  const client = await clientOf(ctx);
  const sources: string[] = ctx.payload.sources || ["upload", "folder"];
  const outcome = await syncDocumentsStep(ctx, client, { sources, force: Boolean(ctx.payload.force) }, (p, t) => ctx.progress(p, t));
  return outcome.done ? { done: true, result: outcome.stats! } : { done: false };
});

interface ReindexCursor {
  phase: "pages" | "docs";
  after_id: number; // pages are re-indexed in id order
  index: IndexCursor | null;
  web_chunks: number;
}

/** Re-chunk and re-embed all pages (from stored text) and all documents. */
handler("reindex", async (ctx) => {
  const client = await clientOf(ctx);
  const env = ctx.env;
  let cur: ReindexCursor = ctx.payload._cursor;
  if (!cur) {
    cur = { phase: "pages", after_id: 0, index: null, web_chunks: 0 };
    ctx.payload._cursor = cur;
    ctx.progress(5, "Re-indexing web pages");
  }
  if (cur.phase === "pages") {
    const embedder = await getEmbedder(env, (await getSetting(env.DB, "embedding")) || {});
    if (!cur.index) {
      const page = await first<{ id: number; url: string; title: string | null }>(
        env.DB, "SELECT id, url, title FROM pages WHERE client_id = ? AND id > ? ORDER BY id LIMIT 1", client.id, cur.after_id,
      );
      if (!page) {
        ctx.log(`Re-indexed web pages: ${cur.web_chunks} chunks`);
        if (ctx.cancelRequested) throw new JobCancelled();
        ctx.progress(50, "Re-indexing documents");
        cur.phase = "docs";
        ctx.payload._docs = undefined;
        return { done: false };
      }
      cur.after_id = page.id;
      cur.index = newIndexCursor({ client_id: client.id, source_type: "web", source: page.url, title: page.title || "", page_id: page.id, document_id: null });
    }
    const chunks = await reindexPageStep(env, embedder, cur.index);
    if (chunks !== null) {
      cur.web_chunks += chunks;
      cur.index = null;
    }
    return { done: false };
  }
  const outcome = await syncDocumentsStep(ctx, client, { sources: ["upload", "folder"], force: true, cursorKey: "_docs" }, (p, t) => ctx.progress(50 + p / 2, t));
  return outcome.done ? { done: true, result: { web_chunks: cur.web_chunks, documents: outcome.stats } } : { done: false };
});
