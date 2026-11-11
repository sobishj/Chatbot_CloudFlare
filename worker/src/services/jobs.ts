/**
 * D1-backed job queue.
 *
 * The admin UI (and the scheduler) enqueue jobs; the runner (src/worker/runner.ts) claims them with
 * one atomic UPDATE ... RETURNING, so two invocations never run the same job step. Progress, logs
 * and errors are written back to the ``jobs`` row, which the UI polls for live progress.
 */

import { toJob, type Job } from "../models";
import { all, first, isoMinus, nowIso, run, toJson } from "../util/db";

export const ACTIVE_STATUSES = ["queued", "running"];
export const MAX_LOG_CHARS = 200_000;

// Human-friendly names shown in the UI.
export const JOB_TYPES: Record<string, string> = {
  crawl: "Website crawl",
  index_docs: "Index documents",
  scan_folder: "Scan watched folder",
  reindex: "Re-index everything",
  download_embedding: "Download embedding model",
};

/** Raised inside a job handler when the user cancelled the job. */
export class JobCancelled extends Error {}

const JOB_SELECT = "SELECT jobs.*, clients.client_id AS client_slug, clients.name AS client_name FROM jobs LEFT JOIN clients ON clients.id = jobs.client_id";

export async function getJob(db: D1Database, id: number): Promise<Job | null> {
  const row = await first(db, `${JOB_SELECT} WHERE jobs.id = ?`, id);
  return row ? toJob(row) : null;
}

export async function listJobs(db: D1Database, where: string, params: unknown[], order = "jobs.id DESC", limit?: number): Promise<Job[]> {
  const rows = await all(db, `${JOB_SELECT}${where ? " WHERE " + where : ""} ORDER BY ${order}${limit ? ` LIMIT ${Math.floor(limit)}` : ""}`, ...params);
  return rows.map(toJob);
}

/** Queue a job and return it. With ``dedupe``, an identical queued/running job is returned instead. */
export async function enqueue(
  db: D1Database,
  jobType: string,
  clientId: number | null = null,
  payload: Record<string, any> = {},
  triggeredBy = "user",
  createdById: number | null = null,
  dedupe = true,
): Promise<Job> {
  if (!(jobType in JOB_TYPES)) throw new Error(`Unknown job type: ${jobType}`);
  if (dedupe) {
    const existing = await first(
      db,
      `${JOB_SELECT} WHERE jobs.type = ? AND ${clientId === null ? "jobs.client_id IS NULL" : "jobs.client_id = ?"} ` +
        "AND jobs.status IN ('queued', 'running') ORDER BY jobs.id DESC LIMIT 1",
      ...(clientId === null ? [jobType] : [jobType, clientId]),
    );
    if (existing) return toJob(existing);
  }
  const row = await first<{ id: number }>(
    db,
    "INSERT INTO jobs (type, client_id, payload, status, progress, log, cancel_requested, triggered_by, created_by_id, created_at) " +
      "VALUES (?, ?, ?, 'queued', 0, '', 0, ?, ?, ?) RETURNING id",
    jobType,
    clientId,
    toJson(payload || {}),
    triggeredBy,
    createdById,
    nowIso(),
  );
  return (await getJob(db, row!.id))!;
}

/** Queue a fresh copy of a finished job (its resume cursor is not copied). */
export async function retry(db: D1Database, job: Job, userId: number | null = null): Promise<Job> {
  const { _cursor, _attempts, ...payload } = job.payload || {};
  void _cursor;
  void _attempts;
  return enqueue(db, job.type, job.client_id, payload, "user", userId);
}

/** Cancel a queued job immediately, or ask a running job to stop at its next step. */
export async function requestCancel(db: D1Database, job: Job): Promise<void> {
  if (job.status === "queued") {
    await run(db, "UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'", nowIso(), job.id);
  } else if (job.status === "running") {
    await run(db, "UPDATE jobs SET cancel_requested = 1 WHERE id = ?", job.id);
  }
}

// Safe to run again: they resume from their saved cursor, and unchanged pages/documents are skipped.
export const RESUMABLE = ["crawl", "index_docs", "scan_folder", "reindex"];
export const MAX_ATTEMPTS = 3;
/** A running job whose steps stopped sending heartbeats for this long is treated as interrupted. */
export const STALE_AFTER_MS = 5 * 60_000;

/**
 * Handle running jobs whose steps stopped (e.g. an invocation ran out of CPU time and its lease
 * expired long ago). Indexing-type jobs are queued again (up to MAX_ATTEMPTS runs); others fail.
 */
export async function recoverStaleJobs(db: D1Database, staleAfterMs = STALE_AFTER_MS): Promise<number> {
  const cutoff = isoMinus(staleAfterMs);
  const stale = (await all(db, "SELECT * FROM jobs WHERE status = 'running' AND (heartbeat_at < ? OR heartbeat_at IS NULL) AND (lock_until IS NULL OR lock_until < ?)", cutoff, nowIso())).map(toJob);
  const statements: D1PreparedStatement[] = [];
  for (const job of stale) {
    const attempts = Number(job.payload?._attempts ?? 1);
    if (RESUMABLE.includes(job.type) && attempts < MAX_ATTEMPTS) {
      statements.push(
        db
          .prepare("UPDATE jobs SET status = 'queued', payload = ?, started_at = NULL, heartbeat_at = NULL, lock_until = NULL, log = substr(log || ?, -?) WHERE id = ?")
          .bind(toJson({ ...job.payload, _attempts: attempts + 1 }), "The worker restarted during this job; running it again.\n", MAX_LOG_CHARS, job.id),
      );
    } else {
      statements.push(
        db
          .prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, lock_until = NULL WHERE id = ?")
          .bind("The worker stopped while running this job. Use Retry to run it again.", nowIso(), job.id),
      );
    }
  }
  if (statements.length) await db.batch(statements);
  return stale.length;
}

export function jobToDict(job: Job, includeLog = false): Record<string, any> {
  const data: Record<string, any> = {
    id: job.id,
    type: job.type,
    type_label: JOB_TYPES[job.type] ?? job.type,
    client_id: job.client_slug ?? null,
    client_name: job.client_name ?? null,
    status: job.status,
    progress: job.progress,
    progress_text: job.progress_text,
    result: job.result,
    error: job.error,
    cancel_requested: job.cancel_requested,
    triggered_by: job.triggered_by,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
  if (includeLog) {
    data.log = job.log;
    const { _cursor, ...payload } = job.payload || {};
    void _cursor;
    data.payload = payload;
  }
  return data;
}
