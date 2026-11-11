/**
 * Client documents kept in sync with ``documents`` and ``chunks``.
 *
 * * Uploads live in Workers KV (FILES_KV) under ``clients/<client_id>/documents/<file name>``, with
 *   their SHA-256 in the value's metadata and in ``documents.upload_hash``. KV is eventually
 *   consistent, so the list of uploads comes from D1, and a read that returns an older copy waits
 *   and tries again. Watched folders need the self-hosted version.
 * * PDF, Word and Excel files are converted with Workers AI (``env.AI.toMarkdown``); text and
 *   Markdown are read directly. The extracted text is kept (in the row, or in KV when it's too
 *   large for a D1 row), so re-indexing doesn't parse the file again.
 *
 * Syncing works as before: new/changed files (by SHA-256) are indexed, unchanged files are skipped,
 * and rows of deleted files are removed (their chunks and vectors with them). It runs as a resumable
 * job: one file is read, or one batch of its chunks embedded, per step.
 */

import type { Env } from "../env";
import { toDocument, type Client, type DocumentRow } from "../models";
import { getEmbedder } from "../embeddings/embedder";
import { chunkIds, deleteVectors } from "../indexer/cleanup";
import { indexStep, newIndexCursor, type IndexCursor } from "../indexer/indexer";
import { sha256Hex } from "../security/crypto";
import { clientPrefix, documentSettings } from "../services/clients";
import { getSetting } from "../services/settings";
import { deleteFiles, FileTooLargeError, getFile, getTextFile, keyFits, KV_MAX_VALUE_BYTES, putFile } from "../storage/files";
import { all, first, nowIso, run, toJson } from "../util/db";
import { UserFacingError } from "../util/http";
import type { StepContext } from "../worker/runner";

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".txt", ".md"];
/** Workers KV stores values of up to 25 MiB, so that's the largest upload. */
export const MAX_UPLOAD_BYTES = KV_MAX_VALUE_BYTES;
export const TOO_LARGE_MESSAGE = "File is larger than 25 MB. Files are stored in Workers KV, which holds at most 25 MB per file: split or compress the file and upload the parts.";
const MAX_TEXT_CHARS = 50_000_000;
const MAX_ROW_TEXT_BYTES = 900_000; // D1 rows hold up to 2 MB; larger texts go to KV
// KV may briefly return an older copy (or nothing) right after a write: wait and retry this often.
const KV_WAIT_MS = 15_000;
const KV_WAIT_ATTEMPTS = 12; // about 3 minutes
const LEADER_RE = /(?:[ \t]*[.·•_…][ \t]*){5,}/g; // dot leaders in contents pages

export const WATCHED_FOLDERS_MESSAGE =
  "Watched folders need the self-hosted version of Website Assistant (github.com/sobishj/Chatbot); this installation runs on Cloudflare. Upload the files here instead.";

/** User-facing document error. */
export class DocumentError extends UserFacingError {}
class UnsupportedDocument extends Error {}
class EmptyDocument extends Error {}
/** KV doesn't return the file version we expect yet (eventual consistency): try again shortly. */
class NotReadyYet extends Error {}

