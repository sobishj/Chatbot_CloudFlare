// HTTP-level tests through the Worker's app (tests/test_api.py, test_health.py, test_jobs.py,
// test_search_chat.py, test_stream.py): setup wizard, auth, CSRF, permissions, public API, chat,
// stats/CSV, mode switch, jobs, and the Cloudflare-only behaviour (admin host name, self-hosted messages).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { VisibleText } from "../src/chat/stream";
import { pageDirectory, essentialPages } from "../src/chat/essentials";
import { indexStep, newIndexCursor } from "../src/indexer/indexer";
import { search } from "../src/search/hybrid";
import { newWorkersAIEmbedder } from "../src/embeddings/embedder";
import * as jobService from "../src/services/jobs";
import { createClient } from "../src/services/clients";
import { all, first, run } from "../src/util/db";
import { runJobs } from "../src/worker/runner";
import { resetDb, routeFetch, testEnv } from "./fakes";
import { resetOriginCache } from "../src/routes/cors";

const ORIGIN = "https://www.lulumall.test";

class Browser {
  cookies = new Map<string, string>();
  constructor(public env: ReturnType<typeof testEnv>, public host = "admin.test") {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && this.cookies.has("wa_csrf") && !("x-csrf-token" in h)) h["x-csrf-token"] = this.cookies.get("wa_csrf")!;
    if (body !== undefined && !(body instanceof FormData)) h["content-type"] = "application/json";
    const resp = await app.fetch(
      new Request(`http://${this.host}${path}`, { method, headers: h, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) }),
      this.env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as any,
    );
    for (const sc of resp.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const [k, ...v] = pair.split("=");
      const value = v.join("=");
      if (/Max-Age=0/.test(sc)) this.cookies.delete(k);
      else this.cookies.set(k, value);
    }
    return resp;
  }
  get = (p: string, headers?: Record<string, string>) => this.req("GET", p, undefined, headers);
  post = (p: string, b: unknown = {}, headers?: Record<string, string>) => this.req("POST", p, b, headers);
  put = (p: string, b: unknown = {}) => this.req("PUT", p, b);
  patch = (p: string, b: unknown = {}) => this.req("PATCH", p, b);
  del = (p: string) => this.req("DELETE", p);
}

/** A model behind https://llm.test (OpenAI-compatible), answering with ``reply``. */
function fakeModel(reply: string | ((messages: any[]) => string), opts: { fail?: Set<string> } = {}) {
  const seen: any[] = [];
  const handle = routeFetch(async (url, init) => {
    if (url.host !== "llm.test" && url.host !== "llm2.test") return undefined;
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "main-model" }] });
    const body = JSON.parse(String(init.body));
    seen.push(body);
    if (opts.fail?.has(body.model)) return new Response('{"error": "down"}', { status: 503 });
    const text = typeof reply === "function" ? reply(body.messages) : reply;
    if (body.stream) {
      const events = text.split(/(?<= )/).map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`).join("") +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`;
      return new Response(events, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  });
  return { seen, restore: handle.restore };
}

async function finishSetup(b: Browser, mode = "cloud"): Promise<void> {
  await b.get("/health");
  expect((await b.post("/api/admin/setup/admin", { name: "Root", email: "root@example.com", password: "root-password-1" })).status).toBe(200);
  await b.post("/api/admin/setup/mode", { mode });
  await b.post("/api/admin/setup/domain", { public_domain: "chat.example.com" });
  expect((await b.post("/api/admin/setup/model", { name: "Main", provider: "openai_compatible", base_url: "https://llm.test/v1", model_name: "main-model" })).status).toBe(200);
  expect((await b.post("/api/admin/setup/embedding", { model: "@cf/baai/bge-m3" })).status).toBe(200);
  await b.post("/api/admin/setup/embedding/continue");
  if (mode === "onprem") await b.post("/api/admin/setup/client", { client_id: "solo", name: "Solo", website_url: "", allowed_domains: ["solo.test"] });
  expect((await b.post("/api/admin/setup/finish")).status).toBe(200);
}

