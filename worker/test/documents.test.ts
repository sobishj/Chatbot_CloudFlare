// Documents (tests/test_documents.py): uploads to Workers KV, parsing, hash-based skipping, deletion,
// disabled documents, scanned PDFs, text kept for re-indexing, the 25 MB limit, and waiting while KV
// still returns an older copy of a file (eventual consistency).
import { beforeEach, describe, expect, it } from "vitest";
import { cleanMarkdown, deleteDocument, DocumentError, MAX_UPLOAD_BYTES, safeFilename, saveUpload, TOO_LARGE_MESSAGE } from "../src/documents/service";
import { toDocument } from "../src/models";
import { search } from "../src/search/hybrid";
import { createClient } from "../src/services/clients";
import * as jobService from "../src/services/jobs";
import { all, first, run } from "../src/util/db";
import { runJobs } from "../src/worker/runner";
import "../src/worker/handlers";
import { newWorkersAIEmbedder } from "../src/embeddings/embedder";
import { resetDb, testEnv } from "./fakes";

const PDF_TEXT = "Parking costs 30 rupees per hour. Valet parking is at the main entrance.";

async function sync(env: ReturnType<typeof testEnv>, clientId: number, payload: Record<string, any> = { sources: ["upload"] }) {
  const job = await jobService.enqueue(env.DB, "index_docs", clientId, payload);
  for (let i = 0; i < 200 && ["queued", "running"].includes((await jobService.getJob(env.DB, job.id))!.status); i++) await runJobs(env, 1);
  return (await jobService.getJob(env.DB, job.id))!;
}

/** Run a job to the end, letting time pass whenever it waits (KV retries set _not_before). */
async function syncWaiting(env: ReturnType<typeof testEnv>, jobId: number, onWait: (waits: number) => Promise<void> = async () => {}) {
  let waits = 0;
  for (let i = 0; i < 400 && ["queued", "running"].includes((await jobService.getJob(env.DB, jobId))!.status); i++) {
    if (await runJobs(env, 1)) continue;
    waits++;
    await onWait(waits);
    await run(env.DB, "UPDATE jobs SET lock_until = NULL, payload = json_remove(payload, '$._not_before') WHERE id = ?", jobId);
  }
  return { job: (await jobService.getJob(env.DB, jobId))!, waits };
}

function file(name: string, body: string | Uint8Array, type = "application/octet-stream"): File {
  return new File([body], name, { type });
}

