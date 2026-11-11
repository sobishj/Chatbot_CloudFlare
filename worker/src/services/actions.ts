/** API actions admin: connection settings, action definitions, templates and the audit log view. */

import { toAction, type Client, type ClientAction } from "../models";
import { ActionError, AUTH_TYPES, checkTarget, DEFAULT_TIMEOUT, LOCATIONS, METHODS, TYPES } from "../actions/executor";
import { decryptSecret, encryptSecret, maskSecret } from "../security/crypto";
import { all, first, nowIso, parseJson, run, toJson } from "../util/db";
import { UserFacingError } from "../util/http";

const NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MAX_ACTIONS = 50;
const MAX_PARAMETERS = 30;
const MAX_EXTRA_HEADERS = 20;

/** Invalid API settings or action definition; the message is safe to show in the UI. */
export class ActionConfigError extends UserFacingError {}

// ----------------------------------------------------------------------------- connection settings
/** API settings for the admin UI: the key is masked, never returned. */
export async function settingsView(secret: string, client: Client): Promise<Record<string, any>> {
  const s = client.api_settings || {};
  const key = s.api_key_encrypted ? await decryptSecret(secret, s.api_key_encrypted) : null;
  return {
    base_url: s.base_url || "",
    auth_type: s.auth_type || "header",
    auth_name: s.auth_name || "X-API-Key",
    api_key_masked: key ? maskSecret(key) : s.api_key_encrypted ? "••••" : "",
    has_api_key: Boolean(s.api_key_encrypted),
    api_key_unreadable: Boolean(s.api_key_encrypted) && key === null,
    timeout_seconds: Number(s.timeout_seconds || DEFAULT_TIMEOUT),
    extra_headers: { ...(s.extra_headers || {}) },
    health_path: s.health_path || "",
    openapi_url: s.openapi_url || "",
  };
}

/** Validate and store connection settings. An empty ``api_key`` keeps the stored key. */
export async function updateSettings(db: D1Database, secret: string, client: Client, data: Record<string, any>, allowPrivate: boolean): Promise<void> {
  const next: Record<string, any> = { ...(client.api_settings || {}) };
  if ("base_url" in data) {
    const baseUrl = String(data.base_url ?? "").trim().replace(/\/+$/, "");
    if (baseUrl) {
      if (baseUrl.length > 500) throw new ActionConfigError("The API URL is too long.");
      try {
        checkTarget(baseUrl, allowPrivate);
      } catch (exc) {
        if (exc instanceof ActionError) throw new ActionConfigError(exc.message);
        throw exc;
      }
    }
    next.base_url = baseUrl;
  }
  if ("auth_type" in data) {
    if (!AUTH_TYPES.includes(data.auth_type)) throw new ActionConfigError("Authentication must be header, bearer or query.");
    next.auth_type = data.auth_type;
  }
  if ("auth_name" in data) {
    const name = String(data.auth_name ?? "").trim() || "X-API-Key";
    if (!HEADER_RE.test(name)) throw new ActionConfigError("The header or parameter name may contain only letters, digits and - _ .");
    next.auth_name = name;
  }
  const key = String(data.api_key ?? "").trim();
  if (key) {
    if (key.length > 2000) throw new ActionConfigError("The API key is too long.");
    next.api_key_encrypted = await encryptSecret(secret, key);
  } else if (data.clear_api_key) {
    delete next.api_key_encrypted;
  }
  if ("timeout_seconds" in data) {
    const raw = data.timeout_seconds;
    const timeout = typeof raw === "number" ? Math.trunc(raw) : /^\s*[-+]?\d+\s*$/.test(String(raw)) ? Number(String(raw).trim()) : NaN;
    if (Number.isNaN(timeout) || typeof raw === "boolean") throw new ActionConfigError("Timeout must be a number of seconds.");
    if (!(timeout >= 1 && timeout <= 60)) throw new ActionConfigError("Timeout must be between 1 and 60 seconds.");
    next.timeout_seconds = timeout;
  }
  if ("extra_headers" in data) {
    const headers = data.extra_headers || {};
    if (typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > MAX_EXTRA_HEADERS) {
      throw new ActionConfigError(`Extra headers must be at most ${MAX_EXTRA_HEADERS} name/value pairs.`);
    }
    const clean: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(headers)) {
      const name = String(rawName).trim();
      const value = String(rawValue);
      if (!name) continue;
      if (!HEADER_RE.test(name) || ["host", "content-length", "transfer-encoding", "connection"].includes(name.toLowerCase())) throw new ActionConfigError(`Invalid header name: ${name}`);
      if (value.length > 500 || value.includes("\r") || value.includes("\n")) throw new ActionConfigError(`Invalid value for header ${name}.`);
      clean[name] = value;
    }
    next.extra_headers = clean;
  }
  if ("health_path" in data) {
    const path = String(data.health_path ?? "").trim();
    if (path && (!path.startsWith("/") || path.includes("://") || path.length > 300)) throw new ActionConfigError("The health check path must start with / (e.g. /health).");
    next.health_path = path;
  }
  const enabled = "enabled" in data ? (data.enabled ? 1 : 0) : client.api_actions_enabled ? 1 : 0;
  await run(db, "UPDATE clients SET api_settings = ?, api_actions_enabled = ? WHERE id = ?", toJson(next), enabled, client.id);
  client.api_settings = next;
  client.api_actions_enabled = Boolean(enabled);
}