async function index(env: ReturnType<typeof testEnv>, clientId: number, url: string, title: string, content: string): Promise<number> {
  const page = (await first<{ id: number }>(env.DB, "INSERT INTO pages (client_id, url, title, content, content_hash) VALUES (?, ?, ?, ?, 'h') RETURNING id", clientId, url, title, content))!;
  const cursor = newIndexCursor({ client_id: clientId, source_type: "web", source: url, title, page_id: page.id, document_id: null });
  const embedder = newWorkersAIEmbedder(env.AI as any, "@cf/baai/bge-m3");
  while (!(await indexStep(env, embedder, cursor, content)).done);
  return page.id;
}

let env: ReturnType<typeof testEnv>;
let model: ReturnType<typeof fakeModel>;

beforeEach(async () => {
  await resetDb();
  resetOriginCache();
  env = testEnv();
  model = fakeModel("ASICS is on the Second Floor.");
});
afterEach(() => model.restore());

describe("setup and auth", () => {
  it("runs the wizard once, then locks it", async () => {
    const b = new Browser(env);
    expect((await (await b.get("/api/admin/auth/me")).json<any>()).setup_completed).toBe(false);
    await finishSetup(b);
    const me = await (await b.get("/api/admin/auth/me")).json<any>();
    expect(me.setup_completed).toBe(true);
    expect(me.user.email).toBe("root@example.com");
    expect((await b.post("/api/admin/setup/admin", { name: "X", email: "x@example.com", password: "another-pass-1" })).status).toBe(409);
    const state = await (await b.get("/api/admin/setup/state")).json<any>();
    expect(state.embedding).toEqual({ model: "@cf/baai/bge-m3", dim: 1024, status: "ready", error: null });
  });

  it("setup steps need the signed-in admin", async () => {
    const b = new Browser(env);
    await b.get("/health");
    expect((await b.post("/api/admin/setup/mode", { mode: "cloud" })).status).toBe(401);
  });

  it("CSRF and the login rate limit", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    const noToken = await b.req("POST", "/api/admin/auth/logout", {}, { "x-csrf-token": "wrong" });
    expect(noToken.status).toBe(403);
    expect((await noToken.json<any>()).detail).toContain("Security token");
    await run(env.DB, "INSERT INTO settings (key, value) VALUES ('rate_limits', ?)", JSON.stringify({ login_per_ip_per_15min: 2 }));
    const fresh = new Browser(env);
    await fresh.get("/health");
    for (let i = 0; i < 2; i++) expect((await fresh.post("/api/admin/auth/login", { email: "root@example.com", password: "wrong-password" })).status).toBe(401);
    expect((await fresh.post("/api/admin/auth/login", { email: "root@example.com", password: "root-password-1" })).status).toBe(429);
  });

  it("security headers on the admin side, none on the public API", async () => {
    const b = new Browser(env);
    const health = await b.get("/health");
    expect(health.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    expect(b.cookies.has("wa_csrf")).toBe(true);
    const api = await b.get("/api/admin/auth/me");
    expect(api.headers.get("cache-control")).toBe("no-store");
    const pub = await b.get("/api/client/nope/config", { origin: ORIGIN });
    expect(pub.status).toBe(404);
    expect(pub.headers.get("content-security-policy")).toBeNull();
  });

  it("password change keeps the current session and signs out others", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    const other = new Browser(env);
    await other.get("/health");
    await other.post("/api/admin/auth/login", { email: "root@example.com", password: "root-password-1" });
    expect((await b.post("/api/admin/auth/password", { current_password: "root-password-1", new_password: "short" })).status).toBe(400);
    expect((await b.post("/api/admin/auth/password", { current_password: "root-password-1", new_password: "new-password-22" })).status).toBe(200);
    expect((await (await b.get("/api/admin/auth/me")).json<any>()).user).not.toBeNull();
    expect((await (await other.get("/api/admin/auth/me")).json<any>()).user).toBeNull();
  });
});

