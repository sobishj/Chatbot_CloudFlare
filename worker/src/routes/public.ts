/**
 * Public endpoints (used by the widget on client websites).
 *
 * Security model
 * --------------
 * * Every chat/config request must come from a page whose origin is in the client's
 *   ``allowed_domains`` (Origin header, or Referer when a browser omits Origin).
 *   Requests from other sites — or with no origin at all, e.g. curl — are rejected.
 * * CORS headers echo only allowed origins; preflights are answered for origins that
 *   belong to any active client (the body, and so the client id, isn't sent in a preflight).
 * * Rate limits per IP and per client (D1 counters, shared by every Worker instance).
 * * Nothing secret is ever returned: config contains branding only.
 */

import type { Hono } from "hono";
import type { Env } from "../env";
import type { Client } from "../models";
import { answerQuestion, type ChatResponse } from "../chat/service";
import { streamAnswer } from "../chat/stream";
import * as rateLimit from "../services/rate_limit";
import { branding, getBySlug, originAllowed, publicConfig } from "../services/clients";
import { getSetting } from "../services/settings";
import { getFile } from "../storage/files";
import { clientIp, HttpError, json, readJson, validateBody } from "../util/http";
import type { AppEnv } from "./context";
import { allowedPreflightOrigin, corsHeaders, requestOrigin } from "./cors";

/** Return the active client and the verified origin, or throw 403/404. */
async function clientForOrigin(db: D1Database, clientId: string, request: Request): Promise<[Client, string]> {
  const client = await getBySlug(db, clientId);
  if (!client || !client.active) throw new HttpError(404, "Unknown client.");
  if (!branding(client).widget_enabled) throw new HttpError(404, "The chatbot is switched off."); // switched off: the widget stays hidden
  const origin = requestOrigin(request);
  if (!originAllowed(origin, client.allowed_domains || [])) throw new HttpError(403, "This website is not allowed to use this assistant.");
  return [client, origin!];
}

/** What visitors get: the answer only, no source pages or document names (kept in the admin's logs). */
export function publicReply(result: ChatResponse): Record<string, any> {
  const reply: Record<string, any> = { answer: result.answer, sources: [], answered: result.answered };
  if (result.confirmation) reply.confirmation = { action: result.confirmation.action, summary: result.confirmation.summary }; // only the summary
  return reply;
}

export function sse(event: Record<string, any>): string {
  return "data: " + JSON.stringify(event) + "\n\n";
}

/** A server-sent-event response fed by an async generator of events. */
export function sseResponse(events: AsyncGenerator<Record<string, any>>, headers: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await events.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(sse(value)));
      } catch (exc) {
        console.error("Streamed answer failed", exc);
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", ...headers },
  });
}

const CHAT_SPEC = {
  client_id: { kind: "str" as const, required: true, min_length: 1, max_length: 64 },
  session_id: { kind: "str" as const, required: true, min_length: 8, max_length: 64, pattern: /^[A-Za-z0-9_-]+$/ },
  message: { kind: "str" as const, required: true, min_length: 1, max_length: 1000 },
  // Confirm (true) / Cancel (false) button of an API action waiting for confirmation.
  confirm: { kind: "bool" as const, default: null },
};

/** Origin, rate limits and empty messages; returns the client and CORS headers, or throws. */
async function checkChat(env: Env, body: Record<string, any>, request: Request): Promise<[Client, Record<string, string>]> {
  const db = env.DB;
  const [client, origin] = await clientForOrigin(db, body.client_id, request);
  const headers = corsHeaders(origin);
  const limits = (await getSetting(db, "rate_limits")) || {};
  const ip = clientIp(request);
  if (
    !(await rateLimit.hit(db, `chat:ip:${ip}`, Number(limits.chat_per_ip_per_minute ?? 20), 60)) ||
    !(await rateLimit.hit(db, `chat:client:${client.id}`, Number(limits.chat_per_client_per_minute ?? 300), 60))
  ) {
    throw new HttpError(429, "Too many messages. Please wait a moment and try again.", headers);
  }
  if (!body.message.trim()) throw new HttpError(400, "Empty message.", headers);
  return [client, headers];
}

export function registerPublic(app: Hono<AppEnv>): void {
  for (const path of ["/api/chat", "/api/chat/stream", "/api/client/:client_id/config"]) {
    app.options(path, async (c) => {
      const origin = c.req.header("origin");
      if (origin && (await allowedPreflightOrigin(c.env.DB, origin))) return new Response(null, { status: 204, headers: corsHeaders(origin) });
      return new Response(null, { status: 403 });
    });
  }

  app.get("/api/client/:client_id/config", async (c) => {
    const db = c.env.DB;
    const [client, origin] = await clientForOrigin(db, c.req.param("client_id"), c.req.raw);
    const logo = (client.branding || {}).logo_file;
    const logoUrl = logo ? `/api/client/${client.client_id}/logo?v=${(client.branding || {}).logo_version ?? 0}` : null;
    const config = publicConfig(client, (await getSetting(db, "chat_notice")) || "", logoUrl);
    return json(config, 200, { ...corsHeaders(origin), "Cache-Control": "no-cache" });
  });

  app.get("/api/client/:client_id/logo", async (c) => {
    const client = await getBySlug(c.env.DB, c.req.param("client_id"));
    if (!client || !client.active) throw new HttpError(404, "Not found.");
    return logoResponse(c.env, client);
  });

  app.post("/api/chat", async (c) => {
    const body = validateBody(await readJson(c.req.raw), CHAT_SPEC);
    const [client, headers] = await checkChat(c.env, body, c.req.raw);
    const result = await answerQuestion(c.env, client, body.session_id, body.message, "widget", body.confirm);
    return json(publicReply(result), 200, headers);
  });

  /**
   * Like /api/chat, but the answer arrives word by word (server-sent events): {"t": "delta", "text"} …
   * then {"t": "done", "answer", "answered", "confirmation"?}.
   */
  app.post("/api/chat/stream", async (c) => {
    const body = validateBody(await readJson(c.req.raw), CHAT_SPEC);
    const [client, headers] = await checkChat(c.env, body, c.req.raw);
    async function* events() {
      for await (const [kind, value] of streamAnswer(c.env, client, body.session_id, body.message, "widget", body.confirm)) {
        yield kind === "delta" ? { t: "delta", text: value } : { t: "done", ...publicReply(value as ChatResponse) };
      }
    }
    return sseResponse(events(), headers);
  });
}

const LOGO_MEDIA: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export function logoKey(client: Client, filename: string): string {
  return `clients/${client.client_id}/branding/${filename}`;
}

/** Every key a logo can have (one per image type), so it can be removed without listing KV. */
export function allLogoKeys(client: Client): string[] {
  return Object.keys(LOGO_MEDIA).map((ext) => logoKey(client, `logo.${ext}`));
}

export async function logoResponse(env: Env, client: Client): Promise<Response> {
  const filename = (client.branding || {}).logo_file;
  const obj = filename ? await getFile(env.FILES_KV, logoKey(client, filename)) : null;
  if (!obj) throw new HttpError(404, "No logo.");
  const ext = String(filename).split(".").pop() || "";
  return new Response(obj.data, {
    headers: {
      "Content-Type": LOGO_MEDIA[ext] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
