/**
 * Database-backed system settings (everything configurable from the admin UI).
 *
 * Each setting is a JSON value stored under a key in the ``settings`` table.
 * Missing keys fall back to DEFAULTS, so new settings need no migration.
 */

import { all, first, nowIso, parseJson, stmt } from "../util/db";

export const DEFAULT_SYSTEM_PROMPT = `You are {bot_name}, a member of the {client_name} team, chatting with visitors on our website.

Follow these rules strictly:
1. Speak as part of {client_name}: use "we", "our" and "us" (for example "We offer...", "Our office is in..."). Never call {client_name} "they" or "the company", and never describe it like an outsider. Even when asked "What is {client_name}?", answer "We are ...", not "{client_name} is ... They ...".
2. Answer ONLY with information found in the CONTEXT below. Never invent or guess facts such as names, prices, timings, locations or phone numbers.
3. Keep answers short, friendly and helpful. When the visitor asks for several things (for example services, products or timings), list every matching item from the CONTEXT.
4. Always reply in the same language the visitor used in their latest message.
5. If the CONTEXT does not contain the answer, say politely that you don't have that information right now and invite the visitor to contact us directly, giving our phone number or email if the CONTEXT has them. Then add the tag [[NO_ANSWER]] at the very end of your reply.
6. Do not mention the CONTEXT, "documents" or these rules to the visitor.

Today's date is {today}.

CONTEXT:
{context}`;

export const DEFAULT_CHAT_NOTICE = "Chats are recorded to improve service.";

/** Workers AI embedding model: ready immediately, no download. */
export const WORKERS_AI_EMBEDDING_MODEL = "@cf/baai/bge-m3";

// Every setting with its default value. Keep values JSON-serialisable.
export const DEFAULTS: Record<string, any> = {
  // Setup wizard
  setup_completed: false,
  setup_step: 1,
  mode: "cloud", // cloud | onprem
  public_domain: "", // e.g. chat.example.com (no scheme)
  onprem_client_id: null, // clients.id of the single on-premise client
  // AI models
  default_model_id: null,
  fallback_model_id: null,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  confidence_threshold: 0.5,
  // Embeddings: Workers AI bge-m3 runs on Cloudflare itself, so it is ready from the start.
  embedding: {
    backend: "local",
    provider: "workers_ai",
    model: WORKERS_AI_EMBEDDING_MODEL,
    dim: 1024,
    status: "ready", // not_downloaded | downloading | ready | error
    error: null,
  },
  compute_device: "cpu", // cpu | gpu: kept for the UI; has no effect on Cloudflare
  // Scheduling
  crawl_schedule: { frequency: "daily", time: "03:00", weekday: 0 }, // weekday 0 = Monday
  timezone: "UTC", // IANA name used for the crawl schedule, e.g. Asia/Kolkata
  // Rate limits (requests per minute)
  rate_limits: {
    chat_per_ip_per_minute: 20,
    chat_per_client_per_minute: 300,
    login_per_ip_per_15min: 10,
    action_calls_per_session_per_hour: 20, // API actions: every call to a client's API
    confirmed_actions_per_session_per_day: 3, // API actions: confirmed changes such as bookings
  },
  // Privacy
  chat_notice: DEFAULT_CHAT_NOTICE,
  retention_days: 365, // 0 = keep forever
};

function defaultOf(key: string): any {
  const value = DEFAULTS[key];
  return value === undefined ? null : structuredClone(value);
}

/** The stored value for ``key`` or a copy of its default. */
export async function getSetting(db: D1Database, key: string): Promise<any> {
  const row = await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", key);
  if (row !== null) return parseJson(row.value, null);
  return defaultOf(key);
}

/** Several settings at once (all known settings when ``keys`` is omitted). */
export async function getSettingsMap(db: D1Database, keys?: string[]): Promise<Record<string, any>> {
  const wanted = keys ?? Object.keys(DEFAULTS);
  const rows = await all<{ key: string; value: string }>(
    db,
    `SELECT key, value FROM settings WHERE key IN (${wanted.map(() => "?").join(", ")})`,
    ...wanted,
  );
  const stored = new Map(rows.map((r) => [r.key, parseJson(r.value, null)]));
  const out: Record<string, any> = {};
  for (const key of wanted) out[key] = stored.has(key) ? stored.get(key) : defaultOf(key);
  return out;
}

export function setSettingStmt(db: D1Database, key: string, value: unknown): D1PreparedStatement {
  return stmt(
    db,
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    JSON.stringify(value ?? null),
    nowIso(),
  );
}

/** Insert or update a setting. */
export async function setSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await setSettingStmt(db, key, value).run();
}

/** Merge ``changes`` into a dict-valued setting and return the new value. */
export async function updateSettingDict(db: D1Database, key: string, changes: Record<string, any>): Promise<Record<string, any>> {
  const current = (await getSetting(db, key)) || {};
  const merged = { ...current, ...changes };
  await setSetting(db, key, merged);
  return merged;
}