describe("documents", () => {
  beforeEach(resetDb);

  it("safe_filename", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\docs\\Menu (1).pdf")).toBe("Menu (1).pdf");
    expect(safeFilename("മെനു.pdf")).toBe("മെനു.pdf");
    expect(() => safeFilename("...")).toThrow(DocumentError);
  });

  it("upload, index, unchanged, change and delete", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    const { doc } = await saveUpload(env, client, "parking.pdf", file("parking.pdf", "%PDF-1.7\n" + PDF_TEXT, "application/pdf"));
    expect(doc.status).toBe("pending");
    let job = await sync(env, client.id);
    expect(job.status).toBe("succeeded");
    expect(job.result!.indexed).toBe(1);
    let row = toDocument((await first(env.DB, "SELECT * FROM documents WHERE id = ?", doc.id))!);
    expect(row.status).toBe("indexed");
    expect(row.chunk_count).toBeGreaterThanOrEqual(1);
    expect((await first<{ source: string }>(env.DB, "SELECT source FROM chunks WHERE document_id = ?", doc.id))!.source).toBe("parking.pdf");
    expect(env.VECTORIZE.vectors.size).toBe(row.chunk_count);

    expect((await sync(env, client.id)).result!.unchanged).toBe(1); // same file: skipped

    await saveUpload(env, client, "parking.pdf", file("parking.pdf", "%PDF-1.7\nParking is free on Sundays.", "application/pdf"));
    expect((await sync(env, client.id)).result!.indexed).toBe(1);
    expect((await first<{ content: string }>(env.DB, "SELECT content FROM chunks WHERE client_id = ?", client.id))!.content).toContain("free on Sundays");

    // Deleting the document (the only way files leave storage) removes its file, chunks and vectors.
    await deleteDocument(env, toDocument((await first(env.DB, "SELECT * FROM documents WHERE id = ?", doc.id))!), client);
    expect(await env.FILES_KV.get("clients/acme/documents/parking.pdf")).toBeNull();
    job = await sync(env, client.id);
    expect(job.status).toBe("succeeded");
    expect(await first(env.DB, "SELECT id FROM chunks WHERE client_id = ?", client.id)).toBeNull();
    expect(env.VECTORIZE.vectors.size).toBe(0);
  });

  it("stores uploads in KV under the same key, with type, size and SHA-256", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    await saveUpload(env, client, "menu.txt", file("menu.txt", "Dosa 80 rupees.", "text/plain"));
    const { value, metadata } = await env.FILES_KV.getWithMetadata<Record<string, any>>("clients/acme/documents/menu.txt", "text");
    expect(value).toBe("Dosa 80 rupees.");
    expect(metadata).toMatchObject({ contentType: "text/plain", size: 15 });
    expect(metadata!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const row = (await first<{ r2_key: string; upload_hash: string }>(env.DB, "SELECT r2_key, upload_hash FROM documents"))!;
    expect(row).toEqual({ r2_key: "clients/acme/documents/menu.txt", upload_hash: metadata!.sha256 });
  });

  it("rejects files over 25 MB with a clear message", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(TOO_LARGE_MESSAGE).toContain("25 MB");
    const big = file("big.pdf", new Uint8Array(MAX_UPLOAD_BYTES + 1), "application/pdf");
    await expect(saveUpload(env, client, "big.pdf", big)).rejects.toThrow(TOO_LARGE_MESSAGE);
    expect(await first(env.DB, "SELECT id FROM documents")).toBeNull();
    expect((await env.FILES_KV.list()).keys).toHaveLength(0);
    // Exactly 25 MB is accepted.
    const max = file("max.txt", new Uint8Array(MAX_UPLOAD_BYTES).fill(97), "text/plain");
    await saveUpload(env, client, "max.txt", max);
    expect((await env.FILES_KV.getWithMetadata<{ size: number }>("clients/acme/documents/max.txt")).metadata!.size).toBe(MAX_UPLOAD_BYTES);
  });

  it("rejects file names too long for a KV key", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    const name = "മ".repeat(190) + ".txt"; // 3 bytes per letter: over KV's 512-byte key limit
    await expect(saveUpload(env, client, name, file(name, "x"))).rejects.toThrow("File name is too long");
  });

  it("waits while KV still returns an older copy, then indexes the new one", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    const key = "clients/acme/documents/menu.txt";
    await saveUpload(env, client, "menu.txt", file("menu.txt", "Dosa costs 80 rupees."));
    await sync(env, client.id);
    const old = await env.FILES_KV.getWithMetadata(key, "arrayBuffer");
    await saveUpload(env, client, "menu.txt", file("menu.txt", "Dosa costs 95 rupees now."));
    const fresh = await env.FILES_KV.getWithMetadata(key, "arrayBuffer");
    // Another location still serves the old file for a while.
    await env.FILES_KV.put(key, old.value!, { metadata: old.metadata });
    const queued = await jobService.enqueue(env.DB, "index_docs", client.id, { sources: ["upload"] });
    const { job, waits } = await syncWaiting(env, queued.id, async (n) => {
      if (n === 2) await env.FILES_KV.put(key, fresh.value!, { metadata: fresh.metadata }); // the new copy arrives
    });
    expect(waits).toBe(2);
    expect(job.status).toBe("succeeded");
    expect(job.result!.indexed).toBe(1);
    expect(job.result!.removed).toBe(0);
    expect((await first<{ content: string }>(env.DB, "SELECT content FROM chunks WHERE client_id = ?", client.id))!.content).toContain("95 rupees");
  });

  it("a file missing from KV is marked as an error after waiting, not removed", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    const { doc } = await saveUpload(env, client, "menu.txt", file("menu.txt", "Dosa 80 rupees."));
    await env.FILES_KV.delete("clients/acme/documents/menu.txt");
    const queued = await jobService.enqueue(env.DB, "index_docs", client.id, { sources: ["upload"] });
    const { job, waits } = await syncWaiting(env, queued.id);
    expect(waits).toBe(12);
    expect(job.status).toBe("succeeded");
    expect(job.result!.errors).toBe(1);
    const row = toDocument((await first(env.DB, "SELECT * FROM documents WHERE id = ?", doc.id))!);
    expect(row.status).toBe("error");
    expect(row.error).toContain("missing");
  });

  it("delete removes the file, chunks and vectors", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    const { doc } = await saveUpload(env, client, "menu.txt", file("menu.txt", "Dosa 80 rupees. Idli 40 rupees."));
    await sync(env, client.id);
    expect(env.VECTORIZE.vectors.size).toBeGreaterThan(0);
    await deleteDocument(env, toDocument((await first(env.DB, "SELECT * FROM documents WHERE id = ?", doc.id))!), client);
    expect(await env.FILES_KV.get("clients/acme/documents/menu.txt")).toBeNull();
    expect(await first(env.DB, "SELECT id FROM documents WHERE id = ?", doc.id)).toBeNull();
    expect(env.VECTORIZE.vectors.size).toBe(0);
  });

  it("keeps only the content of toMarkdown output, with page markers", () => {
    const md = "# parking.pdf\n## Metadata\n- PDFFormatVersion=1.4\n- IsLinearized=false\n\n## Contents\n### Page 1\nParking costs 30 rupees.\n### Page 2\nValet at Gate 2.";
    expect(cleanMarkdown(md, "parking.pdf")).toBe("[Page 1]\nParking costs 30 rupees.\n[Page 2]\nValet at Gate 2.");
    expect(cleanMarkdown("## Sheet1\n| Store | Floor |\n| --- | --- |\n| ASICS | 2 |", "stores.xlsx")).toContain("| ASICS | 2 |");
  });

  it("rejects bad uploads", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    await expect(saveUpload(env, client, "virus.exe", file("virus.exe", "x"))).rejects.toThrow("Unsupported file type");
    await expect(saveUpload(env, client, "empty.txt", file("empty.txt", ""))).rejects.toThrow("The file is empty.");
  });

  it("a scanned PDF and an unreadable file are marked as errors", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    await saveUpload(env, client, "scan.pdf", file("scan.pdf", "%PDF-SCANNED", "application/pdf"));
    await saveUpload(env, client, "broken.docx", file("broken.docx", "CORRUPT"));
    const job = await sync(env, client.id);
    expect(job.result!.errors).toBe(2);
    const docs = await all<{ filename: string; status: string; error: string }>(env.DB, "SELECT filename, status, error FROM documents ORDER BY filename");
    expect(docs[0]).toMatchObject({ filename: "broken.docx", status: "error" });
    expect(docs[0].error).toContain("Is it corrupt?");
    expect(docs[1]).toMatchObject({ filename: "scan.pdf", status: "error", error: "No text found: this looks like a scanned PDF." });
  });

  it("reads text encodings", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    await saveUpload(env, client, "a.md", file("a.md", "\ufeff# ലുലു മാൾ"));
    await saveUpload(env, client, "b.txt", file("b.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]))); // "café" in cp1252
    await sync(env, client.id);
    const texts = await all<{ extracted_text: string }>(env.DB, "SELECT extracted_text FROM documents ORDER BY path");
    expect(texts[0].extracted_text).toContain("ലുലു");
    expect(texts[1].extracted_text).toBe("café");
  });

  it("removes contents-page dot leaders", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    await saveUpload(env, client, "toc.txt", file("toc.txt", "1 Document Overview .......... 3\n2 Pricing . . . . . . . 4\nVersion 1.2.3 costs 4.50."));
    await sync(env, client.id);
    const text = (await first<{ extracted_text: string }>(env.DB, "SELECT extracted_text FROM documents"))!.extracted_text;
    expect(text).not.toContain(".....");
    expect(text).not.toContain(". . . .");
    expect(text).toContain("1 Document Overview … 3");
    expect(text).toContain("Version 1.2.3 costs 4.50.");
  });

  it("a disabled document is not used for answers", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    const { doc } = await saveUpload(env, client, "parking.pdf", file("parking.pdf", "%PDF-1.7\n" + PDF_TEXT, "application/pdf"));
    await sync(env, client.id);
    const embedder = newWorkersAIEmbedder(env.AI as any, "@cf/baai/bge-m3");
    expect((await search(env, embedder, client.id, "parking rupees per hour")).hits.some((h) => h.source === "parking.pdf")).toBe(true);
    await run(env.DB, "UPDATE documents SET enabled = 0 WHERE id = ?", doc.id);
    expect((await search(env, embedder, client.id, "parking rupees per hour")).hits).toEqual([]); // neither vector nor keyword hits
    const row = (await first<{ status: string; chunk_count: number }>(env.DB, "SELECT status, chunk_count FROM documents WHERE id = ?", doc.id))!;
    expect(row.status).toBe("indexed"); // still indexed: switching back is instant
    expect(row.chunk_count).toBeGreaterThanOrEqual(1);
    await run(env.DB, "UPDATE documents SET enabled = 1 WHERE id = ?", doc.id);
    expect((await search(env, embedder, client.id, "parking rupees per hour")).hits.length).toBeGreaterThan(0);
  });

  it("large documents are indexed across many steps and swapped in at the end", async () => {
    const env = testEnv();
    const client = await createClient(env.DB, "acme", "Acme", "");
    const big = Array.from({ length: 3000 }, (_, i) => `Section ${i}: the opening hours of shop number ${i} are 10 AM to 10 PM every day.`).join("\n");
    await saveUpload(env, client, "big.txt", file("big.txt", big));
    const job = await jobService.enqueue(env.DB, "index_docs", client.id, { sources: ["upload"] });
    let sawPending = false;
    for (let i = 0; i < 500 && ["queued", "running"].includes((await jobService.getJob(env.DB, job.id))!.status); i++) {
      await runJobs(env, 1);
      const pending = await first<{ n: number }>(env.DB, "SELECT count(*) AS n FROM chunks WHERE pending = 1");
      if (pending!.n > 0) {
        sawPending = true;
        // While the document is being built, search doesn't see its chunks.
        expect((await first<{ n: number }>(env.DB, "SELECT count(*) AS n FROM chunks WHERE pending = 0"))!.n).toBe(0);
      }
    }
    const done = (await jobService.getJob(env.DB, job.id))!;
    expect(done.status).toBe("succeeded");
    expect(sawPending).toBe(true);
    const chunks = (await first<{ n: number }>(env.DB, "SELECT count(*) AS n FROM chunks WHERE pending = 0"))!.n;
    expect(chunks).toBeGreaterThan(30);
    expect(env.VECTORIZE.vectors.size).toBe(chunks);
    expect(done.progress_text).toContain("embedded");
    // Too large for a D1 row: the extracted text is kept in KV instead.
    const row = (await first<{ text_r2_key: string | null; extracted_text: string | null }>(env.DB, "SELECT text_r2_key, extracted_text FROM documents"))!;
    expect(row.extracted_text ?? "").toBe(big.length > 900_000 ? "" : big);
    if (row.text_r2_key) expect(await env.FILES_KV.get(row.text_r2_key)).toBe(big);
  });
});
