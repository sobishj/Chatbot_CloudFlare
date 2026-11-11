/**
 * Client documents kept in sync with ``documents`` and ``chunks``.
 *
 * * Uploads live in R2 under ``clients/<client_id>/documents/<file name>``, with their SHA-256 in
 *   the object's metadata. Watched folders need the self-hosted version.
 * * PDF, Word and Excel files are converted with Workers AI (``env.AI.toMarkdown``); text and
 *   Markdown are read directly. The extracted text is kept (in the row, or in R2 when it's too
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
import { all, first, nowIso, run, toJson } from "../util/db";
import { UserFacingError } from "../util/http";
import type { StepContext } from "../worker/runner";

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".txt", ".md"];
/** Cloudflare's request body limit on the Free plan is 100 MB, so that's the largest upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000_000;
const MAX_ROW_TEXT_BYTES = 900_000; // D1 rows hold up to 2 MB; larger texts go to R2
const LEADER_RE = /(?:[ \t]*[.·•_…][ \t]*){5,}/g; // dot leaders in contents pages

export const WATCHED_FOLDERS_MESSAGE =
  "Watched folders need the self-hosted version of Website Assistant (github.com/sobishj/Chatbot); this installation runs on Cloudflare. Upload the files here instead.";

/** User-facing document error. */
export class DocumentError extends UserFacingError {}
class UnsupportedDocument extends Error {}
class EmptyDocument extends Error {}

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
/** Store an uploaded file in R2 and register it as pending. */
export async function saveUpload(env: Env, client: Client, filename: string, file: File): Promise<{ doc: DocumentRow; head: Uint8Array }> {
  const name = safeFilename(filename);
  if (!SUPPORTED_EXTENSIONS.includes(extOf(name))) throw new DocumentError(`Unsupported file type. Allowed: ${[...SUPPORTED_EXTENSIONS].sort().join(", ")}`);
  if (file.size > MAX_UPLOAD_BYTES) throw new DocumentError(`File is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
  if (file.size === 0) throw new DocumentError("The file is empty.");
  const data = await file.arrayBuffer();
  const digest = await sha256Hex(data);
  const key = uploadsPrefix(client) + name;
  await env.FILES.put(key, data, { customMetadata: { sha256: digest }, httpMetadata: { contentType: file.type || "application/octet-stream" } });
  const row = await first(
    env.DB,
    "INSERT INTO documents (client_id, source, path, filename, size_bytes, status, error, chunk_count, uploaded_at, r2_key) VALUES (?, 'upload', ?, ?, ?, 'pending', NULL, 0, ?, ?) " +
      "ON CONFLICT (client_id, source, path) DO UPDATE SET size_bytes = excluded.size_bytes, status = 'pending', error = NULL, uploaded_at = excluded.uploaded_at, r2_key = excluded.r2_key RETURNING *",
    client.id, name, name, file.size, nowIso(), key,
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
  const keys = [doc.r2_key ?? uploadsPrefix(client) + doc.path, doc.text_r2_key].filter((k): k is string => Boolean(k));
  if (doc.source === "upload" && keys.length) await env.FILES.delete(keys);
  else if (doc.text_r2_key) await env.FILES.delete(doc.text_r2_key);
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

/** The document's text. Throws UnsupportedDocument / EmptyDocument with a user-facing message. */
async function readDocument(env: Env, key: string, filename: string): Promise<string> {
  const ext = extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new UnsupportedDocument(`Unsupported file type: ${ext || "none"}`);
  const obj = await env.FILES.get(key);
  if (!obj) throw new UnsupportedDocument("Cannot read file: the uploaded file is missing.");
  let text: string;
  if (ext === ".txt" || ext === ".md") {
    text = decodeText(new Uint8Array(await obj.arrayBuffer()));
  } else {
    let result: any;
    try {
      const blob = new Blob([await obj.arrayBuffer()], { type: obj.httpMetadata?.contentType || undefined });
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

/** Keep the extracted text: in the row, or in R2 when it's too large for a D1 row. */
async function storeText(env: Env, client: Client, doc: DocumentRow, text: string): Promise<void> {
  const size = new TextEncoder().encode(text).byteLength;
  if (size <= MAX_ROW_TEXT_BYTES) {
    if (doc.text_r2_key) await env.FILES.delete(doc.text_r2_key);
    await run(env.DB, "UPDATE documents SET extracted_text = ?, text_r2_key = NULL WHERE id = ?", text, doc.id);
  } else {
    const key = textKey(client, doc.id);
    await env.FILES.put(key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    await run(env.DB, "UPDATE documents SET extracted_text = NULL, text_r2_key = ? WHERE id = ?", key, doc.id);
  }
}

async function loadText(env: Env, docId: number): Promise<string | null> {
  const row = await first<{ extracted_text: string | null; text_r2_key: string | null }>(env.DB, "SELECT extracted_text, text_r2_key FROM documents WHERE id = ?", docId);
  if (!row) return null;
  if (row.extracted_text !== null) return row.extracted_text;
  if (row.text_r2_key) return (await (await env.FILES.get(row.text_r2_key))?.text()) ?? null;
  return null;
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
  current: { doc_id: number; digest: string | null; label: string; index: IndexCursor } | null;
  stats: { indexed: number; unchanged: number; removed: number; errors: number; chunks: number };
}

export interface SyncOptions {
  sources: string[];
  force: boolean;
  cursorKey?: string;
}

async function listUploads(env: Env, client: Client): Promise<FileEntry[]> {
  const prefix = uploadsPrefix(client);
  const out: FileEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listing = await env.FILES.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] } as R2ListOptions);
    for (const o of listing.objects) {
      const path = o.key.slice(prefix.length);
      if (!path || path.includes("/") || path.startsWith("~$") || path.startsWith(".") || !SUPPORTED_EXTENSIONS.includes(extOf(path))) continue;
      out.push({ path, key: o.key, size: o.size, hash: o.customMetadata?.sha256 ?? null });
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
      const text = (await loadText(env, c.doc_id)) ?? "";
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
        text = reuse ?? (await readDocument(env, file.key, doc.filename));
      } catch (exc) {
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
      await storeText(env, client, doc, text);
      // Reading fills the first half of this file's share of the bar, embedding the second.
      progress(((i - 0.5) * 100) / files.length, `${label} · read`);
      cur.current = {
        doc_id: doc.id,
        digest,
        label,
        index: newIndexCursor({ client_id: client.id, source_type: "doc", source: doc.filename, title: stemOf(doc.filename), page_id: null, document_id: doc.id }),
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
