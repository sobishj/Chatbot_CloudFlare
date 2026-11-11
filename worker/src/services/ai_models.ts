/** Saved AI models: CRUD, connection tests and per-client model resolution. */

import { toModel, type AIModelRow, type Client } from "../models";
import { decryptSecret, encryptSecret, maskSecret } from "../security/crypto";
import { all, first, nowIso, run } from "../util/db";
import { UserFacingError } from "../util/http";
import { configFromRow, LLMError, listAvailableModels, modelConfig, testConnection, type ModelConfig } from "../llm/client";
import { getProvider, isLoopbackUrl, PROVIDERS } from "../llm/providers";
import { getSetting, setSetting } from "./settings";

/** Validation error with a message safe to show in the UI. */
export class ModelError extends UserFacingError {}

const EDITABLE_FIELDS = ["name", "provider", "base_url", "model_name", "temperature", "max_tokens", "timeout_seconds", "cost_input_per_m", "cost_output_per_m"] as const;

function pyFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  if (v === null || v === undefined || (typeof v === "string" && !v.trim()) || !Number.isFinite(n)) {
    throw new ModelError(`could not convert string to float: '${String(v)}'`);
  }
  return n;
}

function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v)) return Number(v.trim());
  throw new ModelError(`invalid literal for int() with base 10: '${String(v)}'`);
}

export function validateFields(data: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  if ("provider" in data) {
    try {
      getProvider(String(data.provider));
    } catch (exc) {
      throw new ModelError((exc as Error).message);
    }
    clean.provider = String(data.provider);
  }
  for (const key of ["name", "model_name"]) {
    if (key in data) {
      const value = String(data[key] ?? "").trim();
      if (!value) throw new ModelError(`${key === "name" ? "Display name" : "Model name"} is required.`);
      clean[key] = [...value].slice(0, 300).join("");
    }
  }
  if ("base_url" in data) {
    const value = String(data.base_url ?? "").trim();
    if (value && !(value.startsWith("http://") || value.startsWith("https://"))) throw new ModelError("Base URL must start with http:// or https://");
    clean.base_url = value || null;
  }
  if ("temperature" in data) clean.temperature = Math.max(0.0, Math.min(2.0, pyFloat(data.temperature)));
  if ("max_tokens" in data) clean.max_tokens = Math.max(16, Math.min(32000, pyInt(data.max_tokens)));
  if ("timeout_seconds" in data) clean.timeout_seconds = Math.max(5, Math.min(600, pyInt(data.timeout_seconds)));
  for (const key of ["cost_input_per_m", "cost_output_per_m"]) {
    if (key in data) {
      const v = data[key];
      clean[key] = v === null || v === "" ? null : Math.max(0.0, pyFloat(v));
    }
  }
  return clean;
}

export async function getModel(db: D1Database, id: number | null | undefined): Promise<AIModelRow | null> {
  if (id === null || id === undefined) return null;
  const row = await first(db, "SELECT * FROM ai_models WHERE id = ?", id);
  return row ? toModel(row) : null;
}

export async function listModels(db: D1Database): Promise<AIModelRow[]> {
  return (await all(db, "SELECT * FROM ai_models ORDER BY name COLLATE NOCASE")).map(toModel);
}

export async function rowConfig(secret: string, row: AIModelRow): Promise<ModelConfig> {
  return configFromRow(row, row.api_key_encrypted ? await decryptSecret(secret, row.api_key_encrypted) : null);
}

