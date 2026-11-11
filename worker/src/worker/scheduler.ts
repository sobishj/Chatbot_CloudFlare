/**
 * The per-minute Cron Trigger. Each tick reads the current settings, so changes made in the admin
 * UI apply at once:
 *
 * * heartbeats (shown as "Worker" and "Scheduler" on the System page)
 * * automatic re-crawl + document re-index of all active clients (daily/weekly/off)
 * * daily data retention cleanup and rate-limit counter cleanup
 * * recovery of interrupted jobs, then job steps within this invocation's budget
 *
 * Watched-folder scans need the self-hosted version and are skipped.
 */

import type { Env } from "../env";
import { applyRetention } from "../analytics/retention";
import * as jobService from "../services/jobs";
import * as rateLimit from "../services/rate_limit";
import { getSettingsMap, setSetting } from "../services/settings";
import { all } from "../util/db";
import { zonedIso, zonedNow, type ZonedTime } from "../util/time";
import { runJobs } from "./runner";
import "./handlers";

/** Job steps per tick: each step stays well inside the CPU and subrequest limits of one invocation. */
const STEPS_PER_TICK = 3;

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallMs(w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

function wallFromMs(ms: number): Wall {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

/** The UTC instant of a wall-clock time in ``tz`` (like an aware datetime with that ZoneInfo). */
function wallToUtc(w: Wall, tz: string): number {
  let guess = wallMs(w);
  for (let i = 0; i < 3; i++) {
    const z = zonedNow(tz, new Date(guess));
    const diff = wallMs(w) - wallMs({ y: z.year, mo: z.month, d: z.day, h: z.hour, mi: z.minute, s: z.second });
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** True when the configured daily/weekly time has passed and we haven't run for that slot yet. */
export function crawlDue(schedule: Record<string, any>, nowLocal: ZonedTime, tz: string, lastRun: string | null): boolean {
  const frequency = schedule.frequency ?? "daily";
  if (frequency === "off") return false;
  const [hour, minute] = String(schedule.time ?? "03:00").split(":").map(Number);
  const now: Wall = { y: nowLocal.year, mo: nowLocal.month, d: nowLocal.day, h: nowLocal.hour, mi: nowLocal.minute, s: nowLocal.second };
  let slot = wallMs({ ...now, h: hour, mi: minute, s: 0 });
  const DAY = 86400_000;
  if (frequency === "weekly") slot -= (((nowLocal.weekday - Number(schedule.weekday ?? 0)) % 7) + 7) % 7 * DAY;
  // Aware datetimes in the same zone compare (and subtract) by wall-clock time.
  if (wallMs(now) < slot) slot -= (frequency === "weekly" ? 7 : 1) * DAY;
  if (lastRun === null || lastRun === undefined) {
    // First run of the scheduler: only fire if we're within an hour after the slot.
    return wallMs(now) - slot < 3600_000;
  }
  return Date.parse(lastRun) < wallToUtc(wallFromMs(slot), tz);
}

export async function tick(env: Env): Promise<void> {
  const db = env.DB;
  const nowIsoUtc = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('scheduler_heartbeat', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify({ at: nowIsoUtc }), nowIsoUtc),
    // Indexing runs in these same invocations: no GPU on Cloudflare, nothing runs on a local device.
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('worker_heartbeat', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify({ at: nowIsoUtc, gpu: null, device: "api" }), nowIsoUtc),
  ]);
  const values = await getSettingsMap(db, ["setup_completed", "crawl_schedule", "scheduler_state", "retention_days", "timezone"]);
  if (!values.setup_completed) return;
  const state: Record<string, any> = values.scheduler_state || {};
  const tz = values.timezone || "UTC";
  const nowLocal = zonedNow(tz);

  // 1. Scheduled re-crawl + document re-index.
  if (crawlDue(values.crawl_schedule || {}, nowLocal, tz, state.last_crawl_run ?? null)) {
    const clients = await all<{ id: number; website_url: string | null }>(db, "SELECT id, website_url FROM clients WHERE active = 1");
    for (const c of clients) {
      if (c.website_url) await jobService.enqueue(db, "crawl", c.id, {}, "schedule");
      await jobService.enqueue(db, "index_docs", c.id, {}, "schedule");
    }
    state.last_crawl_run = zonedIso(nowLocal, new Date().getUTCMilliseconds());
    console.log(`Scheduled re-crawl queued for ${clients.length} client(s)`);
  }

  // 2. Watched folders: need the self-hosted version (nothing to scan here).

  // 3. Daily cleanups.
  const today = nowIsoUtc.slice(0, 10);
  if (state.last_cleanup !== today) {
    const deleted = await applyRetention(db, Number(values.retention_days || 0));
    const removed = await rateLimit.cleanup(db);
    state.last_cleanup = today;
    console.log(`Retention cleanup: ${deleted} question(s) deleted, ${removed} rate-limit counters removed`);
  }
  await setSetting(db, "scheduler_state", state);
}

export async function scheduledTick(env: Env, _ctx: ExecutionContext): Promise<void> {
  try {
    await tick(env);
  } catch (exc) {
    console.error("Scheduler tick failed", exc); // never let the scheduler die
  }
  try {
    const recovered = await jobService.recoverStaleJobs(env.DB);
    if (recovered) console.warn(`Recovered ${recovered} interrupted job(s) (re-queued or failed)`);
    await runJobs(env, STEPS_PER_TICK);
  } catch (exc) {
    console.error("Job steps failed", exc);
  }
}
