/** Client (tenant) management: validation, defaults, allowed origins, public config. */

import { toClient, type Client } from "../models";
import { all, first, inList, toJson } from "../util/db";
import { UserFacingError } from "../util/http";
import { hostnameOf, portOf, urlparse } from "../util/pyurl";
import { getSetting, setSetting } from "./settings";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_BRANDING: Record<string, any> = {
  widget_enabled: true, // off: no chat bubble on the website and the public chat API refuses messages
  bot_name: "Assistant",
  primary_color: "#1f5f5b",
  greeting: "Hi! How can I help you today?",
  default_language: "en",
  position: "right", // right | left
  powered_by: true,
  powered_by_text: "Powered by Website Assistant",
  powered_by_url: "",
  logo_file: null, // file name of the logo in R2 (clients/<slug>/branding/)
};

export const DEFAULT_CRAWL_SETTINGS: Record<string, any> = {
  max_pages: 500,
  delay_seconds: 1.0,
  include_patterns: [], // e.g. ["/stores/*"]; empty = everything
  exclude_patterns: [], // e.g. ["/careers/*", "*?print=*"]
};

export const DEFAULT_DOCUMENT_SETTINGS: Record<string, any> = {
  watch_path: null, // watched folders need the self-hosted version
  scan_interval_minutes: 60,
  last_scan_at: null,
  // Always given to the assistant (opening hours, address, contact …), whatever search finds.
  key_facts: "",
};

/** Validation error with a message safe to show in the UI. */
export class ClientError extends UserFacingError {}

// ----------------------------------------------------------------------------- validation
export function validateSlug(slug: string): string {
  slug = slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new ClientError("Client ID may contain lowercase letters, digits and hyphens (max 64 characters).");
  return slug;
}

export function normalizeUrl(url: string): string {
  url = url.trim();
  if (!url) return "";
  if (!url.includes("://")) url = "https://" + url;
  const parsed = urlparse(url);
  if (!["http", "https"].includes(parsed.scheme) || !hostnameOf(parsed.netloc)) {
    throw new ClientError("Enter a valid website URL, e.g. https://www.example.com");
  }
  return url;
}

/** Turn user input ('https://www.Example.com/path', '*.example.com', 'localhost:5500') into a pattern. */
export function normalizeDomain(value: string): string {
  value = value.trim().toLowerCase();
  if (!value) throw new ClientError("Empty domain.");
  const wildcard = value.startsWith("*.");
  if (wildcard) value = value.slice(2);
  if (!value.includes("://")) value = "http://" + value;
  const parsed = urlparse(value);
  const host = hostnameOf(parsed.netloc);
  if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new ClientError(`Invalid domain: ${value}`);
  let port: number | null;
  try {
    port = portOf(parsed.netloc);
  } catch {
    throw new ClientError(`Invalid domain: ${value}`);
  }
  const result = host + (port ? `:${port}` : "");
  return wildcard ? "*." + result : result;
}

export function normalizeDomains(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v && v.trim()) {
      const d = normalizeDomain(v);
      if (!out.includes(d)) out.push(d);
    }
  }
  return out;
}

/**
 * Check a browser ``Origin`` header against a client's allowed domains.
 *
 * ``example.com`` also allows ``www.example.com`` (and vice versa); ``*.example.com``
 * allows any subdomain. A pattern with a port must match the port exactly.
 */
