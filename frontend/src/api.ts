// Small fetch wrapper for the admin API: JSON in/out, CSRF header, readable errors.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)wa_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** Shown instead of the browser's "Failed to fetch" when the server can't be reached. */
export const OFFLINE_MESSAGE = "Sorry, couldn't connect to the server. Please check your connection and try again.";

/** fetch() that turns network failures (server down, no internet) into a readable ApiError. */
async function request(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
}

type Listener = (status: number, detail: string) => void;
const listeners: Listener[] = [];
/** Global hook: the auth layer listens for 401/409 to redirect to login or setup. */
export function onApiError(fn: Listener): () => void {
  listeners.push(fn);
  return () => listeners.splice(listeners.indexOf(fn), 1);
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const method = options.method ?? (options.body !== undefined || options.form ? "POST" : "GET");
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken();
  const resp = await request(path, { method, headers, body, credentials: "same-origin" });
  if (!resp.ok) {
    let detail = resp.statusText || "Request failed";
    try {
      const data = await resp.json();
      if (typeof data.detail === "string") detail = data.detail;
      else if (Array.isArray(data.detail)) detail = data.detail.map((d: any) => `${(d.loc || []).slice(-1)[0] ?? ""}: ${d.msg}`).join("; ");
    } catch {
      /* not JSON */
    }
    listeners.forEach((fn) => fn(resp.status, detail));
    throw new ApiError(resp.status, detail);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

/** Make sure the CSRF cookie exists before the first POST (e.g. on a fresh login page). */
export async function primeCsrf(): Promise<void> {
  if (!csrfToken()) await fetch("/health", { credentials: "same-origin" }).catch(() => undefined);
}

// ---------------------------------------------------------------- shared types
export interface User {
  id: number;
  name: string;
  email: string;
  role: "super_admin" | "client_admin";
  active: boolean;
  last_login_at: string | null;
  created_at: string;
  clients: { id: number; client_id: string; name: string }[];
}

export interface Provider {
  key: string;
  label: string;
  litellm_prefix: string;
  default_base_url: string;
  cloud: boolean;
  needs_api_key: boolean;
  example_model: string;
  openai_compatible: boolean;
}

export interface AIModel {
  id: number;
  name: string;
  provider: string;
  provider_label: string;
  cloud: boolean;
  base_url: string | null;
  model_name: string;
  api_key_masked: string;
  has_api_key: boolean;
  api_key_unreadable: boolean;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  cost_input_per_m: number | null;
  cost_output_per_m: number | null;
  is_default: boolean;
  is_fallback: boolean;
  loopback_warning: boolean;
  last_test_ok: boolean | null;
  last_test_at: string | null;
  last_test_message: string | null;
}

export interface Job {
  id: number;
  type: string;
  type_label: string;
  client_id: string | null;
  client_name: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  progress_text: string | null;
  result: Record<string, any> | null;
  error: string | null;
  cancel_requested: boolean;
  triggered_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  log?: string;
}

export interface Branding {
  widget_enabled: boolean;
  bot_name: string;
  primary_color: string;
  greeting: string;
  default_language: string;
  position: "left" | "right";
  powered_by: boolean;
  powered_by_text: string;
  powered_by_url: string;
  logo_file: string | null;
  width_pct: number;
  height_pct: number;
  mobile_width_pct: number;
  mobile_height_pct: number;
  timezone: string;
  contact_details: string;
}

export interface Client {
  id: number;
  client_id: string;
  name: string;
  website_url: string | null;
  allowed_domains: string[];
  active: boolean;
  ai_model_id: number | null;
  ai_model_name: string | null;
  effective_model_name?: string | null;
  last_crawl_at: string | null;
  created_at: string;
  branding: Branding;
  crawl_settings: { max_pages: number; delay_seconds: number; include_patterns: string[]; exclude_patterns: string[]; extraction?: string };
  document_settings: { watch_path: string | null; scan_interval_minutes: number; last_scan_at: string | null };
  api_actions_enabled: boolean;
  pages: number;
  documents: number;
  chunks: number;
  questions_30d: number;
  active_jobs?: Job[];
  recent_jobs?: Job[];
  logo_url?: string | null;
  can_edit_settings?: boolean;
  mode?: string;
}

export interface Stats {
  days: number;
  total: number;
  answered: number;
  unanswered: number;
  unanswered_rate: number;
  avg_response_ms: number;
  tokens: { input: number; output: number; cost: number };
  per_day: { date: string; total: number; unanswered: number }[];
  top_questions: { question: string; normalized: string; count: number; unanswered: number }[];
  unanswered_questions: { id: number; question: string; created_at: string; top_score: number | null }[];
  languages: { language: string; count: number }[];
  models: { model: string; count: number; input_tokens: number; output_tokens: number; cost: number; fallbacks: number }[];
}

/** POST and read a server-sent-event stream: calls onEvent for each `data:` JSON event. */
export async function apiStream(path: string, body: unknown, onEvent: (event: any) => void): Promise<void> {
  const resp = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!resp.ok || !resp.body) {
    let detail = resp.statusText || "Request failed";
    try {
      const data = await resp.json();
      if (typeof data.detail === "string") detail = data.detail;
    } catch {
      /* not JSON */
    }
    listeners.forEach((fn) => fn(resp.status, detail));
    throw new ApiError(resp.status, detail);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (raw: string) => {
    if (!raw.startsWith("data:")) return;
    try {
      onEvent(JSON.parse(raw.slice(5)));
    } catch {
      /* incomplete or invalid event */
    }
  };
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new ApiError(0, OFFLINE_MESSAGE); // connection dropped mid-answer
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    parts.forEach(handle);
  }
  buffer += decoder.decode();
  if (buffer) handle(buffer);
}
