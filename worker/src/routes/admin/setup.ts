/**
 * First-run setup wizard API (/setup in the UI). Disabled once setup is completed.
 *
 * Step 1 (create the super admin) is open to anyone, but only while no user exists.
 * Every later step requires that super admin to be signed in.
 */

import type { Hono } from "hono";
import type { Env } from "../../env";
import { findOption, LOCAL_EMBEDDINGS_MESSAGE } from "../../embeddings/catalog";
import { PROVIDERS } from "../../llm/providers";
import { sessionCookie } from "../../security/sessions";
import { configFromForm, discoverModels, getModel, ModelError, modelToDict, recordTest, runTest, saveModel } from "../../services/ai_models";
import { ClientError, clientToDict, createClient, getById } from "../../services/clients";
import { EmbeddingChoiceError, embeddingView, switchToWorkersAI } from "../../services/embeddings";
import * as jobService from "../../services/jobs";
import { getSetting, getSettingsMap, setSetting } from "../../services/settings";
import { countUsers, createUser, UserError, userToDict } from "../../services/users";
import { HttpError, json, readJson, validateBody } from "../../util/http";
import { currentUser, requireSuperAdmin, type AppEnv } from "../context";

const DOMAIN_RE = /^[a-z0-9.-]+(:\d{1,5})?$/;

async function ensureNotCompleted(db: D1Database): Promise<void> {
  if (await getSetting(db, "setup_completed")) throw new HttpError(409, "Setup is already completed.");
}

async function advance(db: D1Database, step: number): Promise<void> {
  if (Number((await getSetting(db, "setup_step")) || 1) < step) await setSetting(db, "setup_step", step);
}

export function normalizePublicDomain(value: string): string {
  value = value.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").split("/")[0];
  if (!value || !DOMAIN_RE.test(value)) throw new HttpError(400, "Enter a domain like chat.example.com (no http:// or path).");
  return value;
}

/**
 * Choose the embedding model by name (shared with Settings → Embeddings). On Cloudflare the
 * Workers AI model is ready at once; Hugging Face models need the self-hosted version.
 */
export async function startEmbeddingJob(env: Env, modelName: string): Promise<Record<string, any>> {
  if (findOption("local", "workers_ai", modelName)) {
    const current = (await getSetting(env.DB, "embedding")) || {};
    if (!(current.status === "ready" && current.provider === "workers_ai" && current.model === modelName)) {
      try {
        await switchToWorkersAI(env, modelName);
      } catch (exc) {
        if (exc instanceof EmbeddingChoiceError) throw new HttpError(400, exc.message);
        throw exc;
      }
    }
    return { embedding: await embeddingView(env.DB), job: null };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(modelName)) throw new HttpError(400, "Enter a Hugging Face model id like BAAI/bge-m3.");
  // The current model stays active.
  throw new HttpError(400, LOCAL_EMBEDDINGS_MESSAGE);
}

