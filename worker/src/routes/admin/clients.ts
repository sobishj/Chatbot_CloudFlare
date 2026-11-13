/**
 * Clients list + client detail tabs (overview, AI model, branding, allowed domains, test chat,
 * embed code). Website, documents and statistics tabs are in clients_*.ts.
 *
 * Access: super admins see every client; client admins only their assigned clients and
 * only the tabs they may use (enforced here, not just hidden in the UI).
 */

import type { Hono } from "hono";
import { toClient, type Client, type User } from "../../models";
import { answerQuestion, type ChatResponse } from "../../chat/service";
import { streamAnswer } from "../../chat/stream";
import { chunkIds, deleteVectors } from "../../indexer/cleanup";
import { deleteFiles, deletePrefix, putFile } from "../../storage/files";
import { getModel, listModels, modelToDict } from "../../services/ai_models";
import {
  ClientError,
  clientCounts,
  clientPrefix,
  clientToDict,
  createClient,
  getById,
  modelNames,
  normalizeDomains,
  normalizeUrl,
  validateBranding,
} from "../../services/clients";
import * as jobService from "../../services/jobs";
import { getSetting, getSettingsMap, setSetting } from "../../services/settings";
import { accessibleClientIds } from "../../services/users";
import { all, first, inList, run, toJson } from "../../util/db";
import { HttpError, json, queryInt, readJson, validateBody } from "../../util/http";
import { clientForUser, requireSetupCompleted, requireSuperAdmin, requireUser, type AppEnv, type C } from "../context";
import { allLogoKeys, BRANDING_IMAGES, brandingImageUrl, logoKey, logoResponse, sseResponse, type BrandingImage } from "../public";
import { kickJobs } from "../../worker/runner";

const LOGO_MAX_BYTES = 1024 * 1024;
const LOGO_TYPES: [number[], [string, string]][] = [
  [[0x89, 0x50, 0x4e, 0x47], ["png", "image/png"]],
  [[0xff, 0xd8, 0xff], ["jpg", "image/jpeg"]],
  [[0x47, 0x49, 0x46, 0x38], ["gif", "image/gif"]],
  [[0x52, 0x49, 0x46, 0x46], ["webp", "image/webp"]],
];

export function requireSuper(user: User): void {
  if (user.role !== "super_admin") throw new HttpError(403, "Only super admins can change this.");
}

/** The client as the detail page shows it; queues a step of any active job (the page polls this). */
export async function clientDetail(c: C, client: Client, user: User): Promise<Record<string, any>> {
  const db = c.env.DB;
  client = (await getById(db, client.id)) ?? client;
  const counts = (await clientCounts(db, [client.id])).get(client.id) ?? {};
  const names = await modelNames(db);
  const data = clientToDict(client, counts, client.ai_model_id ? names.get(client.ai_model_id) ?? null : null);
  const values = await getSettingsMap(db, ["default_model_id", "public_domain", "mode"]);
  const defaultName = values.default_model_id ? names.get(values.default_model_id) ?? null : null;
  data.effective_model_name = client.ai_model_id ? names.get(client.ai_model_id) ?? null : defaultName;
  const active = await jobService.listJobs(db, "jobs.client_id = ? AND jobs.status IN ('queued', 'running')", [client.id], "jobs.id");
  data.active_jobs = active.map((j) => jobService.jobToDict(j));
  data.recent_jobs = (await jobService.listJobs(db, "jobs.client_id = ?", [client.id], "jobs.id DESC", 10)).map((j) => jobService.jobToDict(j));
  data.logo_url = brandingImageUrl(client, "logo", "/api/admin/clients");
  data.bubble_icon_url = brandingImageUrl(client, "bubble-icon", "/api/admin/clients");
  data.can_edit_settings = user.role === "super_admin";
  data.mode = values.mode;
  if (active.length) kickJobs(c);
  return data;
}