// ----------------------------------------------------------------------------- names and keys
function extOf(name: string): string {
  const base = name.split("/").pop() || name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

function stemOf(name: string): string {
  const base = name.split("/").pop() || name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

/** Keep letters (any script), digits, spaces, dots, dashes, underscores; drop any path parts. */
export function safeFilename(name: string): string {
  let n = (name.replace(/\\/g, "/").split("/").pop() || "").normalize("NFC").trim();
  // Letters, combining marks (Indic vowel signs), digits and a few safe punctuation characters.
  n = [...n].map((ch) => (/[\p{L}\p{M}\p{N}]/u.test(ch) || " .-_()".includes(ch) ? ch : "_")).join("");
  n = n.replace(/_+/g, "_").replace(/^[ .]+|[ .]+$/g, "");
  if (!n) throw new DocumentError("Invalid file name.");
  return [...n].slice(0, 200).join("");
}

export function uploadsPrefix(client: Client): string {
  return `${clientPrefix(client.client_id)}documents/`;
}

function textKey(client: Client, docId: number): string {
  return `${clientPrefix(client.client_id)}text/${docId}.txt`;
}

export function documentToDict(doc: DocumentRow): Record<string, any> {
  return {
    id: doc.id,
    source: doc.source,
    path: doc.path,
    filename: doc.filename,
    size_bytes: doc.size_bytes,
    status: doc.status,
    error: doc.error,
    chunk_count: doc.chunk_count,
    enabled: doc.enabled,
    uploaded_at: doc.uploaded_at,
    indexed_at: doc.indexed_at,
  };
}

// ----------------------------------------------------------------------------- uploads
/** Store an uploaded file in KV and register it as pending. */
export async function saveUpload(env: Env, client: Client, filename: string, file: File): Promise<{ doc: DocumentRow; head: Uint8Array }> {
  const name = safeFilename(filename);
  if (!SUPPORTED_EXTENSIONS.includes(extOf(name))) throw new DocumentError(`Unsupported file type. Allowed: ${[...SUPPORTED_EXTENSIONS].sort().join(", ")}`);
  if (file.size > MAX_UPLOAD_BYTES) throw new DocumentError(TOO_LARGE_MESSAGE);
  if (file.size === 0) throw new DocumentError("The file is empty.");
  const key = uploadsPrefix(client) + name;
  if (!keyFits(key)) throw new DocumentError("File name is too long. Rename the file and upload it again.");
  const data = await file.arrayBuffer();
  const digest = await sha256Hex(data);
  try {
    await putFile(env.FILES_KV, key, data, { contentType: file.type || "application/octet-stream", sha256: digest });
  } catch (exc) {
    if (exc instanceof FileTooLargeError) throw new DocumentError(TOO_LARGE_MESSAGE);
    throw exc;
  }
  // The column keeps its R2-era name (r2_key): it holds the file's KV key.
  const row = await first(
    env.DB,
    "INSERT INTO documents (client_id, source, path, filename, size_bytes, status, error, chunk_count, uploaded_at, r2_key, upload_hash) VALUES (?, 'upload', ?, ?, ?, 'pending', NULL, 0, ?, ?, ?) " +
      "ON CONFLICT (client_id, source, path) DO UPDATE SET size_bytes = excluded.size_bytes, status = 'pending', error = NULL, uploaded_at = excluded.uploaded_at, r2_key = excluded.r2_key, upload_hash = excluded.upload_hash RETURNING *",
    client.id, name, name, file.size, nowIso(), key, digest,
  );
  return { doc: toDocument(row!), head: new Uint8Array(data.slice(0, 1024 * 1024)) };
}

/** Delete an uploaded document (file, text, chunks and vectors). Folder documents are removed by deleting the file. */
export async function deleteDocument(env: Env, doc: DocumentRow, client: Client): Promise<void> {
  if (doc.source !== "upload") throw new DocumentError("Files from the watched folder are removed by deleting them from the folder.");
  await removeDocument(env, doc, client);
}

async function removeDocument(env: Env, doc: DocumentRow, client: Client): Promise<void> {
  const ids = await chunkIds(env.DB, "document_id = ?", doc.id);
  await run(env.DB, "DELETE FROM documents WHERE id = ?", doc.id); // chunks go by ON DELETE CASCADE
  await deleteVectors(env.VECTORIZE, ids);
  const keys = [doc.source === "upload" ? doc.r2_key ?? uploadsPrefix(client) + doc.path : null, doc.text_r2_key].filter((k): k is string => Boolean(k));
  await deleteFiles(env.FILES_KV, keys);
}

// ----------------------------------------------------------------------------- reading
function decodeText(raw: Uint8Array): string {
  if ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff)) {
    // UTF-16 only when it has a byte-order mark
    return new TextDecoder(raw[0] === 0xff ? "utf-16le" : "utf-16be").decode(raw);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    try {
      return new TextDecoder("windows-1252", { fatal: true, ignoreBOM: false }).decode(raw);
    } catch {
      return new TextDecoder("latin1").decode(raw);
    }
  }
}

/**
 * toMarkdown output starts with the file name as a heading and a "## Metadata" list (PDF version,
 * linearized, ...) that would end up in search chunks: keep only the content. PDF pages
 * ("### Page 3") become the "[Page 3]" markers the self-hosted reader wrote.
 */
export function cleanMarkdown(md: string, filename: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inMetadata = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (i === 0 && (t === `# ${filename}` || t === `# ${stemOf(filename)}`)) return;
    if (/^##\s+Metadata\s*$/i.test(t)) {
      inMetadata = true;
      return;
    }
    if (inMetadata) {
      if (/^#{1,2}\s/.test(t)) inMetadata = false;
      else return;
    }
    if (/^##\s+Contents\s*$/i.test(t)) return;
    const pageHeading = /^###\s+Page\s+(\d+)\s*$/i.exec(t);
    out.push(pageHeading ? `[Page ${pageHeading[1]}]` : line);
  });
  return out.join("\n").trim();
}

/**
 * The document's text. Throws UnsupportedDocument / EmptyDocument with a user-facing message, and
 * NotReadyYet when KV doesn't return the uploaded version (``expectedHash``) yet.
 */
