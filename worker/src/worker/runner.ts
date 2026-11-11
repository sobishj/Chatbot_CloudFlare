/**
 * Job runner: invocations claim queued or resumable jobs and run ONE small step of each.
 *
 * Cloudflare's free plan gives an invocation ~10 ms of CPU and 50 subrequests, so a crawl or a large
 * document is processed a few pages or chunk batches at a time. Each step saves its cursor, progress
 * text and log lines in the job row; the next step continues from there. Steps run:
 *
 * * after a request that queued a job (ctx.waitUntil);
 * * while the admin UI polls a job's progress (every 1.5 s), in the background of each poll;
 * * from the per-minute Cron Trigger (scheduler.ts), so jobs finish with no browser open.
 *
 * A step holds a short lease (jobs.lock_until), so two invocations never run the same job at once.
 */

import type { Env } from "../env";
import { toJob, type Job } from "../models";
import type { C } from "../routes/context";
import { JOB_TYPES, JobCancelled, MAX_LOG_CHARS } from "../services/jobs";
import { first, nowIso, run, toJson } from "../util/db";

export interface StepContext {
  env: Env;
  job: Job;
  /** Job payload; ``payload._cursor`` holds the handler's resume state. Saved after the step. */
  payload: Record<string, any>;
  cancelRequested: boolean;
  log(message: string): void;
  progress(percent: number, text?: string | null): void;
  /** Wait before the next step (crawl delay): the job isn't claimed again before this time. */
  notBefore(ms: number): void;
}

export type StepResult = { done: false } | { done: true; result: Record<string, any> };
export type Handler = (ctx: StepContext) => Promise<StepResult>;

export const HANDLERS: Record<string, Handler> = {};

export function handler(jobType: string, fn: Handler): void {
  HANDLERS[jobType] = fn;
}

const LEASE_MS = 3 * 60_000; // longer than any step's wall time

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Atomically take the oldest job that is queued, or running and waiting for its next step. */
export async function claimNext(db: D1Database): Promise<Job | null> {
  const now = nowIso();
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  const row = await first(
    db,
    "UPDATE jobs SET status = 'running', started_at = coalesce(started_at, ?1), heartbeat_at = ?1, lock_until = ?2 " +
      "WHERE id = (SELECT id FROM jobs WHERE (status = 'queued' OR (status = 'running' AND (lock_until IS NULL OR lock_until < ?1))) " +
      "AND (json_extract(payload, '$._not_before') IS NULL OR json_extract(payload, '$._not_before') <= ?1) " +
      "ORDER BY created_at, id LIMIT 1) RETURNING *",
    now,
    lease,
  );
  if (!row) return null;
  return toJob(row);
}

/** Run one step of an already-claimed job and save what it did. */
export async function runStep(env: Env, job: Job): Promise<string> {
  const db = env.DB;
  const lines: string[] = [];
  let progress: number | null = null;
  let progressText: string | null = null;
  const payload: Record<string, any> = { ...(job.payload || {}) };
  delete payload._not_before;
  const ctx: StepContext = {
    env,
    job,
    payload,
    cancelRequested: job.cancel_requested,
    log(message) {
      console.log(`[job ${job.id}] ${message}`);
      lines.push(`[${stamp()}] ${message}\n`);
    },
    progress(percent, text) {
      progress = Math.max(0, Math.min(100, Math.trunc(percent)));
      if (text !== undefined && text !== null) progressText = text;
    },
    notBefore(ms) {
      payload._not_before = new Date(ms).toISOString();
    },
  };
  const save = async (status: string | null, result: Record<string, any> | null = null, error: string | null = null) => {
    const finished = status !== null;
    await run(
      db,
      "UPDATE jobs SET payload = ?, log = substr(log || ?, -?), heartbeat_at = ?, lock_until = NULL, " +
        "progress = CASE WHEN ? IS NOT NULL THEN ? ELSE progress END, progress_text = coalesce(?, progress_text)" +
        (finished ? ", status = ?, result = ?, error = ?, finished_at = ?, progress = CASE WHEN ? = 'succeeded' THEN 100 ELSE progress END" : "") +
        " WHERE id = ?",
      toJson(payload),
      lines.join(""),
      MAX_LOG_CHARS,
      nowIso(),
      progress,
      progress,
      progressText,
      ...(finished ? [status, result === null ? null : toJson(result), error, nowIso(), status] : []),
      job.id,
    );
  };

  const fn = HANDLERS[job.type];
  if (!fn) {
    await save("failed", null, `No handler for job type '${job.type}'.`);
    return "failed";
  }
  if (!payload._started) {
    payload._started = true;
    ctx.log(`Started: ${JOB_TYPES[job.type] ?? job.type}`);
  }
  try {
    const outcome = await fn(ctx);
    if (!outcome.done) {
      await save(null);
      return "running";
    }
    ctx.log("Finished");
    await save("succeeded", outcome.result);
    return "succeeded";
  } catch (exc) {
    if (exc instanceof JobCancelled) {
      ctx.log("Cancelled by user");
      await save("cancelled");
      return "cancelled";
    }
    const err = exc as Error;
    console.error(`Job ${job.id} failed`, err);
    ctx.log(`ERROR: ${err?.name || "Error"}: ${err?.message ?? String(exc)}`);
    await save("failed", null, (err?.message || err?.name || "Error").slice(0, 2000));
    return "failed";
  }
}

/** Claim and run up to ``maxSteps`` job steps (one per claim). */
export async function runJobs(env: Env, maxSteps = 1): Promise<number> {
  let steps = 0;
  while (steps < maxSteps) {
    const job = await claimNext(env.DB);
    if (!job) break;
    steps++;
    await runStep(env, job);
  }
  return steps;
}

/** Advance active jobs after this response (a request that queued a job, or a progress poll). */
export function kickJobs(c: C, maxSteps = 1): void {
  const work = runJobs(c.env, maxSteps).catch((exc) => console.error("Job step failed", exc));
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    /* no execution context (tests) */
  }
}
