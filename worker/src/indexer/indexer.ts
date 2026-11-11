/**
 * Turn page/document text into embedded chunks (rows in D1, vectors in Vectorize).
 *
 * Each source (a page or a document) owns its chunks, and re-indexing replaces them so search
 * never sees a half-updated source:
 *
 * * Small sources (the usual web page) are chunked and embedded in one step, then old and new
 *   chunks are swapped in one D1 batch.
 * * Large sources are processed a slice at a time across invocations (the free plan allows a few
 *   milliseconds of CPU per invocation). New chunks are written as ``pending`` rows, which search
 *   ignores; when every chunk is embedded, one batch deletes the old chunks and activates the new.
 *
 * The cursor (an IndexCursor) lives in the job's payload, so the work resumes after any interruption.
 */

import type { Embedder } from "../embeddings/embedder";
import { countTokens } from "../embeddings/embedder";
import { recordRate } from "../services/embeddings";
import { sha256Hex } from "../security/crypto";
import { all, nowIso } from "../util/db";
import { namespaceFor } from "../search/hybrid";
import { ChunkBuilder, nextSlice, type ChunkState } from "./chunker";
import { chunkIds, deleteVectors } from "./cleanup";

/** Text to index plus where it came from (the text itself is read from the page row or document). */
export interface Source {
  client_id: number;
  source_type: "web" | "doc";
  source: string; // URL or filename shown to visitors
  title: string;
  page_id: number | null;
  document_id: number | null;
}

export interface IndexCursor {
  src: Source;
  phase: "start" | "chunk" | "embed" | "swap";
  offset: number; // characters of the text already chunked
  chunker?: ChunkState;
  next_index: number; // chunk_index of the next chunk
  total: number; // chunks written
  embedded_upto: number; // id of the last pending chunk embedded
  embedded: number;
  embed_ms: number;
}

export interface IndexEnv {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
}

/** Chunks embedded per step (one embedding call), and characters chunked per step. */
export const EMBED_STEP = 24;
const SLICE_CHARS = 40_000;
const DIRECT_MAX_CHARS = 20_000;
const ROWS_PER_INSERT = 10; // 9 bound parameters per row; D1 allows 100 per statement

export function newIndexCursor(src: Source): IndexCursor {
  return { src, phase: "start", offset: 0, next_index: 0, total: 0, embedded_upto: 0, embedded: 0, embed_ms: 0 };
}

function owner(src: Source): [string, number] {
  if ((src.page_id === null) === (src.document_id === null)) throw new Error("Exactly one of page_id / document_id must be set");
  return src.page_id !== null ? ["page_id", src.page_id] : ["document_id", src.document_id!];
}

/** The title gives each chunk context ("ASICS" + "Second Floor"). */
function embedText(src: Source, piece: string): string {
  return src.title ? `${src.title}\n${piece}` : piece;
}

