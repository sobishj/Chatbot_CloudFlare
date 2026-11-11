/** Data retention (run daily by the scheduler). */

import { isoMinus, run } from "../util/db";

/**
 * Delete questions (and API action call logs) older than ``retentionDays`` (0 = keep forever).
 *
 * Returns the number of questions deleted. Per-conversation action state (encrypted
 * personal-data placeholders) is always dropped after a day, whatever the retention.
 */
export async function applyRetention(db: D1Database, retentionDays: number): Promise<number> {
  await run(db, "DELETE FROM action_sessions WHERE updated_at < ?", isoMinus(86400_000));
  if (retentionDays <= 0) return 0;
  const cutoff = isoMinus(retentionDays * 86400_000);
  const [questions] = await db.batch([
    db.prepare("DELETE FROM questions WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM action_calls WHERE created_at < ?").bind(cutoff),
  ]);
  return questions.meta.changes ?? 0;
}
