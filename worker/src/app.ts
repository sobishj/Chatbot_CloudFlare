/**
 * The HTTP application: one Worker for what were two servers in the self-hosted version.
 *
 * * Public side (the widget on client websites): /api/chat, /api/chat/stream, /api/client/{id}/config,
 *   /api/client/{id}/logo and /health. widget.js is a static asset.
 * * Admin side: /api/admin/* (+ /health), with CSRF double-submit and security headers; the admin UI
 *   itself is served from static assets.
 *
 * When ADMIN_HOSTNAME is set, the admin API answers only on that host name and the public API only
 * on the others, like the separate admin port before.
 */

import { Hono } from "hono";
import type { AppEnv, C } from "./routes/context";
import { runtimeFlags } from "./runtime";
import { csrfCookieIfMissing, csrfValid } from "./security/sessions";
import { HttpError, json, UserFacingError } from "./util/http";
import { registerHealth } from "./routes/health";
import { allowedPreflightOrigin, corsHeaders, isPublicPath, requestOrigin } from "./routes/cors";
import { registerAuth } from "./routes/admin/auth";
import { registerSetup } from "./routes/admin/setup";
import { registerModels } from "./routes/admin/models";
import { registerSettings } from "./routes/admin/settings";
import { registerUsers } from "./routes/admin/users";
import { registerPublic } from "./routes/public";
import { registerClients } from "./routes/admin/clients";
import { registerClientWebsite } from "./routes/admin/clients_website";
import { registerJobs } from "./routes/admin/jobs";
import "./worker/handlers";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The UI is built by Vite into static files; no inline scripts are needed.
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const MISSING_BUILD = `<!doctype html><meta charset="utf-8"><title>Website Assistant</title>
<p style="font-family:sans-serif;padding:2rem">The admin UI has not been built.
Run <code>npm run build</code> in <code>worker/</code> (it builds <code>frontend/</code> too).</p>`;

export const app = new Hono<AppEnv>();

function hostOf(c: C): string {
  return new URL(c.req.url).hostname.toLowerCase();
}

function adminHost(c: C): string {
  return (c.env.ADMIN_HOSTNAME || "").trim().toLowerCase();
}

/** Is this request served by the admin side (CSRF, security headers)? */
function isAdminSide(c: C): boolean {
  const path = new URL(c.req.url).pathname;
  if (isPublicPath(path)) return false;
  const admin = adminHost(c);
  return !admin || hostOf(c) === admin;
}

app.use("*", async (c, next) => {
  runtimeFlags.allowPrivateUrls = c.env.DEV_ALLOW_PRIVATE_URLS === "1";
  c.set("user", undefined);
  const path = new URL(c.req.url).pathname;
  const admin = adminHost(c);
  // Separate host names: no admin API on the public host, no public API on the admin host.
  if (admin) {
    const onAdminHost = hostOf(c) === admin;
    if ((path.startsWith("/api/admin") && !onAdminHost) || (isPublicPath(path) && onAdminHost)) {
      return json({ detail: "Not Found" }, 404);
    }
  }
  if (!isAdminSide(c)) {
    await next();
    return;
  }
  // Admin side: double-submit CSRF check on state-changing API calls, plus hardening headers.
  if (UNSAFE_METHODS.has(c.req.method) && path.startsWith("/api/") && !csrfValid(c.req.raw)) {
    c.res = json({ detail: "Security token missing or expired. Reload the page and try again." }, 403);
  } else {
    await next();
  }
  const res = new Response(c.res.body, c.res);
  const cookie = csrfCookieIfMissing(c.req.raw);
  if (cookie) res.headers.append("Set-Cookie", cookie);
  const setDefault = (k: string, v: string) => {
    if (!res.headers.has(k)) res.headers.set(k, v);
  };
  setDefault("X-Content-Type-Options", "nosniff");
  setDefault("X-Frame-Options", "DENY");
  setDefault("Referrer-Policy", "same-origin");
  setDefault("Content-Security-Policy", CSP);
  if (path.startsWith("/api/")) setDefault("Cache-Control", "no-store");
  c.res = res;
});

registerHealth(app);
registerPublic(app);
registerAuth(app);
registerClients(app);
registerClientWebsite(app);
registerJobs(app);
registerSetup(app);
registerModels(app);
registerSettings(app);
registerUsers(app);

app.notFound(async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path === "/health") return json({ detail: "Not Found" }, 404);
  // Static assets answer first; reaching the Worker for a page means the UI hasn't been built.
  if (c.req.method === "GET") {
    const asset = await c.env.ASSETS.fetch(c.req.raw).catch(() => null);
    if (asset && asset.status !== 404) return asset;
    return new Response(MISSING_BUILD, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return json({ detail: "Not Found" }, 404);
});

app.onError(async (err, c) => {
  const path = new URL(c.req.url).pathname;
  let status = 500;
  let detail: unknown = "Internal Server Error";
  let headers: Record<string, string> = {};
  if (err instanceof HttpError) {
    status = err.status;
    detail = err.detail;
    headers = err.headers;
  } else if (err instanceof UserFacingError) {
    status = 400;
    detail = err.message;
  } else {
    console.error("Unhandled error", path, err);
  }
  if (isPublicPath(path)) {
    if (status === 422) detail = "Invalid request.";
    // Errors from allowed widget pages still need CORS headers so the widget can read them.
    const origin = requestOrigin(c.req.raw);
    if (origin && status !== 403 && (await allowedPreflightOrigin(c.env.DB, origin))) headers = { ...corsHeaders(origin), ...headers };
  }
  return json({ detail }, status, headers);
});
