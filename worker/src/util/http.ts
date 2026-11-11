/** HTTP errors and small request helpers shared by every route. */

/** Like FastAPI's HTTPException: turned into {"detail": ...} with this status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
    public headers: Record<string, string> = {},
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

/** A validation error with a message safe to show in the UI (ClientError, ModelError, UserError, ...): 400. */
export class UserFacingError extends Error {}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${value}`];
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${opts.maxAge}`);
    parts.push(`Expires=${new Date(Date.now() + opts.maxAge * 1000).toUTCString()}`);
  }
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
  return parts.join("; ");
}

/** The visitor's IP address as Cloudflare saw it. */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// ----------------------------------------------------------------------------- body validation
// Request bodies were pydantic models in the Python version. These helpers return the same
// 422 shape ({"detail": [{"loc", "msg", "type"}]}) the admin UI already knows how to show.
export interface FieldIssue {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export function validationError(issues: FieldIssue[]): HttpError {
  return new HttpError(422, issues);
}

export async function readJson(request: Request): Promise<any> {
  const text = await request.text();
  if (!text.trim()) throw validationError([{ loc: ["body"], msg: "Field required", type: "missing" }]);
  try {
    return JSON.parse(text);
  } catch {
    throw validationError([{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }]);
  }
}

type Kind = "str" | "int" | "float" | "bool" | "list_str" | "list_int" | "dict" | "any";

export interface FieldSpec {
  kind: Kind;
  required?: boolean;
  nullable?: boolean;
  min_length?: number;
  max_length?: number;
  pattern?: RegExp;
  ge?: number;
  le?: number;
  default?: unknown;
}

/** Validate a JSON object against simple field specs (the subset of pydantic the routes used). */
export function validateBody(body: any, spec: Record<string, FieldSpec>): Record<string, any> {
  const issues: FieldIssue[] = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw validationError([{ loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", type: "model_attributes_type" }]);
  }
  const out: Record<string, any> = {};
  for (const [name, f] of Object.entries(spec)) {
    let value = body[name];
    if (value === undefined) {
      if (f.required) issues.push({ loc: ["body", name], msg: "Field required", type: "missing" });
      else out[name] = f.default === undefined ? null : structuredClone(f.default);
      continue;
    }
    if (value === null) {
      if (f.nullable || (!f.required && f.default === null)) {
        out[name] = null;
        continue;
      }
      if (f.kind !== "any") {
        issues.push({ loc: ["body", name], msg: nullMessage(f.kind), type: `${f.kind}_type` });
        continue;
      }
    }
    const loc = ["body", name];
    switch (f.kind) {
      case "str":
        if (typeof value !== "string") {
          issues.push({ loc, msg: "Input should be a valid string", type: "string_type" });
          continue;
        }
        if (f.min_length !== undefined && [...value].length < f.min_length) {
          issues.push({ loc, msg: `String should have at least ${f.min_length} character${f.min_length === 1 ? "" : "s"}`, type: "string_too_short" });
          continue;
        }
        if (f.max_length !== undefined && [...value].length > f.max_length) {
          issues.push({ loc, msg: `String should have at most ${f.max_length} characters`, type: "string_too_long" });
          continue;
        }
        if (f.pattern && !f.pattern.test(value)) {
          issues.push({ loc, msg: `String should match pattern '${f.pattern.source}'`, type: "string_pattern_mismatch" });
          continue;
        }
        break;
      case "int": {
        const n = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
        if (typeof n !== "number" || !Number.isInteger(n) || typeof value === "boolean") {
          issues.push({ loc, msg: "Input should be a valid integer", type: "int_type" });
          continue;
        }
        value = n;
        if (f.ge !== undefined && value < f.ge) {
          issues.push({ loc, msg: `Input should be greater than or equal to ${f.ge}`, type: "greater_than_equal" });
          continue;
        }
        if (f.le !== undefined && value > f.le) {
          issues.push({ loc, msg: `Input should be less than or equal to ${f.le}`, type: "less_than_equal" });
          continue;
        }
        break;
      }
      case "float": {
        const n = typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)) ? Number(value) : value;
        if (typeof n !== "number" || typeof value === "boolean") {
          issues.push({ loc, msg: "Input should be a valid number", type: "float_type" });
          continue;
        }
        value = n;
        break;
      }
      case "bool":
        if (typeof value !== "boolean") {
          if (value === 0 || value === 1) value = Boolean(value);
          else if (typeof value === "string" && ["true", "false", "yes", "no", "1", "0", "on", "off"].includes(value.toLowerCase())) {
            value = ["true", "yes", "1", "on"].includes(value.toLowerCase());
          } else {
            issues.push({ loc, msg: "Input should be a valid boolean", type: "bool_type" });
            continue;
          }
        }
        break;
      case "list_str":
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          issues.push({ loc, msg: "Input should be a valid list", type: "list_type" });
          continue;
        }
        if (f.max_length !== undefined && value.length > f.max_length) {
          issues.push({ loc, msg: `List should have at most ${f.max_length} items after validation, not ${value.length}`, type: "too_long" });
          continue;
        }
        break;
      case "list_int":
        if (!Array.isArray(value) || value.some((v) => !Number.isInteger(typeof v === "string" ? Number(v) : v))) {
          issues.push({ loc, msg: "Input should be a valid list", type: "list_type" });
          continue;
        }
        value = value.map((v: any) => Number(v));
        break;
      case "dict":
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          issues.push({ loc, msg: "Input should be a valid dictionary", type: "dict_type" });
          continue;
        }
        break;
      case "any":
        break;
    }
    out[name] = value;
  }
  if (issues.length) throw validationError(issues);
  return out;
}

function nullMessage(kind: Kind): string {
  return {
    str: "Input should be a valid string",
    int: "Input should be a valid integer",
    float: "Input should be a valid number",
    bool: "Input should be a valid boolean",
    list_str: "Input should be a valid list",
    list_int: "Input should be a valid list",
    dict: "Input should be a valid dictionary",
    any: "",
  }[kind];
}

/** Query-string integer like FastAPI's Query(default, ge=, le=): 422 when out of range. */
export function queryInt(url: URL, name: string, def: number, ge?: number, le?: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return def;
  if (!/^-?\d+$/.test(raw.trim())) throw validationError([{ loc: ["query", name], msg: "Input should be a valid integer, unable to parse string as an integer", type: "int_parsing" }]);
  const n = Number(raw);
  if (ge !== undefined && n < ge) throw validationError([{ loc: ["query", name], msg: `Input should be greater than or equal to ${ge}`, type: "greater_than_equal" }]);
  if (le !== undefined && n > le) throw validationError([{ loc: ["query", name], msg: `Input should be less than or equal to ${le}`, type: "less_than_equal" }]);
  return n;
}

export function queryPattern(url: URL, name: string, def: string, pattern: RegExp): string {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  if (!pattern.test(raw)) throw validationError([{ loc: ["query", name], msg: `String should match pattern '${pattern.source}'`, type: "string_pattern_mismatch" }]);
  return raw;
}

export function queryBool(url: URL, name: string, def = false): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw validationError([{ loc: ["query", name], msg: "Input should be a valid boolean, unable to interpret input", type: "bool_parsing" }]);
}