export function originAllowed(origin: string | null | undefined, allowedDomains: string[]): boolean {
  if (!origin || origin === "null") return false;
  const parsed = urlparse(origin);
  const host = (hostnameOf(parsed.netloc) || "").toLowerCase();
  if (!host || !["http", "https"].includes(parsed.scheme)) return false;
  let port: number | null;
  try {
    port = portOf(parsed.netloc);
  } catch {
    return false;
  }
  const noWww = (s: string) => (s.startsWith("www.") ? s.slice(4) : s);
  for (let pattern of allowedDomains) {
    pattern = pattern.toLowerCase();
    if (pattern.includes(":")) {
      const k = pattern.lastIndexOf(":");
      const portS = pattern.slice(k + 1);
      pattern = pattern.slice(0, k);
      const pPort = /^\d+$/.test(portS) ? Number(portS) : null;
      if (pPort !== port) continue;
    }
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      if (host === base || host.endsWith("." + base)) return true;
    } else if (host === pattern || noWww(host) === noWww(pattern)) {
      return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------- CRUD
export async function getBySlug(db: D1Database, slug: string): Promise<Client | null> {
  const row = await first(db, "SELECT * FROM clients WHERE client_id = ?", slug);
  return row ? toClient(row) : null;
}

export async function getById(db: D1Database, id: number | null | undefined): Promise<Client | null> {
  if (id === null || id === undefined) return null;
  const row = await first(db, "SELECT * FROM clients WHERE id = ?", id);
  return row ? toClient(row) : null;
}

export async function createClient(db: D1Database, slug: string, name: string, websiteUrl: string, allowedDomains: string[] = []): Promise<Client> {
  slug = validateSlug(slug);
  if (await getBySlug(db, slug)) throw new ClientError("A client with this ID already exists.");
  if (!name.trim()) throw new ClientError("Name is required.");
  websiteUrl = normalizeUrl(websiteUrl);
  let domains = normalizeDomains(allowedDomains || []);
  if (!domains.length && websiteUrl) domains = [normalizeDomain(websiteUrl)];
  const row = await first(
    db,
    "INSERT INTO clients (client_id, name, website_url, allowed_domains, branding, crawl_settings, document_settings, active) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING *",
    slug,
    name.trim(),
    websiteUrl || null,
    toJson(domains),
    toJson({ ...DEFAULT_BRANDING, bot_name: `${name.trim()} Assistant` }),
    toJson({ ...DEFAULT_CRAWL_SETTINGS }),
    toJson({ ...DEFAULT_DOCUMENT_SETTINGS }),
  );
  return toClient(row!);
}

export function branding(client: Client): Record<string, any> {
  return { ...DEFAULT_BRANDING, ...(client.branding || {}) };
}

export function crawlSettings(client: Client): Record<string, any> {
  return { ...DEFAULT_CRAWL_SETTINGS, ...(client.crawl_settings || {}) };
}

export function documentSettings(client: Client): Record<string, any> {
  return { ...DEFAULT_DOCUMENT_SETTINGS, ...(client.document_settings || {}) };
}

export function validateBranding(changes: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  for (let [key, value] of Object.entries(changes)) {
    if (!(key in DEFAULT_BRANDING) || key === "logo_file") continue;
    if (key === "primary_color") {
      if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) throw new ClientError("Colour must be a hex value like #1f5f5b.");
    } else if (key === "position") {
      if (value !== "left" && value !== "right") throw new ClientError("Position must be left or right.");
    } else if (key === "powered_by" || key === "widget_enabled") {
      value = Boolean(value);
    } else if (key === "powered_by_url") {
      value = value ? normalizeUrl(String(value)) : "";
    } else {
      value = [...String(value ?? "").trim()].slice(0, 500).join("");
    }
    clean[key] = value;
  }
  return clean;
}

function pyInt(v: unknown): number {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (!Number.isFinite(n) || (typeof v === "string" && !/^[-+]?\d+$/.test(v.trim()))) throw new TypeError("invalid int");
  return Math.trunc(n);
}

function pyFloat(v: unknown): number {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  if (!Number.isFinite(n)) throw new TypeError("invalid float");
  return n;
}

export function validateCrawlSettings(changes: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  if ("max_pages" in changes) clean.max_pages = Math.max(1, Math.min(20000, pyInt(changes.max_pages)));
  if ("delay_seconds" in changes) clean.delay_seconds = Math.max(0.0, Math.min(60.0, pyFloat(changes.delay_seconds)));
  for (const key of ["include_patterns", "exclude_patterns"]) {
    if (key in changes) {
      let items = changes[key];
      if (typeof items === "string") items = items.split(/\r\n|\r|\n/);
      clean[key] = (items as unknown[]).map((p) => String(p).trim()).filter(Boolean).slice(0, 100);
    }
  }
  return clean;
}

/** R2 key prefix for a client's uploads and branding files. */
export function clientPrefix(slug: string): string {
  return `clients/${validateSlug(slug)}/`;
}

// ----------------------------------------------------------------------------- views
/** Pages / documents / chunks / questions (last ``days``) per client id. */
export async function clientCounts(db: D1Database, clientIds: number[] | null, days = 30): Promise<Map<number, Record<string, number>>> {
  const counts = new Map<number, Record<string, number>>();
  const where = clientIds === null ? { sql: "", params: [] as unknown[] } : (() => {
    const l = inList(clientIds);
    return { sql: ` AND client_id IN ${l.sql}`, params: l.params };
  })();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const statements = [
    db.prepare(`SELECT client_id, count(*) AS n FROM pages WHERE 1=1${where.sql} GROUP BY client_id`).bind(...where.params),
    db.prepare(`SELECT client_id, count(*) AS n FROM documents WHERE 1=1${where.sql} GROUP BY client_id`).bind(...where.params),
    db.prepare(`SELECT client_id, count(*) AS n FROM chunks WHERE pending = 0${where.sql} GROUP BY client_id`).bind(...where.params),
    db.prepare(`SELECT client_id, count(*) AS n FROM questions WHERE created_at >= ?${where.sql} GROUP BY client_id`).bind(since, ...where.params),
  ];
  const labels = ["pages", "documents", "chunks", "questions_30d"];
  const results = await db.batch<{ client_id: number; n: number }>(statements);
  results.forEach((res, i) => {
    for (const r of res.results ?? []) {
      const entry = counts.get(r.client_id) ?? {};
      entry[labels[i]] = r.n;
      counts.set(r.client_id, entry);
    }
  });
  return counts;
}

export function clientToDict(client: Client, counts: Record<string, number> = {}, aiModelName: string | null = null): Record<string, any> {
  return {
    id: client.id,
    client_id: client.client_id,
    name: client.name,
    website_url: client.website_url,
    allowed_domains: client.allowed_domains,
    active: client.active,
    ai_model_id: client.ai_model_id,
    ai_model_name: aiModelName,
    last_crawl_at: client.last_crawl_at,
    created_at: client.created_at,
    branding: branding(client),
    crawl_settings: crawlSettings(client),
    document_settings: documentSettings(client),
    api_actions_enabled: client.api_actions_enabled,
    pages: counts.pages ?? 0,
    documents: counts.documents ?? 0,
    chunks: counts.chunks ?? 0,
    questions_30d: counts.questions_30d ?? 0,
  };
}

/** Name of the client's own AI model (clients.ai_model_id), or null. */
export async function modelNames(db: D1Database): Promise<Map<number, string>> {
  const rows = await all<{ id: number; name: string }>(db, "SELECT id, name FROM ai_models");
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Branding for the widget. Contains NO secrets or internal settings. */
export function publicConfig(client: Client, chatNotice: string, logoUrl: string | null): Record<string, any> {
  const b = branding(client);
  return {
    client_id: client.client_id,
    name: client.name,
    bot_name: b.bot_name,
    primary_color: b.primary_color,
    greeting: b.greeting,
    default_language: b.default_language,
    position: b.position,
    logo_url: logoUrl,
    notice: chatNotice,
    powered_by: b.powered_by,
    powered_by_text: b.powered_by ? b.powered_by_text : "",
    powered_by_url: b.powered_by ? b.powered_by_url : "",
  };
}

// ----------------------------------------------------------------------------- mode
export const MODES = ["cloud", "onprem"];

/**
 * Switch between cloud (many clients) and on-premise (one client).
 *
 * No client data changes. Going on-premise requires at most one client: the remaining
 * client becomes the on-premise assistant. Other clients are never deleted or hidden
 * implicitly; the admin has to remove them first.
 */
export async function switchMode(db: D1Database, mode: string): Promise<void> {
  if (!MODES.includes(mode)) throw new ClientError("Mode must be cloud or onprem.");
  if (mode === (await getSetting(db, "mode"))) return;
  if (mode === "cloud") {
    await setSetting(db, "mode", "cloud");
    await setSetting(db, "onprem_client_id", null);
    return;
  }
  const clients = await all<{ id: number; name: string }>(db, "SELECT id, name FROM clients ORDER BY id");
  if (clients.length > 1) {
    const names = clients.map((c) => c.name).join(", ");
    throw new ClientError(
      `Single-client mode allows one client, but there are ${clients.length} (${names}). Delete the clients you no longer need first.`,
    );
  }
  await setSetting(db, "mode", "onprem");
  await setSetting(db, "onprem_client_id", clients.length ? clients[0].id : null);
}
