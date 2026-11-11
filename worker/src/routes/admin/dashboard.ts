/** Dashboard summary (scoped to the clients the user can access). */

import type { Hono } from "hono";
import { clientsWithActivity, questionStats, questionsToday } from "../../analytics/stats";
import { healthSummary } from "../../services/health";
import * as jobService from "../../services/jobs";
import { accessibleClientIds } from "../../services/users";
import { first, inList } from "../../util/db";
import { json } from "../../util/http";
import { requireSetupCompleted, requireUser, type AppEnv } from "../context";

export function registerDashboard(app: Hono<AppEnv>): void {
  app.get("/api/admin/dashboard", async (c) => {
    await requireSetupCompleted(c);
    const user = await requireUser(c);
    const db = c.env.DB;
    const allowed = accessibleClientIds(user);
    const l = inList(allowed === null ? [] : allowed.length ? allowed : [-1]);
    const clientWhere = allowed === null ? "" : ` AND id IN ${l.sql}`;
    const jobWhere = allowed === null ? "" : `jobs.client_id IN ${l.sql}`;
    const params = allowed === null ? [] : l.params;
    const stats = await questionStats(db, allowed, 30);
    return json({
      clients: (await first<{ n: number }>(db, `SELECT count(id) AS n FROM clients WHERE 1=1${clientWhere}`, ...params))?.n ?? 0,
      active_clients: (await first<{ n: number }>(db, `SELECT count(id) AS n FROM clients WHERE active = 1${clientWhere}`, ...params))?.n ?? 0,
      questions_today: await questionsToday(db, allowed),
      questions_30d: stats.total,
      unanswered_rate_30d: stats.unanswered_rate,
      tokens_30d: stats.tokens,
      per_day: stats.per_day,
      top_clients: (await clientsWithActivity(db, allowed)).slice(0, 5),
      recent_jobs: (await jobService.listJobs(db, jobWhere, params, "jobs.id DESC", 8)).map((j) => jobService.jobToDict(j)),
      health: user.role === "super_admin" ? await healthSummary(c.env) : null,
    });
  });
}
