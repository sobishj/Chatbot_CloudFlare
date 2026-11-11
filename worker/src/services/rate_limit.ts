/** Fixed-window rate limiting stored in D1 (shared by every Worker instance). */

import { first, run } from "../util/db";

/** Count one request for ``key``; true if it is allowed, false if over ``limit``. A limit of 0 or less disables the check. */
export async function hit(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (limit <= 0) return true;
  const nowS = Math.floor(Date.now() / 1000);
  const windowStart = new Date(Math.floor(nowS / windowSeconds) * windowSeconds * 1000).toISOString();
  const row = await first<{ count: number }>(
    db,
    "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
      "ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count",
    [...key].slice(0, 200).join(""),
    windowStart,
  );
  return (row?.count ?? 1) <= limit;
}

/** Delete old counters; returns the number removed. */
export async function cleanup(db: D1Database, olderThanMs = 86400_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = await run(db, "DELETE FROM rate_limits WHERE window_start < ?", cutoff);
  return res.meta.changes ?? 0;
}