describe("Cloudflare-specific behaviour", () => {
  it("local embedding models and watched folders return the self-hosted message", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    const local = await b.post("/api/admin/settings/embedding", { backend: "local", model: "BAAI/bge-m3" });
    expect(local.status).toBe(400);
    expect((await local.json<any>()).detail).toContain("self-hosted version");
    expect((await (await b.get("/api/admin/settings")).json<any>()).embedding.model).toBe("@cf/baai/bge-m3"); // the current model stays
    await b.post("/api/admin/clients", { client_id: "mall", name: "Mall" });
    const folder = await b.put("/api/admin/clients/mall/documents/settings", { watch_path: "/mnt/watched/mall" });
    expect(folder.status).toBe(400);
    expect((await folder.json<any>()).detail).toContain("Watched folders need the self-hosted version");
    expect((await b.post("/api/admin/clients/mall/documents/scan")).status).toBe(400);
    const settings = await (await b.get("/api/admin/settings")).json<any>();
    expect(settings.worker_hardware.gpu).toBeNull();
    expect((await b.put("/api/admin/settings", { compute_device: "gpu" })).status).toBe(200); // saved, no effect
    const options = settings.embedding_options.map((o: any) => o.key);
    expect(options).toContain("local:workers_ai:@cf/baai/bge-m3");
    expect(options).toContain("local:huggingface:BAAI/bge-m3"); // still listed
  });

  it("local model servers fail fast; public URLs work like any OpenAI-compatible server", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    const test = await (await b.post("/api/admin/models/test", { config: { provider: "ollama", base_url: "http://host.docker.internal:11434/v1", model_name: "qwen" } })).json<any>();
    expect(test.ok).toBe(false);
    expect(test.error).toContain("Local model servers can't be reached from Cloudflare");
    const saved = await (await b.post("/api/admin/models", { name: "Ollama", provider: "ollama", base_url: "http://localhost:11434/v1", model_name: "qwen" })).json<any>();
    expect(saved.model.loopback_warning).toBe(true);
    const tunnel = await (await b.post("/api/admin/models/test", { config: { provider: "ollama", base_url: "https://llm.test/v1", model_name: "main-model" } })).json<any>();
    expect(tunnel.ok).toBe(true);
  });

  it("with ADMIN_HOSTNAME set, admin and public APIs answer on their own host names", async () => {
    const admin = new Browser(testEnv({ ADMIN_HOSTNAME: "admin.example.com" } as any), "admin.example.com");
    env = admin.env as any;
    await finishSetup(admin);
    const pub = new Browser(admin.env, "chat.example.com");
    expect((await pub.get("/api/admin/auth/me")).status).toBe(404);
    expect((await admin.get("/api/admin/auth/me")).status).toBe(200);
    expect((await admin.get("/api/client/x/config", { origin: ORIGIN })).status).toBe(404);
    const health = await pub.get("/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("content-security-policy")).toBeNull(); // public side: no admin headers
  });
});