async function readDocument(env: Env, key: string, filename: string, expectedHash: string | null): Promise<string> {
  const ext = extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new UnsupportedDocument(`Unsupported file type: ${ext || "none"}`);
  const obj = await getFile(env.FILES_KV, key);
  if (!obj) throw new NotReadyYet("Cannot read file: the uploaded file is missing.");
  if (expectedHash && obj.meta.sha256 && obj.meta.sha256 !== expectedHash) throw new NotReadyYet("Cannot read file: an older copy of the file was returned.");
  let text: string;
  if (ext === ".txt" || ext === ".md") {
    text = decodeText(new Uint8Array(obj.data));
  } else {
    let result: any;
    try {
      const blob = new Blob([obj.data], { type: obj.meta.contentType || undefined });
      result = await env.AI.toMarkdown({ name: filename, blob });
      if (Array.isArray(result)) result = result[0];
    } catch (exc) {
      throw new UnsupportedDocument(`Could not read the file (${(exc as Error)?.name || "Error"}). Is it corrupt?`);
    }
    if (!result || result.format === "error") {
      const reason = String(result?.error || "conversion failed");
      if (/password|encrypt/i.test(reason)) throw new UnsupportedDocument("The PDF is password-protected.");
      throw new UnsupportedDocument(`Could not read the file (${reason.slice(0, 200)}). Is it corrupt?`);
    }
    text = cleanMarkdown(String(result.data ?? ""), filename);
  }
  // Table-of-contents leaders ("Overview ........ 3") drown out the real words of a chunk in search.
  text = text.replace(LEADER_RE, " … ").trim();
  if (!text) {
    if (ext === ".pdf") throw new EmptyDocument("No text found: this looks like a scanned PDF.");
    throw new EmptyDocument("No text found in the document.");
  }
  return text.slice(0, MAX_TEXT_CHARS);
}

/**
 * Keep the extracted text: in the row, or in KV when it's too large for a D1 row (column
 * ``text_r2_key`` keeps its R2-era name). Returns the text's SHA-256, which later reads check.
 * Throws FileTooLargeError when the text is over KV's 25 MB value limit.
 */
async function storeText(env: Env, client: Client, doc: DocumentRow, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await sha256Hex(bytes);
  if (bytes.byteLength <= MAX_ROW_TEXT_BYTES) {
    if (doc.text_r2_key) await deleteFiles(env.FILES_KV, [doc.text_r2_key]);
    await run(env.DB, "UPDATE documents SET extracted_text = ?, text_r2_key = NULL WHERE id = ?", text, doc.id);
  } else {
    const key = textKey(client, doc.id);
    await putFile(env.FILES_KV, key, bytes, { contentType: "text/plain; charset=utf-8", sha256: digest });
    await run(env.DB, "UPDATE documents SET extracted_text = NULL, text_r2_key = ? WHERE id = ?", key, doc.id);
  }
  return digest;
}

/**
 * The stored text. With ``expectedHash`` (the text was just written), throws NotReadyYet when KV
 * doesn't return that version yet; without it, a missing KV text is null.
 */
async function loadText(env: Env, docId: number, expectedHash: string | null = null): Promise<string | null> {
  const row = await first<{ extracted_text: string | null; text_r2_key: string | null }>(env.DB, "SELECT extracted_text, text_r2_key FROM documents WHERE id = ?", docId);
  if (!row) return null;
  if (row.extracted_text !== null) return row.extracted_text;
  if (!row.text_r2_key) return null;
  if (expectedHash === null) return getTextFile(env.FILES_KV, row.text_r2_key);
  const obj = await getFile(env.FILES_KV, row.text_r2_key);
  if (!obj || (obj.meta.sha256 && obj.meta.sha256 !== expectedHash)) throw new NotReadyYet("The extracted text is not available yet.");
  return new TextDecoder().decode(obj.data);
}

// ----------------------------------------------------------------------------- sync
interface FileEntry {
  path: string;
  key: string;
  size: number;
  hash: string | null;
}

interface SyncCursor {
  source_index: number;
  files: FileEntry[] | null; // snapshot of the current source's files
  file_index: number;
  present: string[];
  current: { doc_id: number; digest: string | null; label: string; index: IndexCursor; text_hash?: string } | null;
  kv_waits?: number; // retries while KV catches up with a recent write
  stats: { indexed: number; unchanged: number; removed: number; errors: number; chunks: number };
}

export interface SyncOptions {
  sources: string[];
  force: boolean;
  cursorKey?: string;
}

