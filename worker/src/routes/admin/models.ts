/** Settings → AI Models: add/edit/delete models, test connections, priority (default + fallback). */

import type { Hono } from "hono";
import type { AIModelRow } from "../../models";
import { PROVIDERS } from "../../llm/providers";
import {
  configFromForm,
  deleteModel,
  discoverModels,
  getModel,
  listModels,
  ModelError,
  modelPriority,
  modelToDict,
  recordTest,
  rowConfig,
  runTest,
  saveModel,
  setPriority,
} from "../../services/ai_models";
import { getSettingsMap } from "../../services/settings";
import { HttpError, json, readJson, validateBody } from "../../util/http";
import { requireSetupCompleted, requireSuperAdmin, type AppEnv, type C } from "../context";

async function guard(c: C): Promise<void> {
  await requireSetupCompleted(c);
  await requireSuperAdmin(c);
}

async function getOr404(db: D1Database, id: number): Promise<AIModelRow> {
  const model = await getModel(db, id);
  if (!model) throw new HttpError(404, "Model not found.");
  return model;
}

export async function modelsListing(c: C): Promise<Record<string, any>> {
  const db = c.env.DB;
  const values = await getSettingsMap(db, ["default_model_id", "fallback_model_id", "mode"]);
  const models = [];
  for (const m of await listModels(db)) models.push(await modelToDict(c.env.SECRET_KEY, m, values.default_model_id, values.fallback_model_id));
  return {
    models,
    providers: Object.values(PROVIDERS),
    default_model_id: values.default_model_id,
    fallback_model_id: values.fallback_model_id,
    priority: await modelPriority(db),
    mode: values.mode,
  };
}

async function dictBody(c: C): Promise<Record<string, any>> {
  return validateBody({ body: await readJson(c.req.raw) }, { body: { kind: "dict", required: true } }).body;
}

function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((exc) => {
    if (exc instanceof ModelError) throw new HttpError(400, exc.message);
    throw exc;
  });
}

export function registerModels(app: Hono<AppEnv>): void {
  app.get("/api/admin/models", async (c) => {
    await guard(c);
    return json(await modelsListing(c));
  });

  app.post("/api/admin/models", async (c) => {
    await guard(c);
    const body = await dictBody(c);
    const model = await asBadRequest(() => saveModel(c.env.DB, c.env.SECRET_KEY, body));
    return json({ model: await modelToDict(c.env.SECRET_KEY, model), ...(await modelsListing(c)) });
  });

  /** The order chat tries models in: the first answers; if it fails (busy, rate-limited, down), the next. */
  app.put("/api/admin/models/priority", async (c) => {
    await guard(c);
    const body = validateBody(await readJson(c.req.raw), { model_ids: { kind: "list_int", required: true } });
    if (!body.model_ids.length) throw new HttpError(400, "Keep at least one model in the list.");
    for (const id of body.model_ids) await getOr404(c.env.DB, id);
    await setPriority(c.env.DB, body.model_ids);
    return json(await modelsListing(c));
  });

  /** Test the values currently in the form (before saving). */
  app.post("/api/admin/models/test", async (c) => {
    await guard(c);
    const body = validateBody(await readJson(c.req.raw), { model_id: { kind: "int", default: null }, config: { kind: "dict", required: true } });
    const existing = body.model_id ? await getOr404(c.env.DB, body.model_id) : null;
    const cfg = await asBadRequest(() => configFromForm(c.env.SECRET_KEY, body.config, existing));
    return json(await runTest(cfg));
  });

  /** List the models the form's provider, base URL and API key can use. */
  app.post("/api/admin/models/discover", async (c) => {
    await guard(c);
    const body = validateBody(await readJson(c.req.raw), { model_id: { kind: "int", default: null }, config: { kind: "dict", required: true } });
    const existing = body.model_id ? await getOr404(c.env.DB, body.model_id) : null;
    return json(await asBadRequest(() => discoverModels(c.env.SECRET_KEY, body.config, existing)));
  });

  app.post("/api/admin/models/fallback", async (c) => {
    await guard(c);
    const body = validateBody(await readJson(c.req.raw), { model_id: { kind: "int", required: true, nullable: true } });
    if (body.model_id !== null) await getOr404(c.env.DB, body.model_id);
    const order = await modelPriority(c.env.DB);
    const rest = order.slice(1).filter((i) => i !== body.model_id);
    await setPriority(c.env.DB, [...order.slice(0, 1), ...(body.model_id ? [body.model_id] : []), ...rest]);
    return json(await modelsListing(c));
  });

  app.put("/api/admin/models/:model_id{[0-9]+}", async (c) => {
    await guard(c);
    const model = await getOr404(c.env.DB, Number(c.req.param("model_id")));
    const body = await dictBody(c);
    await asBadRequest(() => saveModel(c.env.DB, c.env.SECRET_KEY, body, model));
    return json(await modelsListing(c));
  });

  app.delete("/api/admin/models/:model_id{[0-9]+}", async (c) => {
    await guard(c);
    await deleteModel(c.env.DB, await getOr404(c.env.DB, Number(c.req.param("model_id"))));
    return json(await modelsListing(c));
  });

  app.post("/api/admin/models/:model_id{[0-9]+}/test", async (c) => {
    await guard(c);
    const model = await getOr404(c.env.DB, Number(c.req.param("model_id")));
    const result = await runTest(await rowConfig(c.env.SECRET_KEY, model));
    await recordTest(c.env.DB, model, result.ok, result.reply || result.error || "");
    return json(result);
  });

  /** Move the model to the top of the priority list. */
  app.post("/api/admin/models/:model_id{[0-9]+}/default", async (c) => {
    await guard(c);
    const id = Number(c.req.param("model_id"));
    await getOr404(c.env.DB, id);
    await setPriority(c.env.DB, [id, ...(await modelPriority(c.env.DB))]);
    return json(await modelsListing(c));
  });
}