/** Delete a client with its vectors and files (rows go by ON DELETE CASCADE). */
export async function deleteClientEverywhere(env: { DB: D1Database; VECTORIZE: VectorizeIndex; FILES_KV: KVNamespace }, client: Client): Promise<void> {
  const ids = await chunkIds(env.DB, "client_id = ?", client.id);
  // The file keys known to D1 first: KV list() can miss files written in the last minute.
  const docs = await all<{ r2_key: string | null; text_r2_key: string | null }>(env.DB, "SELECT r2_key, text_r2_key FROM documents WHERE client_id = ?", client.id);
  await run(env.DB, "DELETE FROM clients WHERE id = ?", client.id);
  await deleteVectors(env.VECTORIZE, ids);
  const keys = docs.flatMap((d) => [d.r2_key, d.text_r2_key]).filter((k): k is string => Boolean(k));
  await deleteFiles(env.FILES_KV, [...keys, ...allLogoKeys(client)]);
  await deletePrefix(env.FILES_KV, clientPrefix(client.client_id));
}

function testChatPayload(result: ChatResponse, threshold: unknown): Record<string, any> {
  return {
    confirmation: result.confirmation,
    action_results: result.action_results,
    answer: result.answer,
    sources: result.sources,
    answered: result.answered,
    confidence: result.confidence,
    threshold,
    model_name: result.model_name,
    used_fallback: result.used_fallback,
    response_ms: result.response_ms,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    cost: result.cost,
    language: result.language,
    error: result.error,
    chunks: result.hits.map((h) => ({
      title: h.title,
      source: h.source,
      source_type: h.source_type,
      similarity: h.similarity,
      keyword: h.text_rank !== null,
      preview: h.content.slice(0, 300),
    })),
  };
}

const TEST_CHAT_SPEC = {
  session_id: { kind: "str" as const, required: true, min_length: 1, max_length: 64 },
  message: { kind: "str" as const, required: true, min_length: 1, max_length: 1000 },
  confirm: { kind: "bool" as const, default: null },
};

