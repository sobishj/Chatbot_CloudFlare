/**
 * Read a client's OpenAPI (3.x) or Swagger (2.0) spec and turn its endpoints into action drafts.
 *
 * The admin picks endpoints from the list; each becomes a normal action (validated like a
 * hand-made one), so nothing the admin didn't choose is ever callable by the assistant.
 */

import { load as yamlLoad } from "js-yaml";
import type { Client } from "../models";
import { urljoin, urlparse } from "../util/pyurl";
import { ActionError, buildRequest, checkTarget, send } from "./executor";

// Where APIs usually publish their spec (tried relative to the API URL, then to the host root).
const CANDIDATE_PATHS = ["/openapi.json", "/swagger.json", "/v3/api-docs", "/swagger/v1/swagger.json", "/api-docs", "/openapi.yaml", "/swagger.yaml"];
export const MAX_SPEC_BYTES = 5_000_000;
const METHODS = ["get", "post", "put", "patch", "delete"];
const VERBS: Record<string, string> = { GET: "get", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };
const NAME_OK = /^[a-z][a-z0-9_]{1,62}$/;
const PARAM_OK = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The spec can't be found or read; the message is safe to show in the UI. */
export class SpecError extends Error {}

// ----------------------------------------------------------------------------- loading
/** JSON or YAML text → object. */
export function parseText(text: string): Record<string, any> {
  text = text.trim();
  if (!text) throw new SpecError("The spec is empty.");
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    try {
      data = yamlLoad(text);
    } catch {
      throw new SpecError("This is neither valid JSON nor YAML.");
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !("openapi" in data || "swagger" in data) || !data.paths || typeof data.paths !== "object" || Array.isArray(data.paths)) {
    throw new SpecError("This isn't an OpenAPI or Swagger spec (no 'openapi'/'swagger' version and 'paths').");
  }
  return data;
}

/** The client's auth headers/query for fetching the spec from its own API (the key never leaves the server). */
async function auth(secret: string, client: Client): Promise<[Record<string, string>, Record<string, any>]> {
  try {
    const built = await buildRequest(secret, client, { method: "GET", path: "", parameters: [] }, {});
    return [built.headers, built.query];
  } catch (exc) {
    if (exc instanceof ActionError) return [{ Accept: "application/json" }, {}];
    throw exc;
  }
}

/**
 * Download the spec (with the client's API authentication); returns [spec, url used].
 *
 * ``specUrl`` may be absolute or a path relative to the API URL. Without it, the usual
 * locations are tried. Every URL passes the same SSRF check as action calls.
 */
export async function fetchSpec(secret: string, client: Client, specUrl: string | null, allowPrivate: boolean): Promise<[Record<string, any>, string]> {
  const base = String((client.api_settings || {}).base_url || "").replace(/\/+$/, "");
  let candidates: string[];
  if (specUrl) {
    specUrl = specUrl.trim();
    candidates = [urlparse(specUrl).scheme ? specUrl : base + "/" + specUrl.replace(/^\/+/, "")];
  } else {
    if (!base) throw new SpecError("Save the API URL first.");
    const p = urlparse(base);
    const root = `${p.scheme}://${p.netloc}`;
    candidates = [...CANDIDATE_PATHS.map((x) => base + x), ...(root !== base ? CANDIDATE_PATHS.map((x) => root + x) : [])];
  }
  const errors: string[] = [];
  for (const url of [...new Set(candidates)]) {
    try {
      checkTarget(url, allowPrivate);
    } catch (exc) {
      if (exc instanceof ActionError) throw new SpecError(exc.message);
      throw exc;
    }
    // The API key is only sent to the client's own API host, never to another site.
    const sameHost = Boolean(base) && urlparse(url).netloc === urlparse(base).netloc;
    const [headers, query] = sameHost ? await auth(secret, client) : [{ Accept: "application/json" }, {}];
    const [resp, error] = await send(client, "GET", url, headers, query, null, allowPrivate);
    if (resp === null) {
      errors.push(`${url}: ${error}`);
      continue;
    }
    if (resp.status !== 200) {
      errors.push(`${url}: HTTP ${resp.status}`);
      continue;
    }
    if (resp.bytes > MAX_SPEC_BYTES) throw new SpecError("The spec is larger than 5 MB.");
    try {
      return [parseText(resp.text), url];
    } catch (exc) {
      if (exc instanceof SpecError) errors.push(`${url}: ${exc.message}`);
      else throw exc;
    }
  }
  if (specUrl) throw new SpecError(`Could not load the spec. ${errors[0] ?? ""}`.trim());
  throw new SpecError("No spec found at the usual addresses (/openapi.json, /swagger.json, /v3/api-docs …). Enter its URL or upload the file.");
}