/** Build a call config from form data, reusing the stored key when the field is left blank. */
export async function configFromForm(secret: string, data: Record<string, any>, existing: AIModelRow | null = null): Promise<ModelConfig> {
  const fields = validateFields(data);
  const merged: Record<string, any> = {};
  if (existing) for (const k of EDITABLE_FIELDS) merged[k] = existing[k];
  Object.assign(merged, fields);
  let apiKey: string | null = String(data.api_key ?? "").trim() || null;
  if (apiKey === null && existing?.api_key_encrypted) apiKey = await decryptSecret(secret, existing.api_key_encrypted);
  if (!merged.provider || !merged.model_name) throw new ModelError("Provider and model name are required.");
  return modelConfig({
    provider: merged.provider,
    model_name: merged.model_name,
    base_url: merged.base_url ?? null,
    api_key: apiKey,
    temperature: merged.temperature ?? 0.2,
    max_tokens: merged.max_tokens ?? 600,
    timeout_seconds: merged.timeout_seconds ?? 60,
    cost_input_per_m: merged.cost_input_per_m ?? null,
    cost_output_per_m: merged.cost_output_per_m ?? null,
    model_id: existing ? existing.id : null,
    display_name: merged.name || merged.model_name,
  });
}

export async function saveModel(db: D1Database, secret: string, data: Record<string, any>, existing: AIModelRow | null = null): Promise<AIModelRow> {
  const fields = validateFields(data);
  const model: Record<string, any> = existing ? { ...existing } : { temperature: 0.2, max_tokens: 600, timeout_seconds: 60, cost_input_per_m: null, cost_output_per_m: null, base_url: null, api_key_encrypted: null };
  Object.assign(model, fields);
  if (!model.name || !model.provider || !model.model_name) throw new ModelError("Display name, provider and model name are required.");
  const apiKey = String(data.api_key ?? "").trim();
  if (apiKey) model.api_key_encrypted = await encryptSecret(secret, apiKey);
  else if (data.clear_api_key) model.api_key_encrypted = null;
  const values = [model.name, model.provider, model.base_url ?? null, model.model_name, model.api_key_encrypted ?? null, model.temperature, model.max_tokens, model.timeout_seconds, model.cost_input_per_m ?? null, model.cost_output_per_m ?? null];
  let id: number;
  if (existing) {
    await run(
      db,
      "UPDATE ai_models SET name = ?, provider = ?, base_url = ?, model_name = ?, api_key_encrypted = ?, temperature = ?, max_tokens = ?, timeout_seconds = ?, cost_input_per_m = ?, cost_output_per_m = ?, updated_at = ? WHERE id = ?",
      ...values,
      nowIso(),
      existing.id,
    );
    id = existing.id;
  } else {
    const row = await first<{ id: number }>(
      db,
      "INSERT INTO ai_models (name, provider, base_url, model_name, api_key_encrypted, temperature, max_tokens, timeout_seconds, cost_input_per_m, cost_output_per_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      ...values,
    );
    id = row!.id;
  }
  // The first saved model becomes the default automatically.
  if ((await getSetting(db, "default_model_id")) === null) await setSetting(db, "default_model_id", id);
  return (await getModel(db, id))!;
}

export async function deleteModel(db: D1Database, model: AIModelRow): Promise<void> {
  await setPriority(db, (await modelPriority(db)).filter((i) => i !== model.id));
  await run(db, "DELETE FROM ai_models WHERE id = ?", model.id);
}

// ----------------------------------------------------------------------------- priority
/**
 * Saved model ids in the order chat tries them: the default first, then the priority list,
 * then the fallback (older setups and the setup wizard only set default and fallback).
 */
export async function modelPriority(db: D1Database): Promise<number[]> {
  const rows = await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings WHERE key IN ('default_model_id', 'fallback_model_id', 'model_priority')");
  const v = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  const order = [v.default_model_id ?? null, ...((v.model_priority as number[] | null) || []), v.fallback_model_id ?? null];
  const existing = new Set((await all<{ id: number }>(db, "SELECT id FROM ai_models")).map((r) => r.id));
  return [...new Set(order.filter((i): i is number => i !== null && existing.has(i)))];
}

