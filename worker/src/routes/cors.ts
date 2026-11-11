/** Origin checks and CORS headers for the public API (used by the widget on client websites). */

import { originAllowed } from "../services/clients";
import { all, parseJson } from "../util/db";
import { urlparse } from "../util/pyurl";

const PUBLIC_PATH_RE = /^\/api\/(?:chat(?:\/stream)?|client\/[^/]+\/(?:config|logo))\/?$/;

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATH_RE.test(path);
}

/** The page origin: Origin header, or scheme://host[:port] of the Referer. */
export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") return origin;
  const referer = request.headers.get("referer");
  if (referer) {
    const p = urlparse(referer);
    if (p.scheme && p.netloc) return `${p.scheme}://${p.netloc}`;
  }
  return null;
}

const ORIGIN_CACHE_MS = 30_000;
let originCache: { at: number; domains: string[] } = { at: 0, domains: [] };

/** Allowed domains of all active clients (cached briefly; used for CORS preflights). */
export async function allAllowedDomains(db: D1Database): Promise<string[]> {
  if (Date.now() - originCache.at > ORIGIN_CACHE_MS) {
    const rows = await all<{ allowed_domains: string }>(db, "SELECT allowed_domains FROM clients WHERE active = 1");
    originCache = { at: Date.now(), domains: rows.flatMap((r) => parseJson<string[]>(r.allowed_domains, [])) };
  }
  return [...originCache.domains];
}

/** Forget the cached domains (tests). */
export function resetOriginCache(): void {
  originCache = { at: 0, domains: [] };
}

export async function allowedPreflightOrigin(db: D1Database, origin: string): Promise<boolean> {
  return originAllowed(origin, await allAllowedDomains(db));
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