// ----------------------------------------------------------------------------- actions
/** Clean fields for a client_actions row, or throw ActionConfigError. */
export async function validateAction(db: D1Database, client: Client, data: Record<string, any>, existing: ClientAction | null = null): Promise<Record<string, any>> {
  const name = String(data.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new ActionConfigError("Name must be snake_case: lower-case letters, digits and _ (e.g. get_slots).");
  const clash = await first<{ id: number }>(db, "SELECT id FROM client_actions WHERE client_id = ? AND name = ?", client.id, name);
  if (clash && (!existing || clash.id !== existing.id)) throw new ActionConfigError(`An action called ${name} already exists.`);
  const method = String(data.method || "GET").toUpperCase();
  if (!METHODS.includes(method)) throw new ActionConfigError(`Method must be one of ${METHODS.join(", ")}.`);
  const path = String(data.path ?? "").trim();
  if (!path.startsWith("/") || path.includes("://") || path.includes("..") || path.length > 500 || /\s/.test(path)) {
    throw new ActionConfigError("Path must start with / and be relative to the API URL, e.g. /doctors/{doctor_id}/slots.");
  }
  const description = String(data.description ?? "").trim();
  if (!description) throw new ActionConfigError("Describe when the assistant should use this action.");

  const rawParams = data.parameters || [];
  if (!Array.isArray(rawParams) || rawParams.length > MAX_PARAMETERS) throw new ActionConfigError(`An action can have at most ${MAX_PARAMETERS} parameters.`);
  const params: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const p of rawParams) {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new ActionConfigError("Invalid parameter.");
    const pname = String(p.name ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(pname)) throw new ActionConfigError(`Invalid parameter name: ${pname || "(empty)"}`);
    if (seen.has(pname)) throw new ActionConfigError(`Parameter ${pname} appears twice.`);
    seen.add(pname);
    const kind = p.type || "string";
    const location = p.location || "query";
    if (!TYPES.includes(kind)) throw new ActionConfigError(`Parameter ${pname}: type must be one of ${TYPES.join(", ")}.`);
    if (!LOCATIONS.includes(location)) throw new ActionConfigError(`Parameter ${pname}: location must be path, query or body.`);
    if (location === "body" && method === "GET") throw new ActionConfigError(`Parameter ${pname}: GET requests have no body; use query.`);
    const enumValues = p.enum || [];
    if (!Array.isArray(enumValues) || enumValues.length > 50) throw new ActionConfigError(`Parameter ${pname}: allowed values must be a list (at most 50).`);
    const clean: Record<string, any> = {
      name: pname,
      type: kind,
      location,
      required: Boolean(p.required) || location === "path",
      description: String(p.description ?? "").trim().slice(0, 300),
    };
    if (enumValues.length) clean.enum = enumValues.map((e: any) => String(e).trim().slice(0, 100)).filter((e: string) => e);
    params.push(clean);
  }
  const pathParams = new Set(params.filter((p) => p.location === "path").map((p) => p.name as string));
  const placeholders = new Set([...path.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
  const missing = [...placeholders].filter((x) => !pathParams.has(x)).sort();
  const extra = [...pathParams].filter((x) => !placeholders.has(x)).sort();
  if (missing.length || extra.length) {
    const detail = missing.length ? `declare ${missing.join(", ")} as path parameter(s)` : "add " + extra.map((n) => `{${n}}`).join(", ") + " to the path";
    throw new ActionConfigError(`Path placeholders and path parameters don't match: ${detail}.`);
  }
  return {
    name,
    description: description.slice(0, 1000),
    method,
    path,
    parameters: params,
    // Changing data always needs the visitor's confirmation; only GET may skip it.
    requires_confirmation: method !== "GET" ? true : Boolean(data.requires_confirmation ?? false),
    enabled: Boolean(data.enabled ?? true),
    response_hint: String(data.response_hint ?? "").trim().slice(0, 1000) || null,
  };
}

export async function saveAction(db: D1Database, client: Client, data: Record<string, any>, existing: ClientAction | null = null): Promise<void> {
  const f = await validateAction(db, client, data, existing);
  if (!existing) {
    const count = (await first<{ n: number }>(db, "SELECT count(*) AS n FROM client_actions WHERE client_id = ?", client.id))?.n ?? 0;
    if (count >= MAX_ACTIONS) throw new ActionConfigError(`A client can have at most ${MAX_ACTIONS} actions.`);
    await run(
      db,
      "INSERT INTO client_actions (client_id, name, description, method, path, parameters, requires_confirmation, enabled, response_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      client.id, f.name, f.description, f.method, f.path, toJson(f.parameters), f.requires_confirmation ? 1 : 0, f.enabled ? 1 : 0, f.response_hint, nowIso(), nowIso(),
    );
  } else {
    await run(
      db,
      "UPDATE client_actions SET name = ?, description = ?, method = ?, path = ?, parameters = ?, requires_confirmation = ?, enabled = ?, response_hint = ?, updated_at = ? WHERE id = ?",
      f.name, f.description, f.method, f.path, toJson(f.parameters), f.requires_confirmation ? 1 : 0, f.enabled ? 1 : 0, f.response_hint, nowIso(), existing.id,
    );
  }
}

export function actionToDict(action: ClientAction): Record<string, any> {
  return {
    id: action.id,
    name: action.name,
    description: action.description,
    method: action.method,
    path: action.path,
    parameters: action.parameters || [],
    requires_confirmation: action.requires_confirmation,
    enabled: action.enabled,
    response_hint: action.response_hint || "",
    updated_at: action.updated_at,
  };
}

export async function listActions(db: D1Database, client: Client): Promise<ClientAction[]> {
  return (await all(db, "SELECT * FROM client_actions WHERE client_id = ? ORDER BY name", client.id)).map(toAction);
}

// ----------------------------------------------------------------------------- template
function p(name: string, kind: string, location: string, description: string, required = true): Record<string, any> {
  return { name, type: kind, location, required, description };
}

// Matches demo/mock_booking_api.mjs; admins adjust paths and parameters to the client's real API.
export const APPOINTMENT_TEMPLATE: Record<string, any>[] = [
  {
    name: "list_departments", method: "GET", path: "/departments", parameters: [],
    description: "List the hospital's departments (e.g. Cardiology). Use when the visitor wants to book or asks which departments exist.",
    response_hint: "Each department has an id and a name.",
  },
  {
    name: "list_doctors", method: "GET", path: "/doctors",
    parameters: [p("department_id", "integer", "query", "Only doctors of this department.", false)],
    description: "List doctors, optionally for one department. Use to find the doctor the visitor wants.",
    response_hint: "Each doctor has an id, name and department_id.",
  },
  {
    name: "get_slots", method: "GET", path: "/slots",
    parameters: [p("doctor_id", "integer", "query", "The doctor's id from list_doctors."), p("date", "date", "query", "The day to check.")],
    description: "Get a doctor's free appointment times on a date. Always check before offering a time.",
    response_hint: "A list of free times like 09:30.",
  },
  {
    name: "book_appointment", method: "POST", path: "/appointments",
    parameters: [
      p("doctor_id", "integer", "body", "The doctor's id."),
      p("date", "date", "body", "Appointment date."),
      p("time", "string", "body", "A free time returned by get_slots, e.g. 09:30."),
      p("patient_name", "string", "body", "The patient's full name."),
      p("phone", "phone", "body", "The patient's phone number."),
    ],
    description: "Book an appointment once the visitor has chosen a doctor, date and free time and given name and phone.",
    response_hint: "Returns booking_id; tell the visitor the booking ID.",
  },
  {
    name: "cancel_appointment", method: "DELETE", path: "/appointments/{appointment_id}",
    parameters: [p("appointment_id", "string", "path", "The booking ID to cancel.")],
    description: "Cancel an existing appointment by its booking ID.",
    response_hint: "Confirms the cancellation.",
  },
];

/** Create the appointment-booking actions that don't exist yet; returns the names added. */
export async function addTemplate(db: D1Database, client: Client): Promise<string[]> {
  const existing = new Set((await listActions(db, client)).map((a) => a.name));
  const added: string[] = [];
  for (const template of APPOINTMENT_TEMPLATE) {
    if (existing.has(template.name)) continue;
    await saveAction(db, client, { ...template, enabled: true });
    added.push(template.name);
  }
  return added;
}

// ----------------------------------------------------------------------------- audit log
export async function listCalls(db: D1Database, client: Client, page = 1, size = 25): Promise<Record<string, any>> {
  size = Math.max(1, Math.min(size, 100));
  page = Math.max(1, page);
  const total = (await first<{ n: number }>(db, "SELECT count(*) AS n FROM action_calls WHERE client_id = ?", client.id))?.n ?? 0;
  const rows = await all(db, "SELECT * FROM action_calls WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", client.id, size, (page - 1) * size);
  return {
    total,
    page,
    size,
    calls: rows.map((c) => {
      const summary = parseJson<Record<string, any>>(c.request_summary, {});
      return {
        id: c.id, action: c.action_name, channel: c.channel, ok: Boolean(c.ok), status_code: c.status_code,
        error: c.error, response_ms: c.response_ms, params: summary.params ?? {},
        method: summary.method ?? null, path: summary.path ?? null,
        question_id: c.question_id, created_at: c.created_at,
      };
    }),
  };
}