export function registerSetup(app: Hono<AppEnv>): void {
  // ------------------------------------------------------------------ state
  app.get("/api/admin/setup/state", async (c) => {
    const db = c.env.DB;
    const user = await currentUser(c);
    const values = await getSettingsMap(db, ["setup_completed", "setup_step", "mode", "public_domain", "embedding", "default_model_id", "onprem_client_id"]);
    const model = values.default_model_id ? await getModel(db, values.default_model_id) : null;
    const client = values.onprem_client_id ? await getById(db, values.onprem_client_id) : null;
    const embedding = values.embedding || {};
    const job = embedding.job_id ? await jobService.getJob(db, embedding.job_id) : null;
    return json({
      completed: Boolean(values.setup_completed),
      step: Number(values.setup_step || 1),
      has_admin: (await countUsers(db)) > 0,
      user: user ? userToDict(user) : null,
      mode: values.mode,
      public_domain: values.public_domain,
      model: model ? await modelToDict(c.env.SECRET_KEY, model, values.default_model_id) : null,
      embedding: { model: embedding.model ?? null, dim: embedding.dim ?? null, status: embedding.status ?? null, error: embedding.error ?? null },
      embedding_job: job ? jobService.jobToDict(job) : null,
      client: client ? clientToDict(client) : null,
      providers: Object.values(PROVIDERS),
    });
  });

  // ------------------------------------------------------------------ step 1
  app.post("/api/admin/setup/admin", async (c) => {
    const db = c.env.DB;
    const body = validateBody(await readJson(c.req.raw), {
      name: { kind: "str", required: true, min_length: 1, max_length: 200 },
      email: { kind: "str", required: true, min_length: 3, max_length: 320 },
      password: { kind: "str", required: true, min_length: 1, max_length: 500 },
    });
    await ensureNotCompleted(db);
    if ((await countUsers(db)) > 0) throw new HttpError(409, "The admin account already exists. Please sign in.");
    if (!body.email.includes("@")) throw new HttpError(400, "Enter a valid email address.");
    let user;
    try {
      user = await createUser(db, body.name, body.email, body.password, "super_admin");
    } catch (exc) {
      if (exc instanceof UserError) throw new HttpError(400, exc.message);
      throw exc;
    }
    await advance(db, 2);
    return json({ user: userToDict(user) }, 200, { "Set-Cookie": await sessionCookie(c.env.SECRET_KEY, c.req.raw, user.id, user.session_version) });
  });

  // ------------------------------------------------------------------ steps 2-3
  app.post("/api/admin/setup/mode", async (c) => {
    await requireSuperAdmin(c);
    const body = validateBody(await readJson(c.req.raw), { mode: { kind: "str", required: true } });
    const db = c.env.DB;
    await ensureNotCompleted(db);
    if (body.mode !== "cloud" && body.mode !== "onprem") throw new HttpError(400, "Choose cloud or onprem.");
    await setSetting(db, "mode", body.mode);
    await advance(db, 3);
    return json({ mode: body.mode });
  });

  app.post("/api/admin/setup/domain", async (c) => {
    await requireSuperAdmin(c);
    const body = validateBody(await readJson(c.req.raw), { public_domain: { kind: "str", required: true } });
    const db = c.env.DB;
    await ensureNotCompleted(db);
    const domain = normalizePublicDomain(body.public_domain);
    await setSetting(db, "public_domain", domain);
    await advance(db, 4);
    return json({ public_domain: domain });
  });

  // ------------------------------------------------------------------ step 4
  app.post("/api/admin/setup/model/test", async (c) => {
    await requireSuperAdmin(c);
    const body = validateBody({ body: await readJson(c.req.raw) }, { body: { kind: "dict", required: true } }).body;
    await ensureNotCompleted(c.env.DB);
    let cfg;
    try {
      cfg = await configFromForm(c.env.SECRET_KEY, body);
    } catch (exc) {
      if (exc instanceof ModelError) throw new HttpError(400, exc.message);
      throw exc;
    }
    return json(await runTest(cfg));
  });

  app.post("/api/admin/setup/model/discover", async (c) => {
    await requireSuperAdmin(c);
    const body = validateBody({ body: await readJson(c.req.raw) }, { body: { kind: "dict", required: true } }).body;
    const db = c.env.DB;
    await ensureNotCompleted(db);
    const existingId = await getSetting(db, "default_model_id");
    const existing = existingId ? await getModel(db, existingId) : null;
    try {
      return json(await discoverModels(c.env.SECRET_KEY, body, existing));
    } catch (exc) {
      if (exc instanceof ModelError) throw new HttpError(400, exc.message);
      throw exc;
    }
  });

  /** Save the first model, but only after a successful live connection test. */
  app.post("/api/admin/setup/model", async (c) => {
    await requireSuperAdmin(c);
    const body = validateBody({ body: await readJson(c.req.raw) }, { body: { kind: "dict", required: true } }).body;
    const db = c.env.DB;
    await ensureNotCompleted(db);
    const existingId = await getSetting(db, "default_model_id");
    const existing = existingId ? await getModel(db, existingId) : null;
    let cfg;
    try {
      cfg = await configFromForm(c.env.SECRET_KEY, body, existing);
    } catch (exc) {
      if (exc instanceof ModelError) throw new HttpError(400, exc.message);
      throw exc;
    }
    const result = await runTest(cfg);
    if (!result.ok) throw new HttpError(400, `Connection test failed: ${result.error}`);
    let model;
    try {
      model = await saveModel(db, c.env.SECRET_KEY, body, existing);
    } catch (exc) {
      if (exc instanceof ModelError) throw new HttpError(400, exc.message);
      throw exc;
    }
    await setSetting(db, "default_model_id", model.id);
    await recordTest(db, model, true, result.reply || "");
    await advance(db, 5);
    model = (await getModel(db, model.id))!;
    return json({ model: await modelToDict(c.env.SECRET_KEY, model, model.id), test: result });
  });

  // ------------------------------------------------------------------ step 5
  app.post("/api/admin/setup/embedding", async (c) => {
    await requireSuperAdmin(c);
    const body = validateBody(await readJson(c.req.raw), { model: { kind: "str", required: true, min_length: 3, max_length: 200 } });
    await ensureNotCompleted(c.env.DB);
    return json(await startEmbeddingJob(c.env, body.model.trim()));
  });

  app.post("/api/admin/setup/embedding/continue", async (c) => {
    await requireSuperAdmin(c);
    const db = c.env.DB;
    await ensureNotCompleted(db);
    const embedding = (await getSetting(db, "embedding")) || {};
    if (!["ready", "downloading"].includes(embedding.status)) throw new HttpError(400, "Start the embedding model download first.");
    const nextStep = (await getSetting(db, "mode")) === "onprem" ? 6 : 7;
    await advance(db, nextStep);
    return json({ step: nextStep });
  });

  // ------------------------------------------------------------------ step 6
  app.post("/api/admin/setup/client", async (c) => {
    await requireSuperAdmin(c);
    const body = validateBody(await readJson(c.req.raw), {
      client_id: { kind: "str", required: true },
      name: { kind: "str", required: true },
      website_url: { kind: "str", default: "" },
      allowed_domains: { kind: "list_str", default: [] },
    });
    const db = c.env.DB;
    await ensureNotCompleted(db);
    if ((await getSetting(db, "mode")) !== "onprem") throw new HttpError(400, "This step is only for on-premise installs.");
    const existingId = await getSetting(db, "onprem_client_id");
    if (existingId && (await getById(db, existingId))) throw new HttpError(409, "The client was already created.");
    let client;
    try {
      client = await createClient(db, body.client_id, body.name, body.website_url, body.allowed_domains);
    } catch (exc) {
      if (exc instanceof ClientError) throw new HttpError(400, exc.message);
      throw exc;
    }
    await setSetting(db, "onprem_client_id", client.id);
    await advance(db, 7);
    return json({ client: clientToDict(client) });
  });

  // ------------------------------------------------------------------ step 7
  app.post("/api/admin/setup/finish", async (c) => {
    await requireSuperAdmin(c);
    const db = c.env.DB;
    await ensureNotCompleted(db);
    const values = await getSettingsMap(db, ["default_model_id", "embedding", "mode", "onprem_client_id"]);
    if (!values.default_model_id) throw new HttpError(400, "Add an AI model first.");
    if (!["ready", "downloading"].includes((values.embedding || {}).status)) throw new HttpError(400, "Start the embedding model download first.");
    if (values.mode === "onprem" && !values.onprem_client_id) throw new HttpError(400, "Create the client first.");
    await setSetting(db, "setup_completed", true);
    return json({ completed: true });
  });
}