// ----------------------------------------------------------------------------- parsing
const isObj = (v: any): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Follow local $refs (#/components/... or #/definitions/...). */
function resolve(spec: Record<string, any>, node: any, depth = 0): any {
  while (isObj(node) && "$ref" in node && depth < 20) {
    const ref = node.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return {};
    let target: any = spec;
    for (let part of ref.slice(2).split("/")) {
      part = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = isObj(target) ? target[part] : undefined;
      if (target === undefined || target === null) return {};
    }
    node = target;
    depth++;
  }
  return node;
}

/** Resolve refs and optional-wrappers (anyOf/oneOf with null, single allOf). */
function unwrap(spec: Record<string, any>, schema: any): Record<string, any> {
  schema = resolve(spec, schema) || {};
  if (!isObj(schema)) return {};
  for (const key of ["anyOf", "oneOf"]) {
    const options = (Array.isArray(schema[key]) ? schema[key] : []).filter((o: any) => resolve(spec, o)?.type !== "null");
    if (options.length === 1 && key in schema) {
      const merged = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== key && (k === "description" || k === "title")));
      return { ...unwrap(spec, options[0]), ...merged };
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    return { ...unwrap(spec, schema.allOf[0]), ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "allOf")) };
  }
  return schema;
}

/** Our parameter type for a JSON schema, or null if it can't be a single value. */
function paramType(name: string, schema: Record<string, any>): string | null {
  let kind = schema.type;
  if (Array.isArray(kind)) kind = kind.find((k: any) => k !== "null") ?? null;
  const fmt = String(schema.format ?? "");
  const lowered = name.toLowerCase();
  if (kind === "array" || kind === "object" || ((kind === undefined || kind === null) && ("properties" in schema || "items" in schema))) return null;
  if (kind === "integer") return "integer";
  if (kind === "number") return "number";
  if (kind === "boolean") return "boolean";
  if (fmt === "date" || fmt === "date-time") return "date";
  if (fmt === "email" || lowered.endsWith("email")) return "email";
  if (["phone", "mobile", "msisdn"].some((w) => lowered.includes(w))) return "phone";
  return "string";
}

