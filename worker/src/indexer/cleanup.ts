/**
 * Keep Vectorize and R2 in step with D1: rows deleted in D1 (directly or by ON DELETE CASCADE)
 * take their vectors and files with them. Collect the chunk ids first, delete the rows, then
 * delete the vectors (a vector without a row is ignored by search in the meantime).
 */

import { all } from "../util/db";

const DELETE_BATCH = 500;

export async function chunkIds(db: D1Database, where: string, ...params: unknown[]): Promise<number[]> {
  return (await all<{ id: number }>(db, `SELECT id FROM chunks WHERE ${where}`, ...params)).map((r) => r.id);
}

export async function deleteVectors(vectorize: VectorizeIndex, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    try {
      await vectorize.deleteByIds(ids.slice(i, i + DELETE_BATCH).map(String));
    } catch (exc) {
      // Orphaned vectors are harmless (search drops ids without a chunk row); log and carry on.
      console.warn("Could not delete vectors", exc);
    }
  }
}

/** Delete every R2 object under ``prefix``. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const listing = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listing.objects.map((o) => o.key);
    if (keys.length) {
      await bucket.delete(keys);
      removed += keys.length;
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  return removed;
}
