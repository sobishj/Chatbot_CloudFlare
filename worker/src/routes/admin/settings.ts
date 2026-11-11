/** Settings (super admin): prompt, threshold, schedule, rate limits, domain, privacy, embeddings. */

import type { Hono } from "hono";
import { ClientError, switchMode } from "../../services/clients";
import { EmbeddingChoiceError, embeddingView, optionsView, switchToApi } from "../../services/embeddings";
import { ageSeconds, HEARTBEAT_STALE_SECONDS } from "../../services/health";
import * as jobService from "../../services/jobs";
import { DEFAULT_SYSTEM_PROMPT, DEFAULTS, getSettingsMap, setSetting } from "../../services/settings";
import { all } from "../../util/db";
import { HttpError, json, readJson, validateBody } from "../../util/http";
import { requireSetupCompleted, requireSuperAdmin, type AppEnv, type C } from "../context";
import { normalizePublicDomain, startEmbeddingJob } from "./setup";

const EDITABLE = ["system_prompt", "confidence_threshold", "crawl_schedule", "timezone", "rate_limits", "public_domain", "chat_notice", "retention_days", "compute_device"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COMPUTE_DEVICES = ["cpu", "gpu"]; // saved for the UI; nothing runs on a local CPU/GPU on Cloudflare

async function view(c: C): Promise<Record<string, any>> {
  const db = c.env.DB;
  const values = await getSettingsMap(db, [...EDITABLE, "mode", "embedding", "worker_heartbeat"]);
  values.clients = (await all(db, "SELECT client_id, name FROM clients ORDER BY id")).map((r) => ({ client_id: r.client_id, name: r.name }));
  values.rate_limits = { ...DEFAULTS.rate_limits, ...(values.rate_limits || {}) }; // limits added in later versions
  const heartbeat = values.worker_heartbeat || {};
  delete values.worker_heartbeat;
  const age = ageSeconds(heartbeat);
  // What the worker (where indexing runs) reported in its last heartbeat: no GPU on Cloudflare.
  values.worker_hardware = { online: age !== null && age < HEARTBEAT_STALE_SECONDS, gpu: heartbeat.gpu ?? null, device: heartbeat.device ?? null };
  const embedding = values.embedding || {};
  delete values.embedding;
  const job = embedding.job_id ? await jobService.getJob(db, embedding.job_id) : null;
  values.embedding = await embeddingView(db);
  values.embedding_options = await optionsView(db);
  values.embedding_job = job ? jobService.jobToDict(job) : null;
  values.default_system_prompt = DEFAULT_SYSTEM_PROMPT;
  return values;
}

function bad(msg: string): HttpError {
  return new HttpError(400, msg);
}

function toFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v.trim())) : typeof v === "number" ? v : NaN;
  if (Number.isNaN(n)) throw new TypeError("invalid float");
  return n;
}

function toInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v)) return Number(v.trim());
  throw new TypeError("invalid int");
}

export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return Boolean(value);
  } catch {
    return false;
  }
}