function snake(text: string): string {
  text = text.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** operationId when it reads well; otherwise verb + path words (get_slots, delete_appointments_by_id). */
export function suggestName(method: string, path: string, operationId: string | null | undefined): string {
  if (operationId) {
    const name = snake(operationId);
    // FastAPI-style generated ids (book_appointments_post) read badly: derive a name instead.
    if (NAME_OK.test(name) && !name.endsWith("_" + method.toLowerCase())) return name.slice(0, 63);
  }
  const words: string[] = [];
  for (const segment of path.replace(/^\/+|\/+$/g, "").split("/")) {
    if (!segment) continue;
    const placeholder = /^\{(.+)\}$/.exec(segment);
    words.push(placeholder ? "by_" + snake(placeholder[1]) : snake(segment));
  }
  let name = [VERBS[method], ...words.filter(Boolean)].join("_") || VERBS[method];
  if (!/^[a-zA-Z]/.test(name)) name = "op_" + name;
  return name.slice(0, 63).replace(/_+$/, "");
}

/** Every operation as an action draft plus notes about what couldn't be imported. */
export function endpoints(spec: Record<string, any>, authName = "X-API-Key", baseUrl = ""): Record<string, any>[] {
  const prefix = serverPrefix(spec, baseUrl);
  const out: Record<string, any>[] = [];
  const used = new Set<string>();
  for (const [rawPath, rawItem] of Object.entries(spec.paths || {})) {
    const item = resolve(spec, rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      out.push(operation(spec, method.toUpperCase(), prefix + rawPath, op, shared, authName, used));
    }
  }
  return out;
}

/** Path prefix from servers[0] (3.x) or basePath (2.0) that the API URL doesn't already include. */
function serverPrefix(spec: Record<string, any>, baseUrl: string): string {
  let serverPath: string;
  if ("swagger" in spec) {
    serverPath = String(spec.basePath ?? "");
  } else {
    const servers = Array.isArray(spec.servers) ? spec.servers : [];
    const url = servers.length && isObj(servers[0]) ? String(servers[0].url ?? "") : "";
    serverPath = url ? urlparse(urljoin("http://x/", url)).path : "";
  }
  serverPath = serverPath.replace(/\/+$/, "");
  if (!serverPath || serverPath === "/") return "";
  return urlparse(baseUrl).path.replace(/\/+$/, "").endsWith(serverPath) ? "" : serverPath;
}

function operation(spec: Record<string, any>, method: string, path: string, op: Record<string, any>, shared: any[], authName: string, used: Set<string>): Record<string, any> {
  const notes: string[] = [];
  const params: Record<string, any>[] = [];
  let importable = true;
  const merged = new Map<string, Record<string, any>>();
  for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
    // operation-level parameters override path-level ones
    const p = resolve(spec, raw);
    if (isObj(p) && p.name) merged.set(`${p.name}\u0000${p.in ?? ""}`, p);
  }
  for (const [key, p] of merged) {
    const [name, where] = key.split("\u0000");
    const required = Boolean(p.required) || where === "path";
    if (where === "header" || where === "cookie") {
      if ([authName.toLowerCase(), "authorization"].includes(name.toLowerCase())) continue; // the connection's authentication covers it
      notes.push(`${where} parameter ${name} is not supported`);
      importable = importable && !required;
      continue;
    }
    if (where === "body") {
      // Swagger 2.0 JSON body
      importable = bodyFields(spec, p.schema, Boolean(p.required), params, notes) && importable;
      continue;
    }
    const location = ({ query: "query", path: "path", formData: "body" } as Record<string, string>)[where] ?? null;
    const schema = unwrap(spec, p.schema ?? Object.fromEntries(Object.entries(p).filter(([k]) => ["type", "format", "enum", "items"].includes(k))));
    const kind = paramType(name, schema);
    if (location === null || kind === null || !PARAM_OK.test(name)) {
      notes.push(`parameter ${name} (${where}) can't be imported`);
      importable = importable && !required;
      continue;
    }
    params.push(param(name, kind, location, required, p.description || schema.description || schema.title, schema));
  }

  let body = op.requestBody;
  if (body) {
    body = resolve(spec, body);
    const content = isObj(body.content) ? body.content : {};
    const media = content["application/json"] ?? Object.entries(content).find(([k]) => k.includes("json"))?.[1] ?? null;
    if (media === null) {
      notes.push("request body is not JSON");
      importable = importable && !body.required;
    } else {
      importable = bodyFields(spec, media.schema, Boolean(body.required), params, notes) && importable;
    }
  }

  const summary = String(op.summary ?? "").trim();
  const detail = String(op.description ?? "").trim();
  let description = [summary, detail].filter(Boolean).map((x) => x.replace(/\.+$/, "")).join(". ");
  if (description.length < 40) description = description ? `${description} (${method} ${path})` : `${method} ${path}`; // e.g. FastAPI's "Book": give the model the endpoint too
  let name = suggestName(method, path, op.operationId);
  const base = name;
  let n = 2;
  while (used.has(name)) {
    name = `${base.slice(0, 60)}_${n}`;
    n++;
  }
  used.add(name);
  if (op.deprecated) notes.push("deprecated in the spec");
  const placeholders = new Set([...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]));
  const pathParams = new Set(params.filter((p) => p.location === "path").map((p) => p.name));
  if ([...placeholders].some((p) => !pathParams.has(p))) {
    notes.push("path has placeholders without a usable parameter");
    importable = false;
  }
  return {
    key: `${method} ${path}`,
    method,
    path,
    summary,
    importable,
    notes,
    action: {
      name,
      description: description.slice(0, 1000),
      method,
      path,
      parameters: params,
      requires_confirmation: method !== "GET",
      enabled: true,
      response_hint: "",
    },
  };
}

/** Top-level fields of a JSON object body become body parameters. Returns false if a required field can't. */
function bodyFields(spec: Record<string, any>, schemaIn: any, requiredBody: boolean, params: Record<string, any>[], notes: string[]): boolean {
  const schema = unwrap(spec, schemaIn);
  const properties = schema.properties;
  if (!isObj(properties)) {
    notes.push("request body is not a plain JSON object");
    return !requiredBody;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let ok = true;
  for (const [name, raw] of Object.entries(properties)) {
    const prop = unwrap(spec, raw);
    if (prop.readOnly) continue;
    const kind = paramType(name, prop);
    if (kind === null || !PARAM_OK.test(name)) {
      notes.push(`body field ${name} (list or nested object) can't be imported`);
      ok = ok && !required.has(name);
      continue;
    }
    params.push(param(name, kind, "body", required.has(name), prop.description || prop.title, prop));
  }
  return ok;
}

function param(name: string, kind: string, location: string, required: boolean, description: unknown, schema: Record<string, any>): Record<string, any> {
  const p: Record<string, any> = { name, type: kind, location, required, description: String(description ?? "").trim().slice(0, 300) };
  const e = schema.enum;
  if (Array.isArray(e) && e.length && e.every((x) => typeof x === "string" || (typeof x === "number" && typeof x !== "boolean"))) p.enum = e.map(String).slice(0, 50);
  return p;
}
