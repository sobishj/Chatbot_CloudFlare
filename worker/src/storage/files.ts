/**
 * Uploaded documents, logos and large extracted texts, kept in Workers KV (binding FILES_KV).
 *
 * Keys are the same paths the files had in R2: ``clients/<client_id>/documents/<file name>``,
 * ``clients/<client_id>/branding/logo.<ext>`` and ``clients/<client_id>/text/<id>.txt``.
 * Each value carries its content type, size and (for uploads) SHA-256 as KV metadata.
 *
 * KV limits that shape the code:
 * * A value is at most 25 MiB, so that's the largest file.
 * * A key is at most 512 bytes (UTF-8).
 * * KV is eventually consistent: a new or changed value can take up to about 60 seconds to be
 *   seen by list() or by reads in other Cloudflare locations. So lists of uploads come from D1,
 *   never from list(); readers check the SHA-256 and wait when they get an older copy.
 */

/** Largest value Workers KV stores: 25 MiB. */
export const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;
const KV_MAX_KEY_BYTES = 512;

export interface FileMeta {
  contentType: string;
  size: number;
  sha256?: string;
}

export interface StoredFile {
  data: ArrayBuffer;
  meta: FileMeta;
}

/** Thrown when a file can't be stored in KV; the message is shown to the admin. */
export class FileTooLargeError extends Error {}

export function keyFits(key: string): boolean {
  return new TextEncoder().encode(key).byteLength <= KV_MAX_KEY_BYTES;
}

export async function putFile(kv: KVNamespace, key: string, data: ArrayBuffer | Uint8Array | string, meta: Omit<FileMeta, "size">): Promise<void> {
  const size = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  if (size > KV_MAX_VALUE_BYTES) throw new FileTooLargeError(`File is larger than 25 MB, the largest file this installation can store.`);
  if (!keyFits(key)) throw new FileTooLargeError("File name is too long. Rename the file and upload it again.");
  await kv.put(key, data, { metadata: { ...meta, size } satisfies FileMeta });
}

export async function getFile(kv: KVNamespace, key: string): Promise<StoredFile | null> {
  const { value, metadata } = await kv.getWithMetadata<FileMeta>(key, "arrayBuffer");
  if (value === null) return null;
  return { data: value, meta: { contentType: metadata?.contentType ?? "application/octet-stream", size: metadata?.size ?? value.byteLength, sha256: metadata?.sha256 } };
}

export async function getTextFile(kv: KVNamespace, key: string): Promise<string | null> {
  return kv.get(key, "text");
}

/** Delete these keys (KV deletes one key per call; deleting a missing key is fine). */
export async function deleteFiles(kv: KVNamespace, keys: Iterable<string>): Promise<void> {
  for (const key of new Set(keys)) await kv.delete(key);
}

/**
 * Delete every key under ``prefix`` that list() can see. Recently written keys may be missing
 * from the listing, so callers delete the keys they know about (from D1) as well.
 */
export async function deletePrefix(kv: KVNamespace, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const listing = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of listing.keys) await kv.delete(k.name);
    removed += listing.keys.length;
    if (listing.list_complete) break;
    cursor = listing.cursor;
  }
  return removed;
}

/** Total size of the stored files (from list() metadata; a recent change may not be counted yet). */
export async function storedBytes(kv: KVNamespace): Promise<number> {
  let used = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listing = await kv.list<FileMeta>({ cursor, limit: 1000 });
    for (const k of listing.keys) used += Number(k.metadata?.size ?? 0);
    if (listing.list_complete) break;
    cursor = listing.cursor;
  }
  return used;
}