/** Validate one setting; throws HttpError(400) with a readable message. */
function validate(key: string, value: any): any {
  if (key === "system_prompt") {
    const v = String(value ?? "").trim();
    if (v.length < 20) throw bad("The system prompt is too short.");
    return v.slice(0, 20000);
  }
  if (key === "confidence_threshold") {
    const v = toFloat(value);
    if (!(v >= 0 && v <= 1)) throw bad("Confidence threshold must be between 0 and 1.");
    return v;
  }
  if (key === "crawl_schedule") {
    if (value === null || typeof value !== "object") throw new TypeError("not a dict");
    const freq = value.frequency;
    if (!["daily", "weekly", "off"].includes(freq)) throw bad("Crawl frequency must be daily, weekly or off.");
    const time = String(value.time ?? "03:00");
    if (!TIME_RE.test(time)) throw bad("Time must be HH:MM (24-hour).");
    const weekday = toInt(value.weekday ?? 0);
    if (!(weekday >= 0 && weekday <= 6)) throw bad("Invalid weekday.");
    return { frequency: freq, time, weekday };
  }
  if (key === "timezone") {
    if (!validTimeZone(String(value))) throw bad("Unknown time zone. Use a name like Asia/Kolkata or UTC.");
    return String(value);
  }
  if (key === "rate_limits") {
    if (value === null || typeof value !== "object") throw new TypeError("not a dict");
    const out: Record<string, number> = { ...DEFAULTS.rate_limits };
    for (const k of Object.keys(out)) {
      if (k in value) {
        const n = toInt(value[k]);
        if (n < 0 || n > 100000) throw bad("Rate limits must be between 0 (off) and 100000.");
        out[k] = n;
      }
    }
    return out;
  }
  if (key === "public_domain") return normalizePublicDomain(String(value));
  if (key === "chat_notice") return String(value ?? "").trim().slice(0, 500);
  if (key === "compute_device") {
    if (!COMPUTE_DEVICES.includes(value)) throw bad("Compute device must be cpu or gpu.");
    return value;
  }
  if (key === "retention_days") {
    const v = toInt(value);
    if (v < 0 || v > 3650) throw bad("Retention must be between 0 (keep forever) and 3650 days.");
    return v;
  }
  throw bad(`Unknown setting: ${key}`);
}

async function guard(c: C): Promise<void> {
  await requireSetupCompleted(c);
  await requireSuperAdmin(c);
}

export function registerSettings(app: Hono<AppEnv>): void {
  app.get("/api/admin/settings", async (c) => {
    await guard(c);
    return json(await view(c));
  });

  app.put("/api/admin/settings", async (c) => {
    await guard(c);
    const body = validateBody({ body: await readJson(c.req.raw) }, { body: { kind: "dict", required: true } }).body;
    for (const [key, value] of Object.entries(body)) {
      if (!EDITABLE.includes(key)) throw new HttpError(400, `Setting '${key}' cannot be changed here.`);
      let clean;
      try {
        clean = validate(key, value);
      } catch (exc) {
        if (exc instanceof HttpError) throw exc;
        throw new HttpError(400, `Invalid value for ${key}.`);
      }
      await setSetting(c.env.DB, key, clean);
    }
    return json(await view(c));
  });

  app.post("/api/admin/settings/system-prompt/reset", async (c) => {
    await guard(c);
    await setSetting(c.env.DB, "system_prompt", DEFAULT_SYSTEM_PROMPT);
    return json(await view(c));
  });

  /** Switch between multi-client (cloud) and single-client (on-premise) mode. */
  app.post("/api/admin/settings/mode", async (c) => {
    await guard(c);
    const body = validateBody(await readJson(c.req.raw), { mode: { kind: "str", required: true } });
    try {
      await switchMode(c.env.DB, body.mode);
    } catch (exc) {
      if (exc instanceof ClientError) throw new HttpError(400, exc.message);
      throw exc;
    }
    return json(await view(c));
  });

  /**
   * Switch the embedding model: Workers AI and cloud models are verified with one call. Local models
   * need the self-hosted version (400; the current model stays). All content is re-indexed automatically.
   */
  app.post("/api/admin/settings/embedding", async (c) => {
    await guard(c);
    const body = validateBody(await readJson(c.req.raw), {
      model: { kind: "str", required: true },
      backend: { kind: "str", default: "local" },
      provider: { kind: "str", default: null },
      api_key: { kind: "str", default: null },
    });
    if (body.backend === "api") {
      try {
        await switchToApi(c.env, body.provider || "", body.model, body.api_key);
      } catch (exc) {
        if (exc instanceof EmbeddingChoiceError) throw new HttpError(400, exc.message);
        throw exc;
      }
    } else {
      await startEmbeddingJob(c.env, body.model.trim());
    }
    return json(await view(c));
  });
}