describe("public API", () => {
  async function mall(b: Browser) {
    await finishSetup(b);
    await b.post("/api/admin/clients", { client_id: "lulu", name: "Lulu Mall", website_url: "https://www.lulumall.test", allowed_domains: ["lulumall.test"] });
    const client = (await first<{ id: number }>(env.DB, "SELECT id FROM clients WHERE client_id = 'lulu'"))!;
    await index(env, client.id, "https://www.lulumall.test/asics", "ASICS", "ASICS sports shoes. Located on: Second Floor.");
    await b.put("/api/admin/settings", { confidence_threshold: 0.1 }); // the fake embeddings score lower than bge-m3
    return client.id;
  }

  it("config needs an allowed origin; CORS only for allowed origins", async () => {
    const b = new Browser(env);
    await mall(b);
    const pub = new Browser(env, "chat.example.com");
    expect((await pub.get("/api/client/lulu/config")).status).toBe(403);
    expect((await pub.get("/api/client/lulu/config", { origin: "https://evil.test" })).status).toBe(403);
    const ok = await pub.get("/api/client/lulu/config", { origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const cfg = await ok.json<any>();
    expect(cfg.bot_name).toBe("Lulu Mall Assistant");
    expect(JSON.stringify(cfg)).not.toContain("api_settings");
    expect((await pub.get("/api/client/lulu/config", { referer: ORIGIN + "/page" })).status).toBe(200);
    const pre = await pub.req("OPTIONS", "/api/chat", undefined, { origin: ORIGIN });
    expect(pre.status).toBe(204);
    expect((await pub.req("OPTIONS", "/api/chat", undefined, { origin: "https://evil.test" })).status).toBe(403);
  });

  it("chat flow, rejections, no sources for visitors, PII masked", async () => {
    const b = new Browser(env);
    await mall(b);
    const pub = new Browser(env, "chat.example.com");
    const chat = (body: any, origin = ORIGIN) => pub.post("/api/chat", body, { origin });
    const reply = await chat({ client_id: "lulu", session_id: "visitor-1", message: "Where is ASICS? my phone is 9847012345" });
    expect(reply.status).toBe(200);
    const data = await reply.json<any>();
    expect(data).toEqual({ answer: "ASICS is on the Second Floor.", sources: [], answered: true });
    expect(model.seen.at(-1).messages.at(-1).content).toContain("[phone]");
    expect((await first<{ question: string }>(env.DB, "SELECT question FROM questions"))!.question).not.toContain("9847012345");
    expect((await chat({ client_id: "lulu", session_id: "visitor-1", message: "hi" }, "https://evil.test")).status).toBe(403);
    expect((await chat({ client_id: "nope", session_id: "visitor-1", message: "hi" })).status).toBe(404);
    const invalid = await chat({ client_id: "lulu", session_id: "x", message: "hi" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ detail: "Invalid request." });
    expect(invalid.headers.get("access-control-allow-origin")).toBe(ORIGIN); // errors stay readable by the widget
    expect((await chat({ client_id: "lulu", session_id: "visitor-1", message: "   " })).status).toBe(400);
  });

  it("rate limit per IP", async () => {
    const b = new Browser(env);
    await mall(b);
    await b.put("/api/admin/settings", { rate_limits: { chat_per_ip_per_minute: 2 } });
    const pub = new Browser(env, "chat.example.com");
    const headers = { origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 2; i++) expect((await pub.post("/api/chat", { client_id: "lulu", session_id: "visitor-1", message: "hi" }, headers)).status).toBe(200);
    const limited = await pub.post("/api/chat", { client_id: "lulu", session_id: "visitor-1", message: "hi" }, headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("streams words then done", async () => {
    const b = new Browser(env);
    await mall(b);
    const pub = new Browser(env, "chat.example.com");
    const resp = await pub.post("/api/chat/stream", { client_id: "lulu", session_id: "visitor-2", message: "Where is ASICS?" }, { origin: ORIGIN });
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const events = (await resp.text()).split("\n\n").filter(Boolean).map((e) => JSON.parse(e.slice(6)));
    expect(events.filter((e) => e.t === "delta").map((e) => e.text).join("")).toBe("ASICS is on the Second Floor.");
    expect(events.at(-1)).toEqual({ t: "done", answer: "ASICS is on the Second Floor.", sources: [], answered: true });
  });

  it("a switched-off chatbot hides the widget but test chat works", async () => {
    const b = new Browser(env);
    await mall(b);
    await b.put("/api/admin/clients/lulu/branding", { widget_enabled: false });
    const pub = new Browser(env, "chat.example.com");
    expect((await pub.get("/api/client/lulu/config", { origin: ORIGIN })).status).toBe(404);
    const test = await (await b.post("/api/admin/clients/lulu/test-chat", { session_id: "t1", message: "Where is ASICS?" })).json<any>();
    expect(test.answer).toBe("ASICS is on the Second Floor.");
    expect(test.sources[0].url).toBe("https://www.lulumall.test/asics");
    expect(test.chunks[0].source).toBe("https://www.lulumall.test/asics");
  });
});

describe("clients, roles and statistics", () => {
  it("client admins see only their clients and can't change settings", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    await b.post("/api/admin/clients", { client_id: "a", name: "A" });
    await b.post("/api/admin/clients", { client_id: "bee", name: "Bee" });
    const a = (await first<{ id: number }>(env.DB, "SELECT id FROM clients WHERE client_id = 'a'"))!;
    expect((await b.post("/api/admin/users", { name: "Ann", email: "ann@example.com", password: "ann-password-1", role: "client_admin", client_ids: [a.id] })).status).toBe(200);
    const ann = new Browser(env);
    await ann.get("/health");
    expect((await ann.post("/api/admin/auth/login", { email: "ann@example.com", password: "ann-password-1" })).status).toBe(200);
    const list = await (await ann.get("/api/admin/clients")).json<any>();
    expect(list.clients.map((c: any) => c.client_id)).toEqual(["a"]);
    expect((await ann.get("/api/admin/clients/bee")).status).toBe(404);
    expect((await ann.patch("/api/admin/clients/a", { name: "Changed" })).status).toBe(403);
    expect((await ann.get("/api/admin/settings")).status).toBe(403);
    expect((await ann.get("/api/admin/users")).status).toBe(403);
    expect((await ann.put("/api/admin/clients/a/documents/answering", { key_facts: "Open 9-5" })).status).toBe(200);
  });

  it("stats, conversations and a CSV export safe for Excel", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    await b.post("/api/admin/clients", { client_id: "mall", name: "Mall", allowed_domains: ["mall.test"] });
    const pub = new Browser(env, "chat.example.com");
    await pub.post("/api/chat", { client_id: "mall", session_id: "visitor-1", message: "=cmd() where is it?" }, { origin: "https://mall.test" });
    await b.post("/api/admin/clients/mall/test-chat", { session_id: "t1", message: "test question" });
    const stats = await (await b.get("/api/admin/clients/mall/stats")).json<any>();
    expect(stats.total).toBe(1); // test chat excluded
    expect(stats.per_day.length).toBe(30);
    expect((await (await b.get("/api/admin/clients/mall/stats?include_test=true")).json<any>()).total).toBe(2);
    const convs = await (await b.get("/api/admin/clients/mall/conversations?channel=test")).json<any>();
    expect(convs.total).toBe(1);
    expect(convs.items[0].question).toBe("test question");
    const bytes = new Uint8Array(await (await b.get("/api/admin/clients/mall/conversations.csv")).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM for Excel
    const csv = new TextDecoder().decode(bytes);
    expect(csv.startsWith("created_at,session_id")).toBe(true);
    expect(csv).toContain("'=cmd() where is it?");
    const dash = await (await b.get("/api/admin/dashboard")).json<any>();
    expect(dash.questions_today).toBe(1);
    expect(dash.health.database).toBe(true);
  });

  it("switches between single- and multi-client mode", async () => {
    const b = new Browser(env);
    await finishSetup(b, "onprem");
    expect((await (await b.get("/api/admin/auth/me")).json<any>()).onprem_client_id).toBe("solo");
    expect((await b.post("/api/admin/clients", { client_id: "two", name: "Two" })).status).toBe(400);
    expect((await b.del("/api/admin/clients/solo")).status).toBe(400);
    expect((await b.post("/api/admin/settings/mode", { mode: "cloud" })).status).toBe(200);
    expect((await b.post("/api/admin/clients", { client_id: "two", name: "Two" })).status).toBe(200);
    const refused = await b.post("/api/admin/settings/mode", { mode: "onprem" });
    expect(refused.status).toBe(400);
    expect((await refused.json<any>()).detail).toContain("Single-client mode allows one client, but there are 2");
  });

  it("model priority", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    const second = await (await b.post("/api/admin/models", { name: "Second", provider: "openai_compatible", base_url: "https://llm2.test/v1", model_name: "second" })).json<any>();
    const ids = second.models.map((m: any) => m.id);
    const listing = await (await b.put("/api/admin/models/priority", { model_ids: [...ids].reverse() })).json<any>();
    expect(listing.priority).toEqual([...ids].reverse());
    expect(listing.default_model_id).toBe(ids.at(-1));
    expect((await b.put("/api/admin/models/priority", { model_ids: [] })).status).toBe(400);
  });

  it("deleting a client removes its rows, vectors and files", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    await b.post("/api/admin/clients", { client_id: "gone", name: "Gone" });
    const c = (await first<{ id: number }>(env.DB, "SELECT id FROM clients WHERE client_id = 'gone'"))!;
    await index(env, c.id, "https://gone.test/", "Gone", "Some content here.");
    await env.FILES_KV.put("clients/gone/documents/x.txt", "x");
    expect(env.VECTORIZE.vectors.size).toBeGreaterThan(0);
    expect((await b.del("/api/admin/clients/gone")).status).toBe(200);
    expect(env.VECTORIZE.vectors.size).toBe(0);
    expect(await first(env.DB, "SELECT id FROM chunks")).toBeNull();
    expect(await env.FILES_KV.get("clients/gone/documents/x.txt")).toBeNull();
  });

  it("logos are stored in KV under the same key, replaced and removed", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    await b.post("/api/admin/clients", { client_id: "brand", name: "Brand" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
    const upload = (bytes: Uint8Array, name: string) => {
      const form = new FormData();
      form.append("file", new File([bytes], name));
      return b.req("POST", "/api/admin/clients/brand/logo", form);
    };
    expect((await upload(png, "logo.png")).status).toBe(200);
    expect(new Uint8Array((await env.FILES_KV.get("clients/brand/branding/logo.png", "arrayBuffer"))!)).toEqual(png);
    let resp = await b.get("/api/admin/clients/brand/logo");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(png);

    // A JPG replaces the PNG (the old key is removed).
    expect((await upload(jpg, "logo.jpg")).status).toBe(200);
    expect(await env.FILES_KV.get("clients/brand/branding/logo.png")).toBeNull();
    resp = await b.get("/api/admin/clients/brand/logo");
    expect(resp.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(jpg);

    expect((await b.del("/api/admin/clients/brand/logo")).status).toBe(200);
    expect(await env.FILES_KV.get("clients/brand/branding/logo.jpg")).toBeNull();
    expect((await b.get("/api/admin/clients/brand/logo")).status).toBe(404);
  });

  it("document uploads over 25 MB are refused with a clear message", async () => {
    const b = new Browser(env);
    await finishSetup(b);
    await b.post("/api/admin/clients", { client_id: "docs", name: "Docs" });
    const form = new FormData();
    form.append("files", new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.pdf", { type: "application/pdf" }));
    form.append("files", new File(["Open 9 to 5."], "hours.txt", { type: "text/plain" }));
    const resp = await b.req("POST", "/api/admin/clients/docs/documents", form);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { saved: { path: string }[]; errors: string[] };
    expect(body.saved.map((d) => d.path)).toEqual(["hours.txt"]);
    expect(body.errors).toEqual([expect.stringMatching(/^huge\.pdf: File is larger than 25 MB\./)]);
    expect(await env.FILES_KV.get("clients/docs/documents/huge.pdf")).toBeNull();
  });
});

describe("jobs", () => {
  it("dedupe, claim, success, failure, cancel and stale recovery", async () => {
    const client = await createClient(env.DB, "j", "J", "");
    const a = await jobService.enqueue(env.DB, "reindex", client.id);
    expect((await jobService.enqueue(env.DB, "reindex", client.id)).id).toBe(a.id); // deduplicated
    for (let i = 0; i < 20 && ["queued", "running"].includes((await jobService.getJob(env.DB, a.id))!.status); i++) await runJobs(env, 1);
    const done = (await jobService.getJob(env.DB, a.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.progress).toBe(100);
    expect(done.log).toContain("Started: Re-index everything");
    expect(done.log).toContain("Finished");

    const scan = await jobService.enqueue(env.DB, "scan_folder", client.id);
    await runJobs(env, 1);
    const failed = (await jobService.getJob(env.DB, scan.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Watched folders need the self-hosted version");
    expect(failed.log).toContain("ERROR:");
    expect((await jobService.retry(env.DB, failed)).status).toBe("queued");

    const queued = await jobService.enqueue(env.DB, "crawl", client.id, {}, "user", null, false);
    await jobService.requestCancel(env.DB, queued);
    expect((await jobService.getJob(env.DB, queued.id))!.status).toBe("cancelled");

    const stale = await jobService.enqueue(env.DB, "reindex", client.id, {}, "user", null, false);
    await run(env.DB, "UPDATE jobs SET status = 'running', heartbeat_at = ? WHERE id = ?", new Date(Date.now() - 600_000).toISOString(), stale.id);
    const hung = await jobService.enqueue(env.DB, "download_embedding", null, {}, "user", null, false);
    await run(env.DB, "UPDATE jobs SET status = 'running', heartbeat_at = ? WHERE id = ?", new Date(Date.now() - 600_000).toISOString(), hung.id);
    expect(await jobService.recoverStaleJobs(env.DB)).toBe(2);
    const requeued = (await jobService.getJob(env.DB, stale.id))!;
    expect(requeued.status).toBe("queued");
    expect(requeued.payload._attempts).toBe(2);
    expect((await jobService.getJob(env.DB, hung.id))!.status).toBe("failed");
  });
});

describe("search and chat", () => {
  it("re-indexing replaces old chunks and their vectors", async () => {
    const client = await createClient(env.DB, "m", "M", "");
    const pageId = await index(env, client.id, "https://m.test/a", "A", "Old text about shoes.");
    const cursor = newIndexCursor({ client_id: client.id, source_type: "web", source: "https://m.test/a", title: "A", page_id: pageId, document_id: null });
    await indexStep(env, newWorkersAIEmbedder(env.AI as any, "@cf/baai/bge-m3"), cursor, "New text about bags.");
    const chunks = await all<{ id: number; content: string }>(env.DB, "SELECT id, content FROM chunks");
    expect(chunks.map((c) => c.content)).toEqual(["New text about bags."]);
    expect([...env.VECTORIZE.vectors.keys()]).toEqual([String(chunks[0].id)]);
  });

  it("keyword search beats a lookalike, and search is isolated per client", async () => {
    const one = await createClient(env.DB, "one", "One", "");
    const two = await createClient(env.DB, "two", "Two", "");
    await index(env, one.id, "https://one.test/asics", "ASICS", "ASICS running shoes.");
    await index(env, one.id, "https://one.test/basics", "Basics", "Basics of retail.");
    await index(env, two.id, "https://two.test/asics", "ASICS", "ASICS other mall.");
    const embedder = newWorkersAIEmbedder(env.AI as any, "@cf/baai/bge-m3");
    const result = await search(env, embedder, one.id, "Where is the ASICS store?");
    expect(result.hits[0].source).toBe("https://one.test/asics");
    expect(result.keyword_match).toBe(true);
    expect(result.hits.every((h) => h.source.startsWith("https://one.test"))).toBe(true);
  });

  it("essential pages and the page directory", async () => {
    const c = await createClient(env.DB, "e", "E", "");
    for (const [url, title, content] of [
      ["https://e.test/contact", "Contact us - E Mall", "Phone 0484 111"],
      ["https://e.test/timings", "Mall Timings - E Mall", "Open 10 AM to 10 PM"],
      ["https://e.test/nike", "NIKE - E Mall", "Sports"],
      ["https://e.test/zara", "Zara - E Mall", "Fashion"],
    ]) await run(env.DB, "INSERT INTO pages (client_id, url, title, content, content_hash) VALUES (?, ?, ?, ?, 'h')", c.id, url, title, content);
    const essentials = await essentialPages(env.DB, c.id);
    expect(essentials.indexOf("Mall Timings")).toBeLessThan(essentials.indexOf("Contact us")); // opening hours first
    expect(essentials).not.toContain("NIKE");
    expect(await pageDirectory(env.DB, c.id)).toBe("Contact us, Mall Timings, NIKE, Zara");
  });

  it("VisibleText hides tags and reasoning, even half-written", () => {
    const v = new VisibleText();
    const out = ["<thi", "nk>secret</think>", "Hello ", "there [[NO", "_ANSWER]]"].map((p) => v.feed(p)).join("");
    expect(out).toBe("Hello there ");
    const w = new VisibleText();
    expect(["We are open", " [[", "maybe not a tag"].map((p) => w.feed(p)).join("")).toBe("We are open [[maybe not a tag");
  });
});

describe("health", () => {
  it("reports ok with version and checks", async () => {
    const resp = await new Browser(env).get("/health");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "ok", version: "0.1.0", checks: { database: { ok: true, pgvector_available: true } } });
  });

  it("no API docs are exposed", async () => {
    for (const path of ["/docs", "/openapi.json", "/api/docs"]) expect((await new Browser(env).get(path)).status).not.toBe(200);
  });
});