export function registerClients(app: Hono<AppEnv>): void {
  const base = "/api/admin/clients";
  const guard = async (c: C) => {
    await requireSetupCompleted(c);
  };
  const forClient = async (c: C) => {
    await guard(c);
    return clientForUser(c, c.req.param("client_id")!);
  };

  // ------------------------------------------------------------------ list / create
  app.get(base, async (c) => {
    await guard(c);
    const user = await requireUser(c);
    const db = c.env.DB;
    const allowed = accessibleClientIds(user);
    const l = inList(allowed ?? []);
    const rows = await all(db, `SELECT * FROM clients${allowed === null ? "" : ` WHERE id IN ${l.sql}`} ORDER BY name COLLATE NOCASE`, ...l.params);
    const clients = rows.map(toClient);
    const counts = await clientCounts(db, clients.map((x) => x.id));
    const names = await modelNames(db);
    const defaultId = await getSetting(db, "default_model_id");
    const defaultName = defaultId ? names.get(defaultId) ?? null : null;
    const out = clients.map((x) => {
      const row = clientToDict(x, counts.get(x.id), x.ai_model_id ? names.get(x.ai_model_id) ?? null : null);
      row.effective_model_name = x.ai_model_id ? names.get(x.ai_model_id) ?? null : defaultName ? `${defaultName} (default)` : null;
      return row;
    });
    return json({ clients: out, mode: await getSetting(db, "mode") });
  });

  app.post(base, async (c) => {
    await guard(c);
    const user = await requireSuperAdmin(c);
    const body = validateBody(await readJson(c.req.raw), {
      client_id: { kind: "str", required: true },
      name: { kind: "str", required: true },
      website_url: { kind: "str", default: "" },
      allowed_domains: { kind: "list_str", default: [] },
    });
    const db = c.env.DB;
    const onprem = (await getSetting(db, "mode")) === "onprem";
    if (onprem && ((await first<{ n: number }>(db, "SELECT count(id) AS n FROM clients"))?.n ?? 0)) {
      throw new HttpError(400, "On-premise mode supports a single client.");
    }
    const client = await createClient(db, body.client_id, body.name, body.website_url, body.allowed_domains);
    if (onprem) await setSetting(db, "onprem_client_id", client.id); // the first client becomes the assistant
    return json({ client: await clientDetail(c, client, user) });
  });

  // ------------------------------------------------------------------ overview
  app.get(`${base}/:client_id`, async (c) => {
    const { client, user } = await forClient(c);
    return json({ client: await clientDetail(c, client, user) });
  });

  app.patch(`${base}/:client_id`, async (c) => {
    const { client, user } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), { name: { kind: "str", default: null }, website_url: { kind: "str", default: null }, active: { kind: "bool", default: null } });
    requireSuper(user);
    if (body.name !== null) {
      if (!body.name.trim()) throw new HttpError(400, "Name is required.");
      client.name = body.name.trim();
    }
    if (body.website_url !== null) client.website_url = normalizeUrl(body.website_url) || null;
    if (body.active !== null) client.active = body.active;
    await run(c.env.DB, "UPDATE clients SET name = ?, website_url = ?, active = ? WHERE id = ?", client.name, client.website_url, client.active ? 1 : 0, client.id);
    return json({ client: await clientDetail(c, client, user) });
  });

  app.delete(`${base}/:client_id`, async (c) => {
    const { client, user } = await forClient(c);
    requireSuper(user);
    if ((await getSetting(c.env.DB, "onprem_client_id")) === client.id) throw new HttpError(400, "The on-premise client cannot be deleted.");
    await deleteClientEverywhere(c.env, client);
    return json({ ok: true });
  });

  // ------------------------------------------------------------------ AI model
  app.get(`${base}/:client_id/model`, async (c) => {
    const { client } = await forClient(c);
    const db = c.env.DB;
    const values = await getSettingsMap(db, ["default_model_id", "fallback_model_id", "mode"]);
    const models = [];
    for (const m of await listModels(db)) {
      const d = await modelToDict(c.env.SECRET_KEY, m, values.default_model_id, values.fallback_model_id);
      delete d.api_key_masked;
      models.push(d);
    }
    return json({ ai_model_id: client.ai_model_id, default_model_id: values.default_model_id, fallback_model_id: values.fallback_model_id, mode: values.mode, models });
  });

  app.put(`${base}/:client_id/model`, async (c) => {
    const { client, user } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), { ai_model_id: { kind: "int", required: true, nullable: true } });
    requireSuper(user);
    if (body.ai_model_id !== null && !(await getModel(c.env.DB, body.ai_model_id))) throw new HttpError(404, "Model not found.");
    await run(c.env.DB, "UPDATE clients SET ai_model_id = ? WHERE id = ?", body.ai_model_id, client.id);
    return json({ client: await clientDetail(c, client, user) });
  });

  // ------------------------------------------------------------------ branding
  app.put(`${base}/:client_id/branding`, async (c) => {
    const { client, user } = await forClient(c);
    const body = validateBody({ body: await readJson(c.req.raw) }, { body: { kind: "dict", required: true } }).body;
    const changes = validateBranding(body);
    await run(c.env.DB, "UPDATE clients SET branding = ? WHERE id = ?", toJson({ ...(client.branding || {}), ...changes }), client.id);
    return json({ client: await clientDetail(c, client, user) });
  });

  // Header logo and chat-bubble icon: same upload rules, separate files.
  for (const kind of Object.keys(BRANDING_IMAGES) as BrandingImage[]) {
    const { field, version, label } = BRANDING_IMAGES[kind];

    app.post(`${base}/:client_id/${kind}`, async (c) => {
      const { client, user } = await forClient(c);
      const form = await c.req.raw.formData().catch(() => null);
      const file = form?.get("file");
      if (!file || typeof file === "string") throw new HttpError(422, [{ loc: ["body", "file"], msg: "Field required", type: "missing" }]);
      if (file.size > LOGO_MAX_BYTES) throw new HttpError(400, `${label} must be 1 MB or smaller.`);
      const data = new Uint8Array(await file.arrayBuffer());
      const type = LOGO_TYPES.find(([magic]) => magic.every((b, i) => data[i] === b))?.[1];
      const isWebp = data.length >= 12 && String.fromCharCode(...data.slice(8, 12)) === "WEBP";
      if (!type || (type[0] === "webp" && !isWebp)) throw new HttpError(400, "Upload a PNG, JPG, GIF or WebP image.");
      const filename = `${kind}.${type[0]}`;
      await deleteFiles(c.env.FILES_KV, allLogoKeys(client, [kind]).filter((k) => k !== logoKey(client, filename)));
      await putFile(c.env.FILES_KV, logoKey(client, filename), data, { contentType: type[1] });
      const brandingValue = { ...(client.branding || {}), [field]: filename, [version]: Math.floor(Date.now() / 1000) };
      await run(c.env.DB, "UPDATE clients SET branding = ? WHERE id = ?", toJson(brandingValue), client.id);
      return json({ client: await clientDetail(c, client, user) });
    });

    app.delete(`${base}/:client_id/${kind}`, async (c) => {
      const { client, user } = await forClient(c);
      await deleteFiles(c.env.FILES_KV, allLogoKeys(client, [kind]));
      await run(c.env.DB, "UPDATE clients SET branding = ? WHERE id = ?", toJson({ ...(client.branding || {}), [field]: null }), client.id);
      return json({ client: await clientDetail(c, client, user) });
    });

    app.get(`${base}/:client_id/${kind}`, async (c) => {
      const { client } = await forClient(c);
      return logoResponse(c.env, client, kind);
    });
  }

  // ------------------------------------------------------------------ domains
  app.put(`${base}/:client_id/domains`, async (c) => {
    const { client, user } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), { allowed_domains: { kind: "list_str", required: true } });
    requireSuper(user);
    let domains: string[];
    try {
      domains = normalizeDomains(body.allowed_domains);
    } catch (exc) {
      if (exc instanceof ClientError) throw new HttpError(400, exc.message);
      throw exc;
    }
    await run(c.env.DB, "UPDATE clients SET allowed_domains = ? WHERE id = ?", toJson(domains), client.id);
    return json({ client: await clientDetail(c, client, user) });
  });

  // ------------------------------------------------------------------ test chat
  /** Chat exactly like a visitor (same pipeline), with diagnostics. Logged with channel 'test'. */
  app.post(`${base}/:client_id/test-chat`, async (c) => {
    const { client } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), TEST_CHAT_SPEC);
    const result = await answerQuestion(c.env, client, body.session_id, body.message, "test", body.confirm);
    return json(testChatPayload(result, await getSetting(c.env.DB, "confidence_threshold")));
  });

  /** Test chat with the answer arriving word by word, like the widget; diagnostics come with the final event. */
  app.post(`${base}/:client_id/test-chat/stream`, async (c) => {
    const { client } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), TEST_CHAT_SPEC);
    const threshold = await getSetting(c.env.DB, "confidence_threshold");
    async function* events() {
      for await (const [kind, value] of streamAnswer(c.env, client, body.session_id, body.message, "test", body.confirm)) {
        yield kind === "delta" ? { t: "delta", text: value } : { t: "done", ...testChatPayload(value as ChatResponse, threshold) };
      }
    }
    return sseResponse(events(), {});
  });

  // ------------------------------------------------------------------ embed code
  app.get(`${base}/:client_id/embed`, async (c) => {
    const { client } = await forClient(c);
    const domain = await getSetting(c.env.DB, "public_domain");
    let origin: string;
    if (domain) {
      const scheme = domain.startsWith("localhost") || domain.startsWith("127.") ? "http" : "https";
      origin = `${scheme}://${domain}`;
    } else {
      origin = new URL(c.req.url).origin;
    }
    const snippet = `<script src="${origin}/widget.js" data-client="${client.client_id}" defer></script>`;
    return json({ snippet, widget_url: `${origin}/widget.js`, public_domain: domain, allowed_domains: client.allowed_domains });
  });

  // ------------------------------------------------------------------ jobs
  app.get(`${base}/:client_id/jobs`, async (c) => {
    const { client } = await forClient(c);
    const url = new URL(c.req.url);
    const limit = queryInt(url, "limit", 20, 1, 200);
    const jobs = await jobService.listJobs(c.env.DB, "jobs.client_id = ?", [client.id], "jobs.id DESC", limit);
    return json({ jobs: jobs.map((j) => jobService.jobToDict(j)) });
  });
}
