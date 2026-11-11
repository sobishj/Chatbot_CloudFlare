/** Client → Documents tab: uploads, indexing, use/ignore per document, key information, watched folder. */

import type { Hono } from "hono";
import { toDocument, type DocumentRow } from "../../models";
import { deleteDocument, DocumentError, documentToDict, saveUpload, WATCHED_FOLDERS_MESSAGE } from "../../documents/service";
import { chunkIds, deleteVectors } from "../../indexer/cleanup";
import { documentSettings } from "../../services/clients";
import { largeUploadWarning } from "../../services/embeddings";
import * as jobService from "../../services/jobs";
import { getSetting } from "../../services/settings";
import { all, first, run, toJson } from "../../util/db";
import { HttpError, json, readJson, validateBody } from "../../util/http";
import { kickJobs } from "../../worker/runner";
import { clientForUser, requireSetupCompleted, type AppEnv, type C } from "../context";
import { requireSuper } from "./clients";

/** Where watched folders lived in the self-hosted version (shown by the UI next to the setting). */
const WATCHED_ROOT = "/mnt/watched";

async function docsOf(db: D1Database, clientId: number): Promise<Record<string, any>[]> {
  const rows = await all(db, "SELECT * FROM documents WHERE client_id = ? ORDER BY source, path", clientId);
  return rows.map((r) => documentToDict(toDocument(r)));
}

export function registerClientDocuments(app: Hono<AppEnv>): void {
  const base = "/api/admin/clients/:client_id/documents";
  const forClient = async (c: C) => {
    await requireSetupCompleted(c);
    return clientForUser(c, c.req.param("client_id")!);
  };
  const docOr404 = async (c: C, clientId: number): Promise<DocumentRow> => {
    const row = await first(c.env.DB, "SELECT * FROM documents WHERE id = ?", Number(c.req.param("document_id")));
    if (!row || row.client_id !== clientId) throw new HttpError(404, "Document not found.");
    return toDocument(row);
  };

  app.get(base, async (c) => {
    const { client } = await forClient(c);
    return json({ documents: await docsOf(c.env.DB, client.id), settings: documentSettings(client), watched_root: WATCHED_ROOT, mode: await getSetting(c.env.DB, "mode") });
  });

  app.post(base, async (c) => {
    const { client, user } = await forClient(c);
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw new HttpError(422, [{ loc: ["body", "files"], msg: "Field required", type: "missing" }]);
    }
    const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
    if (!files.length) throw new HttpError(422, [{ loc: ["body", "files"], msg: "Field required", type: "missing" }]);
    const saved: Record<string, any>[] = [];
    const heads: { filename: string; size: number; head: Uint8Array }[] = [];
    const errors: string[] = [];
    for (const upload of files) {
      try {
        const { doc, head } = await saveUpload(c.env, client, upload.name || "upload", upload);
        saved.push(documentToDict(doc));
        heads.push({ filename: doc.path, size: doc.size_bytes, head });
      } catch (exc) {
        if (exc instanceof DocumentError) errors.push(`${upload.name}: ${exc.message}`);
        else throw exc;
      }
    }
    // A very large upload can take long to index: hold it and let the admin decide
    // (index anyway, or switch to a much faster cloud model, which re-indexes everything).
    const large = saved.length ? await largeUploadWarning(c.env.DB, heads) : null;
    let job = null;
    if (saved.length && large === null) {
      job = await jobService.enqueue(c.env.DB, "index_docs", client.id, { sources: ["upload"] }, "user", user.id);
      kickJobs(c);
    }
    return json({ saved, errors, job: job ? jobService.jobToDict(job) : null, large });
  });

  /** Index documents that are waiting (new or changed); unchanged ones are skipped. */
  app.post(`${base}/index`, async (c) => {
    const { client, user } = await forClient(c);
    const job = await jobService.enqueue(c.env.DB, "index_docs", client.id, { sources: ["upload"] }, "user", user.id);
    kickJobs(c);
    return json({ job: jobService.jobToDict(job) });
  });

  /** Use or ignore every document of the client at once. */
  app.put(`${base}/enabled`, async (c) => {
    const { client } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), { enabled: { kind: "bool", required: true } });
    await run(c.env.DB, "UPDATE documents SET enabled = ? WHERE client_id = ?", body.enabled ? 1 : 0, client.id);
    return json({ documents: await docsOf(c.env.DB, client.id) });
  });

  app.post(`${base}/reindex`, async (c) => {
    const { client, user } = await forClient(c);
    const job = await jobService.enqueue(c.env.DB, "index_docs", client.id, { force: true }, "user", user.id);
    kickJobs(c);
    return json({ job: jobService.jobToDict(job) });
  });

  app.post(`${base}/scan`, async (c) => {
    await forClient(c);
    throw new HttpError(400, WATCHED_FOLDERS_MESSAGE);
  });

  /** Always-included key information (client admins may change it). */
  app.put(`${base}/answering`, async (c) => {
    const { client } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), { key_facts: { kind: "str", default: null, max_length: 4000 } });
    const settings = documentSettings(client);
    if (body.key_facts !== null) settings.key_facts = body.key_facts.trim();
    await run(c.env.DB, "UPDATE clients SET document_settings = ? WHERE id = ?", toJson(settings), client.id);
    return json({ settings });
  });

  app.put(`${base}/settings`, async (c) => {
    const { client, user } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), {
      watch_path: { kind: "str", default: null },
      scan_interval_minutes: { kind: "int", default: null, ge: 5, le: 10080 },
    });
    requireSuper(user);
    const settings = documentSettings(client);
    if (body.watch_path !== null) {
      if (body.watch_path.trim()) throw new HttpError(400, WATCHED_FOLDERS_MESSAGE);
      settings.watch_path = null;
    }
    if (body.scan_interval_minutes !== null) settings.scan_interval_minutes = body.scan_interval_minutes;
    await run(c.env.DB, "UPDATE clients SET document_settings = ? WHERE id = ?", toJson(settings), client.id);
    // No folder: drop its documents (and chunks), as before.
    const folderDocs = (await all(c.env.DB, "SELECT * FROM documents WHERE client_id = ? AND source = 'folder'", client.id)).map(toDocument);
    for (const doc of folderDocs) {
      const ids = await chunkIds(c.env.DB, "document_id = ?", doc.id);
      await run(c.env.DB, "DELETE FROM documents WHERE id = ?", doc.id);
      await deleteVectors(c.env.VECTORIZE, ids);
    }
    return json({ settings, job: null });
  });

  app.delete(`${base}/:document_id{[0-9]+}`, async (c) => {
    const { client } = await forClient(c);
    const doc = await docOr404(c, client.id);
    try {
      await deleteDocument(c.env, doc, client);
    } catch (exc) {
      if (exc instanceof DocumentError) throw new HttpError(400, exc.message);
      throw exc;
    }
    return json({ ok: true });
  });

  /** Use or ignore one document for answers. It stays indexed, so switching back is instant. */
  app.put(`${base}/:document_id{[0-9]+}/enabled`, async (c) => {
    const { client } = await forClient(c);
    const doc = await docOr404(c, client.id);
    const body = validateBody(await readJson(c.req.raw), { enabled: { kind: "bool", required: true } });
    await run(c.env.DB, "UPDATE documents SET enabled = ? WHERE id = ?", body.enabled ? 1 : 0, doc.id);
    return json({ document: documentToDict({ ...doc, enabled: body.enabled }) });
  });
}
