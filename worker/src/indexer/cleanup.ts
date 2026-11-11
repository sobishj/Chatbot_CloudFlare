/**
 * Keep Vectorize in step with D1: rows deleted in D1 (directly or by ON DELETE CASCADE)
 * take their vectors with them. Collect the chunk ids first, delete the rows, then
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
