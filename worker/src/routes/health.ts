/** ``GET /health``, on both the admin and the public side. */

import type { Hono } from "hono";
import { VERSION } from "../env";
import type { AppEnv } from "./context";
import { json } from "../util/http";

/** ``{"ok": bool, ...}`` describing database reachability and the vector index binding. Error details are logged, never returned. */
export async function checkDatabase(env: { DB: D1Database; VECTORIZE?: VectorizeIndex }): Promise<Record<string, any>> {
  try {
    await env.DB.prepare("SELECT 1").first();
    return { ok: true, pgvector_available: Boolean(env.VECTORIZE) };
  } catch (exc) {
    console.warn("Database health check failed:", exc);
    return { ok: false, error: (exc as Error)?.name || "Error" };
  }
}

export function registerHealth(app: Hono<AppEnv>): void {
  /** Report service health. Returns 503 when a required dependency is down. */
  app.get("/health", async (c) => {
    const database = await checkDatabase(c.env);
    const healthy = database.ok;
    return json({ status: healthy ? "ok" : "unavailable", version: VERSION, checks: { database } }, healthy ? 200 : 503);
  });
}
