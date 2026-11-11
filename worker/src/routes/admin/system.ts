/**
 * System health, AI model checks and backup (super admin).
 *
 * The response keeps the fields of the self-hosted System page, filled with their Cloudflare
 * equivalents: the database is D1, the "pgvector" entry describes the Vectorize index, and the
 * disk entries show Workers KV and Vectorize use against the free plan's allowances.
 */

import type { Hono } from "hono";
import { VERSION } from "../../env";
import { getModel, listModels, modelToDict, recordTest, rowConfig, runTest } from "../../services/ai_models";
import { healthSummary } from "../../services/health";
import { getSettingsMap } from "../../services/settings";
import { storedBytes } from "../../storage/files";
import { HttpError, json } from "../../util/http";
import { requireSetupCompleted, requireSuperAdmin, type AppEnv, type C } from "../context";

const KV_FREE_BYTES = 1024 ** 3; // Workers KV free plan: 1 GB stored
const VECTORIZE_FREE_DIMENSIONS = 5_000_000; // stored vector dimensions
const VECTOR_DIM = 1024;
const BACKUP_TABLES = ["settings", "users", "user_clients", "ai_models", "clients", "client_actions", "action_calls", "action_sessions", "pages", "documents", "chunks", "questions", "jobs", "crawl_frontier", "rate_limits"];

async function guard(c: C): Promise<void> {
  await requireSetupCompleted(c);
  await requireSuperAdmin(c);
}

export function registerSystem(app: Hono<AppEnv>): void {
  app.get("/api/admin/system", async (c) => {
    await guard(c);
    const env = c.env;
    const db = env.DB;
    let dbInfo: Record<string, any> = {};
    let vectors = 0;
    try {
      const probe = await db.prepare("SELECT 1").run();
      let index = "unavailable";
      try {
        const d: any = await env.VECTORIZE.describe();
        vectors = Number(d.vectorCount ?? d.vectorsCount ?? 0);
        const dims = d.dimensions ?? d.config?.dimensions ?? VECTOR_DIM;
        const metric = d.config?.metric ?? d.metric ?? "cosine";
        index = `Vectorize index "${d.name ?? "chunks"}" · ${dims} dims · ${metric} · ${vectors.toLocaleString("en-US")} vectors`;
      } catch (exc) {
        console.warn("Vectorize describe failed", exc);
      }
      dbInfo = { version: "Cloudflare D1", size_bytes: Number(probe.meta?.size_after ?? 0), pgvector: index };
    } catch {
      dbInfo = {};
    }
    const values = await getSettingsMap(db, ["default_model_id", "fallback_model_id", "embedding", "mode"]);
    const models = [];
    for (const m of await listModels(db)) models.push(await modelToDict(env.SECRET_KEY, m, values.default_model_id, values.fallback_model_id));
    let filesUsed = 0;
    try {
      filesUsed = await storedBytes(env.FILES_KV);
    } catch {
      /* listing failed: show 0 */
    }
    const vectorBytes = vectors * VECTOR_DIM * 4;
    const vectorTotal = VECTORIZE_FREE_DIMENSIONS * 4;
    const embedding = values.embedding || {};
    return json({
      version: VERSION,
      mode: values.mode,
      summary: await healthSummary(env),
      database: dbInfo,
      embedding: { model: embedding.model ?? null, dim: embedding.dim ?? null, status: embedding.status ?? null, error: embedding.error ?? null },
      models,
      disk: [
        { path: "Workers KV files (uploads, logos, document text) · free plan 1 GB", total: KV_FREE_BYTES, used: filesUsed, free: Math.max(0, KV_FREE_BYTES - filesUsed) },
        {
          path: `Vectorize vectors · free plan ${VECTORIZE_FREE_DIMENSIONS.toLocaleString("en-US")} stored dimensions ≈ ${Math.floor(VECTORIZE_FREE_DIMENSIONS / VECTOR_DIM).toLocaleString("en-US")} chunks`,
          total: vectorTotal,
          used: vectorBytes,
          free: Math.max(0, vectorTotal - vectorBytes),
        },
      ],
      time: new Date().toISOString(),
    });
  });

  app.post("/api/admin/system/models/:model_id{[0-9]+}/check", async (c) => {
    await guard(c);
    const model = await getModel(c.env.DB, Number(c.req.param("model_id")));
    if (!model) throw new HttpError(404, "Model not found.");
    const result = await runTest(await rowConfig(c.env.SECRET_KEY, model));
    await recordTest(c.env.DB, model, result.ok, result.reply || result.error || "");
    return json(result);
  });

  /**
   * A JSON export of every table (instead of a pg_dump file), streamed a page of rows at a time.
   * API keys stay encrypted: they can only be decrypted with the same SECRET_KEY.
   * Uploaded files and logos live in Workers KV and are not part of the export.
   */
  app.get("/api/admin/system/backup", async (c) => {
    await guard(c);
    const db = c.env.DB;
    const encoder = new TextEncoder();
    const tables = [...BACKUP_TABLES];
    let table = -1;
    let offset = 0;
    let wroteRow = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`{"format": "website-assistant-d1-export", "version": ${JSON.stringify(VERSION)}, "exported_at": ${JSON.stringify(new Date().toISOString())}, "tables": {`));
      },
      async pull(controller) {
        if (table === -1 || offset === -1) {
          table++;
          offset = 0;
          wroteRow = false;
          if (table >= tables.length) {
            controller.enqueue(encoder.encode("}}\n"));
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`${table ? ", " : ""}${JSON.stringify(tables[table])}: [`));
          return;
        }
        const name = tables[table];
        const order = name === "settings" ? "key" : name === "user_clients" ? "user_id, client_id" : name === "action_sessions" ? "client_id, session_id" : name === "rate_limits" ? "key, window_start" : name === "crawl_frontier" ? "job_id, seq" : "id";
        const rows = (await db.prepare(`SELECT * FROM ${name} ORDER BY ${order} LIMIT 500 OFFSET ?`).bind(offset).all()).results ?? [];
        if (rows.length) {
          controller.enqueue(encoder.encode((wroteRow ? ", " : "") + rows.map((r) => JSON.stringify(r)).join(", ")));
          wroteRow = true;
        }
        if (rows.length < 500) {
          controller.enqueue(encoder.encode("]"));
          offset = -1;
        } else {
          offset += rows.length;
        }
      },
    });
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const filename = `website-assistant-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.json`;
    return new Response(stream, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${filename}"` } });
  });
}