/** Store the order; the first model is the default and the second the fallback (kept for older screens). */
export async function setPriority(db: D1Database, modelIds: number[]): Promise<number[]> {
  const existing = new Set((await all<{ id: number }>(db, "SELECT id FROM ai_models")).map((r) => r.id));
  const order = [...new Set(modelIds.map(Number).filter((i) => existing.has(i)))];
  await setSetting(db, "model_priority", order);
  await setSetting(db, "default_model_id", order.length ? order[0] : null);
  await setSetting(db, "fallback_model_id", order.length > 1 ? order[1] : null);
  return order;
}

/** Models to try for a client, in order: its own model (if set), then the priority list. */
export async function resolveChain(db: D1Database, secret: string, client: Client): Promise<ModelConfig[]> {
  const ids = [...new Set([...(client.ai_model_id ? [client.ai_model_id] : []), ...(await modelPriority(db))])];
  if (!ids.length) return [];
  const rows = await all(db, `SELECT * FROM ai_models WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids);
  const byId = new Map(rows.map((r) => [r.id as number, toModel(r)]));
  const out: ModelConfig[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(await rowConfig(secret, row));
  }
  return out;
}

export async function recordTest(db: D1Database, model: AIModelRow, ok: boolean, message: string): Promise<void> {
  await run(db, "UPDATE ai_models SET last_test_ok = ?, last_test_at = ?, last_test_message = ? WHERE id = ?", ok ? 1 : 0, nowIso(), [...message].slice(0, 1000).join(""), model.id);
}

/** Run a connection test and return a UI-friendly result. */
export async function runTest(cfg: ModelConfig): Promise<Record<string, any>> {
  try {
    const result = await testConnection(cfg);
    return { ok: true, reply: result.text, response_ms: result.response_ms, input_tokens: result.input_tokens, output_tokens: result.output_tokens };
  } catch (exc) {
    if (exc instanceof LLMError) return { ok: false, error: exc.message };
    throw exc;
  }
}

/** List the models the form's provider/URL/key can use; the model name may still be empty. */
export async function discoverModels(secret: string, data: Record<string, any>, existing: AIModelRow | null = null): Promise<Record<string, any>> {
  const provider = String(data.provider || existing?.provider || "");
  try {
    getProvider(provider);
  } catch (exc) {
    throw new ModelError((exc as Error).message);
  }
  const baseUrl = String(data.base_url ?? "").trim() || null;
  let apiKey: string | null = String(data.api_key ?? "").trim() || null;
  if (apiKey === null && existing?.api_key_encrypted) apiKey = await decryptSecret(secret, existing.api_key_encrypted);
  try {
    const models = await listAvailableModels(provider, baseUrl, apiKey, 15, !data.refresh);
    return { ok: true, models };
  } catch (exc) {
    if (exc instanceof LLMError) return { ok: false, error: exc.message };
    throw exc;
  }
}

export async function modelToDict(secret: string, model: AIModelRow, defaultId: number | null = null, fallbackId: number | null = null): Promise<Record<string, any>> {
  const provider = PROVIDERS[model.provider];
  const key = model.api_key_encrypted ? await decryptSecret(secret, model.api_key_encrypted) : null;
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    provider_label: provider ? provider.label : model.provider,
    cloud: provider ? provider.cloud : true,
    base_url: model.base_url,
    model_name: model.model_name,
    api_key_masked: maskSecret(key),
    has_api_key: Boolean(model.api_key_encrypted),
    api_key_unreadable: Boolean(model.api_key_encrypted) && key === null,
    temperature: model.temperature,
    max_tokens: model.max_tokens,
    timeout_seconds: model.timeout_seconds,
    cost_input_per_m: model.cost_input_per_m,
    cost_output_per_m: model.cost_output_per_m,
    is_default: model.id === defaultId,
    is_fallback: model.id === fallbackId,
    loopback_warning: isLoopbackUrl(model.base_url),
    last_test_ok: model.last_test_ok,
    last_test_at: model.last_test_at,
    last_test_message: model.last_test_message,
  };
}