async function insertStatements(db: D1Database, src: Source, pieces: string[], firstIndex: number, pending: boolean): Promise<D1PreparedStatement[]> {
  const now = nowIso();
  const hashes = await Promise.all(pieces.map((p) => sha256Hex(p)));
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < pieces.length; i += ROWS_PER_INSERT) {
    const rows = pieces.slice(i, i + ROWS_PER_INSERT);
    const values: unknown[] = [];
    rows.forEach((piece, k) => {
      values.push(src.client_id, src.source_type, src.source, src.page_id, src.document_id, firstIndex + i + k, src.title || null, piece, hashes[i + k]);
    });
    statements.push(
      db
        .prepare(
          "INSERT INTO chunks (client_id, source_type, source, page_id, document_id, chunk_index, title, content, content_hash, updated_at, pending) VALUES " +
            rows.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ?, '${now}', ${pending ? 1 : 0})`).join(", ") +
            " RETURNING id, chunk_index",
        )
        .bind(...values),
    );
  }
  return statements;
}

async function upsertVectors(vectorize: VectorizeIndex, clientId: number, ids: number[], vectors: number[][]): Promise<void> {
  if (!ids.length) return;
  await vectorize.upsert(ids.map((id, i) => ({ id: String(id), values: vectors[i], namespace: namespaceFor(clientId) })));
}

/** Remove a source's half-built (pending) chunks, e.g. from a cancelled or failed run. */
export async function discardPending(env: IndexEnv, src: Source): Promise<void> {
  const [col, id] = owner(src);
  const ids = await chunkIds(env.DB, `${col} = ? AND pending = 1`, id);
  if (!ids.length) return;
  await env.DB.prepare(`DELETE FROM chunks WHERE ${col} = ? AND pending = 1`).bind(id).run();
  await deleteVectors(env.VECTORIZE, ids);
}

export interface StepOutcome {
  done: boolean;
  chunks: number; // chunks of the source (when done)
  embedded: number;
  total: number | null; // known once chunking is complete
}

/**
 * Do one step of (re)building a source's chunks. ``text`` is the whole source text.
 * Call again with the same cursor until ``done``.
 */
export async function indexStep(env: IndexEnv, embedder: Embedder, cursor: IndexCursor, text: string): Promise<StepOutcome> {
  const db = env.DB;
  const src = cursor.src;
  const [col, ownerId] = owner(src);

  if (cursor.phase === "start") {
    await discardPending(env, src);
    if (text.length <= DIRECT_MAX_CHARS) {
      const builder = new ChunkBuilder(countTokens);
      const pieces = [...builder.addText(text), ...builder.finish()];
      if (pieces.length <= EMBED_STEP) return indexDirect(env, embedder, cursor, pieces);
    }
    cursor.phase = "chunk";
  }

  if (cursor.phase === "chunk") {
    const builder = new ChunkBuilder(countTokens, cursor.chunker);
    const [slice, end] = nextSlice(text, cursor.offset, SLICE_CHARS);
    const pieces = builder.addText(slice);
    cursor.offset = end;
    if (end >= text.length) {
      pieces.push(...builder.finish());
      cursor.chunker = undefined;
      cursor.phase = "embed";
    } else {
      cursor.chunker = builder.state;
    }
    if (pieces.length) {
      await db.batch(await insertStatements(db, src, pieces, cursor.next_index, true));
      cursor.next_index += pieces.length;
      cursor.total += pieces.length;
    }
    return { done: false, chunks: 0, embedded: cursor.embedded, total: cursor.phase === "embed" ? cursor.total : null };
  }

  if (cursor.phase === "embed") {
    const rows = await all<{ id: number; content: string }>(
      db,
      `SELECT id, content FROM chunks WHERE ${col} = ? AND pending = 1 AND id > ? ORDER BY id LIMIT ?`,
      ownerId,
      cursor.embedded_upto,
      EMBED_STEP,
    );
    if (rows.length) {
      const started = Date.now();
      const vectors = await embedder.encode(rows.map((r) => embedText(src, r.content)));
      cursor.embed_ms += Date.now() - started;
      await upsertVectors(env.VECTORIZE, src.client_id, rows.map((r) => r.id), vectors);
      cursor.embedded_upto = rows[rows.length - 1].id;
      cursor.embedded += rows.length;
    }
    if (rows.length < EMBED_STEP) cursor.phase = "swap";
    return { done: false, chunks: 0, embedded: cursor.embedded, total: cursor.total };
  }

  // swap: the new chunks replace the old ones in one batch.
  const oldIds = await chunkIds(db, `${col} = ? AND pending = 0`, ownerId);
  await db.batch([
    db.prepare(`DELETE FROM chunks WHERE ${col} = ? AND pending = 0`).bind(ownerId),
    db.prepare(`UPDATE chunks SET pending = 0 WHERE ${col} = ? AND pending = 1`).bind(ownerId),
  ]);
  await deleteVectors(env.VECTORIZE, oldIds);
  await recordSpeed(db, embedder, cursor.embedded, cursor.embed_ms / 1000);
  return { done: true, chunks: cursor.total, embedded: cursor.embedded, total: cursor.total };
}

/** A small source in one step: embed, then swap old and new chunks in one D1 batch. */
async function indexDirect(env: IndexEnv, embedder: Embedder, cursor: IndexCursor, pieces: string[]): Promise<StepOutcome> {
  const db = env.DB;
  const src = cursor.src;
  const [col, ownerId] = owner(src);
  const started = Date.now();
  const vectors = pieces.length ? await embedder.encode(pieces.map((p) => embedText(src, p))) : [];
  const seconds = (Date.now() - started) / 1000;
  const oldIds = await chunkIds(db, `${col} = ?`, ownerId);
  const results = await db.batch<{ id: number; chunk_index: number }>([
    db.prepare(`DELETE FROM chunks WHERE ${col} = ?`).bind(ownerId),
    ...(await insertStatements(db, src, pieces, 0, false)),
  ]);
  const byIndex = new Map<number, number>();
  for (const res of results.slice(1)) for (const r of res.results ?? []) byIndex.set(r.chunk_index, r.id);
  const ids = pieces.map((_, i) => byIndex.get(i)!);
  await upsertVectors(env.VECTORIZE, src.client_id, ids, vectors);
  await deleteVectors(env.VECTORIZE, oldIds);
  await recordSpeed(db, embedder, pieces.length, seconds);
  cursor.total = pieces.length;
  cursor.embedded = pieces.length;
  return { done: true, chunks: pieces.length, embedded: pieces.length, total: pieces.length };
}

/** Measured speed feeds the indexing-time estimates in the admin UI. */
async function recordSpeed(db: D1Database, embedder: Embedder, chunks: number, seconds: number): Promise<void> {
  try {
    await recordRate(db, embedder.name, embedder.device, chunks, seconds);
  } catch (exc) {
    console.debug("Could not record embedding speed", exc);
  }
}

/** Delete a source's chunks (rows and vectors). */
export async function deleteSourceChunks(env: IndexEnv, pageId: number | null, documentId: number | null): Promise<void> {
  const where = pageId !== null ? "page_id = ?" : "document_id = ?";
  const id = pageId !== null ? pageId : documentId;
  const ids = await chunkIds(env.DB, where, id);
  await env.DB.prepare(`DELETE FROM chunks WHERE ${where}`).bind(id).run();
  await deleteVectors(env.VECTORIZE, ids);
}
