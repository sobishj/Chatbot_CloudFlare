/** Heartbeats and the compact health summary used by the dashboard, Settings and the System page. */

import { checkDatabase } from "../routes/health";
import { all } from "../util/db";
import { getSettingsMap } from "./settings";

export const HEARTBEAT_STALE_SECONDS = 90;

export function ageSeconds(value: Record<string, any> | null | undefined): number | null {
  if (!value || !value.at) return null;
  const at = Date.parse(value.at);
  return Number.isNaN(at) ? null : (Date.now() - at) / 1000;
}

/** Compact status used by the dashboard and the System page. */
export async function healthSummary(env: { DB: D1Database; VECTORIZE?: VectorizeIndex }): Promise<Record<string, any>> {
  const db = env.DB;
  const values = await getSettingsMap(db, ["worker_heartbeat", "scheduler_heartbeat", "embedding", "default_model_id"]);
  const workerAge = ageSeconds(values.worker_heartbeat);
  const schedulerAge = ageSeconds(values.scheduler_heartbeat);
  const embedding = values.embedding || {};
  const models = await all<{ last_test_ok: number | null }>(db, "SELECT last_test_ok FROM ai_models");
  return {
    database: (await checkDatabase(env)).ok,
    worker: workerAge !== null && workerAge < HEARTBEAT_STALE_SECONDS,
    worker_age_seconds: workerAge,
    scheduler: schedulerAge !== null && schedulerAge < HEARTBEAT_STALE_SECONDS,
    scheduler_age_seconds: schedulerAge,
    embedding: embedding.status ?? null,
    embedding_model: embedding.model ?? null,
    models_total: models.length,
    models_failing: models.filter((m) => m.last_test_ok === 0).length,
    default_model_set: Boolean(values.default_model_id),
  };
}
