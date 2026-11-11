/** Jobs page: list, detail with logs, retry, cancel. Polling an active job also advances it by one step. */

import type { Hono } from "hono";
import type { Job, User } from "../../models";
import * as jobService from "../../services/jobs";
import { accessibleClientIds } from "../../services/users";
import { inList } from "../../util/db";
import { HttpError, json, queryInt } from "../../util/http";
import { kickJobs } from "../../worker/runner";
import { requireSetupCompleted, requireUser, type AppEnv, type C } from "../context";

function visible(user: User, job: Job): boolean {
  const allowed = accessibleClientIds(user);
  if (allowed === null) return true;
  return job.client_id !== null && allowed.includes(job.client_id);
}

async function getOr404(c: C, user: User, id: number): Promise<Job> {
  const job = await jobService.getJob(c.env.DB, id);
  if (!job || !visible(user, job)) throw new HttpError(404, "Job not found.");
  return job;
}

export function registerJobs(app: Hono<AppEnv>): void {
  app.get("/api/admin/jobs", async (c) => {
    await requireSetupCompleted(c);
    const user = await requireUser(c);
    const url = new URL(c.req.url);
    const limit = queryInt(url, "limit", 100, 1, 500);
    const where: string[] = [];
    const params: unknown[] = [];
    const allowed = accessibleClientIds(user);
    if (allowed !== null) {
      const l = inList(allowed);
      where.push(`jobs.client_id IN ${l.sql}`);
      params.push(...l.params);
    }
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const client = url.searchParams.get("client");
    if (status) where.push("jobs.status = ?"), params.push(status);
    if (type) where.push("jobs.type = ?"), params.push(type);
    if (client) where.push("clients.client_id = ?"), params.push(client);
    const jobs = await jobService.listJobs(c.env.DB, where.join(" AND "), params, "jobs.id DESC", limit);
    if (jobs.some((j) => jobService.ACTIVE_STATUSES.includes(j.status))) kickJobs(c);
    return json({ jobs: jobs.map((j) => jobService.jobToDict(j)), types: jobService.JOB_TYPES });
  });

  /** Also used by the setup wizard (embedding progress), so no setup check here. */
  app.get("/api/admin/jobs/:job_id{[0-9]+}", async (c) => {
    const user = await requireUser(c);
    const job = await getOr404(c, user, Number(c.req.param("job_id")));
    if (jobService.ACTIVE_STATUSES.includes(job.status)) kickJobs(c);
    return json({ job: jobService.jobToDict(job, true) });
  });

  app.post("/api/admin/jobs/:job_id{[0-9]+}/retry", async (c) => {
    await requireSetupCompleted(c);
    const user = await requireUser(c);
    const job = await getOr404(c, user, Number(c.req.param("job_id")));
    if (jobService.ACTIVE_STATUSES.includes(job.status)) throw new HttpError(400, "The job is still running.");
    const fresh = await jobService.retry(c.env.DB, job, user.id);
    kickJobs(c);
    return json({ job: jobService.jobToDict(fresh) });
  });

  app.post("/api/admin/jobs/:job_id{[0-9]+}/cancel", async (c) => {
    await requireSetupCompleted(c);
    const user = await requireUser(c);
    const job = await getOr404(c, user, Number(c.req.param("job_id")));
    await jobService.requestCancel(c.env.DB, job);
    if (job.status === "running") kickJobs(c); // the next step sees the request
    return json({ job: jobService.jobToDict((await jobService.getJob(c.env.DB, job.id))!) });
  });
}