/**
 * The client's uploaded files, from D1 (every upload is registered there when it's saved).
 * Not from KV list(), which can miss a file for up to a minute after it was written.
 */
async function listUploads(env: Env, client: Client): Promise<FileEntry[]> {
  const prefix = uploadsPrefix(client);
  const rows = await all<{ path: string; r2_key: string | null; size_bytes: number; upload_hash: string | null }>(
    env.DB,
    "SELECT path, r2_key, size_bytes, upload_hash FROM documents WHERE client_id = ? AND source = 'upload'",
    client.id,
  );
  return rows
    .filter((r) => r.path && !r.path.includes("/") && !r.path.startsWith("~$") && !r.path.startsWith(".") && SUPPORTED_EXTENSIONS.includes(extOf(r.path)))
    .map((r) => ({ path: r.path, key: r.r2_key ?? prefix + r.path, size: r.size_bytes, hash: r.upload_hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function markError(env: Env, doc: { id: number }, message: string): Promise<void> {
  const ids = await chunkIds(env.DB, "document_id = ?", doc.id);
  await run(env.DB, "DELETE FROM chunks WHERE document_id = ?", doc.id);
  await deleteVectors(env.VECTORIZE, ids);
  await run(env.DB, "UPDATE documents SET status = 'error', error = ?, chunk_count = 0 WHERE id = ?", message.slice(0, 1000), doc.id);
}

/**
 * One step of syncing a client's documents: index new/changed files, skip unchanged ones,
 * drop rows of deleted files. Returns done with the stats when every source is finished.
 */
export async function syncDocumentsStep(
  ctx: StepContext,
  client: Client,
  options: SyncOptions,
  progress: (percent: number, text: string) => void,
): Promise<{ done: boolean; stats?: Record<string, number> }> {
  const env = ctx.env;
  const key = options.cursorKey ?? "_cursor";
  let cur: SyncCursor = ctx.payload[key];
  if (!cur) {
    cur = { source_index: 0, files: null, file_index: 0, present: [], current: null, stats: { indexed: 0, unchanged: 0, removed: 0, errors: 0, chunks: 0 } };
    ctx.payload[key] = cur;
  }
  /** KV hasn't caught up with a recent write: try this step again shortly (false when waited long enough). */
  const waitForKv = (label: string): boolean => {
    cur.kv_waits = (cur.kv_waits ?? 0) + 1;
    if (cur.kv_waits > KV_WAIT_ATTEMPTS) return false;
    ctx.notBefore(Date.now() + KV_WAIT_MS);
    ctx.log(`${label}: waiting for the stored file to be available (attempt ${cur.kv_waits})`);
    return true;
  };
  const finish = async () => {
    if (options.sources.includes("folder")) {
      const settings = { ...documentSettings(client), last_scan_at: new Date().toISOString() };
      await run(env.DB, "UPDATE clients SET document_settings = ? WHERE id = ?", toJson(settings), client.id);
    }
    return { done: true, stats: cur.stats };
  };

  while (cur.source_index < options.sources.length) {
    const source = options.sources[cur.source_index];
    if (cur.files === null) {
      // Watched folders aren't available here: no files, so the folder's old rows (if any) go.
      cur.files = source === "upload" ? await listUploads(env, client) : [];
      cur.file_index = 0;
      cur.present = [];
      return { done: false };
    }
    const files = cur.files;

    // ---------------------------------------------------------------- a document being indexed
    if (cur.current) {
      const c = cur.current;
      const doc = await first(env.DB, "SELECT * FROM documents WHERE id = ?", c.doc_id);
      if (!doc) {
        ctx.log(`Skipped ${files[cur.file_index]?.path ?? ""}: it was deleted while being indexed`);
        cur.current = null;
        cur.file_index++;
        return { done: false };
      }
      let text: string;
      try {
        text = (await loadText(env, c.doc_id, c.text_hash ?? null)) ?? "";
      } catch (exc) {
        if (!(exc instanceof NotReadyYet)) throw exc;
        if (waitForKv(c.label)) return { done: false };
        await markError(env, { id: c.doc_id }, "The extracted text could not be read back from storage. Try indexing again.");
        cur.stats.errors++;
        cur.kv_waits = 0;
        cur.current = null;
        cur.file_index++;
        return { done: false };
      }
      cur.kv_waits = 0;
      const embedder = await getEmbedder(env, (await getSetting(env.DB, "embedding")) || {});
      const outcome = await indexStep(env, embedder, c.index, text);
      const i = cur.file_index + 1;
      const n = files.length;
      if (!outcome.done) {
        if (outcome.total) progress(((i - 0.5 + outcome.embedded / outcome.total / 2) * 100) / n, `${c.label} · embedded ${outcome.embedded} of ${outcome.total} chunks`);
        return { done: false };
      }
      await run(env.DB, "UPDATE documents SET file_hash = ?, status = 'indexed', error = NULL, chunk_count = ?, indexed_at = ? WHERE id = ?", c.digest, outcome.chunks, nowIso(), c.doc_id);
      cur.stats.indexed++;
      cur.stats.chunks += outcome.chunks;
      ctx.log(`Indexed ${source} document ${files[cur.file_index].path} (${outcome.chunks} chunks)`);
      cur.current = null;
      cur.file_index++;
      return { done: false };
    }

    // ---------------------------------------------------------------- the next file
    if (cur.file_index < files.length) {
      if (ctx.cancelRequested) return { done: true, stats: cur.stats }; // stopped: report what was done
      const file = files[cur.file_index];
      const i = cur.file_index + 1;
      const label = `${source}: ${i} of ${files.length} · ${file.path}`;
      progress(((i - 1) * 100) / Math.max(files.length, 1), label);
      cur.present.push(file.path);
      let row = await first(env.DB, "SELECT * FROM documents WHERE client_id = ? AND source = ? AND path = ?", client.id, source, file.path);
      if (!row && source === "upload") {
        // Uploads are listed from D1: no row means it was deleted since this job started.
        cur.present.pop();
        cur.file_index++;
        return { done: false };
      }
      if (!row) {
        row = await first(
          env.DB,
          "INSERT INTO documents (client_id, source, path, filename, status, chunk_count, size_bytes, r2_key) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?) RETURNING *",
          client.id, source, file.path, file.path.split("/").pop(), file.key,
        );
      }
      const doc = toDocument(row!);
      const digest = file.hash;
      await run(env.DB, "UPDATE documents SET size_bytes = ? WHERE id = ?", file.size, doc.id);
      if (!options.force && digest !== null && doc.file_hash === digest && doc.status === "indexed") {
        cur.stats.unchanged++;
        cur.file_index++;
        return { done: false };
      }
      let text: string;
      try {
        // A forced re-index reuses the text extracted last time if the file hasn't changed.
        const reuse = doc.file_hash !== null && doc.file_hash === digest ? await loadText(env, doc.id) : null;
        text = reuse ?? (await readDocument(env, file.key, doc.filename, digest));
      } catch (caught) {
        let exc = caught;
        if (exc instanceof NotReadyYet) {
          if (waitForKv(label)) {
            cur.present.pop(); // this file is looked at again in the next step
            return { done: false };
          }
          exc = new UnsupportedDocument(exc.message);
        }
        cur.kv_waits = 0;
        if (exc instanceof UnsupportedDocument || exc instanceof EmptyDocument) {
          await run(env.DB, "UPDATE documents SET file_hash = ? WHERE id = ?", digest, doc.id);
          await markError(env, doc, exc.message);
          ctx.log(`${file.path}: ${exc.message}`);
          cur.stats.errors++;
          cur.file_index++;
          return { done: false };
        }
        throw exc;
      }
      cur.kv_waits = 0;
      let textHash: string;
      try {
        textHash = await storeText(env, client, doc, text);
      } catch (exc) {
        if (!(exc instanceof FileTooLargeError)) throw exc;
        await run(env.DB, "UPDATE documents SET file_hash = ? WHERE id = ?", digest, doc.id);
        await markError(env, doc, "The text in this file is larger than 25 MB, more than can be stored. Split the file into smaller ones.");
        ctx.log(`${file.path}: extracted text over 25 MB`);
        cur.stats.errors++;
        cur.file_index++;
        return { done: false };
      }
      // Reading fills the first half of this file's share of the bar, embedding the second.
      progress(((i - 0.5) * 100) / files.length, `${label} · read`);
      cur.current = {
        doc_id: doc.id,
        digest,
        label,
        index: newIndexCursor({ client_id: client.id, source_type: "doc", source: doc.filename, title: stemOf(doc.filename), page_id: null, document_id: doc.id }),
        text_hash: textHash,
      };
      return { done: false };
    }

    // ---------------------------------------------------------------- rows of deleted files
    const present = new Set(cur.present);
    const rows = (await all(env.DB, "SELECT * FROM documents WHERE client_id = ? AND source = ?", client.id, source)).map(toDocument);
    for (const doc of rows) {
      if (present.has(doc.path)) continue;
      await removeDocument(env, doc, client);
      cur.stats.removed++;
      ctx.log(`Removed ${source} document ${doc.path} (file deleted)`);
    }
    cur.source_index++;
    cur.files = null;
  }
  return finish();
}
