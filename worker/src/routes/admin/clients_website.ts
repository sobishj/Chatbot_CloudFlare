/** Client → Website tab: crawl now, crawl settings, crawled pages. */

import type { Hono } from "hono";
import { chunkIds, deleteVectors } from "../../indexer/cleanup";
import { crawlSettings, validateCrawlSettings } from "../../services/clients";
import * as jobService from "../../services/jobs";
import { all, first, run, toJson } from "../../util/db";
import { HttpError, json, queryInt, readJson, validateBody } from "../../util/http";
import { kickJobs } from "../../worker/runner";
import { clientForUser, requireSetupCompleted, type AppEnv, type C } from "../context";
import { clientDetail, requireSuper } from "./clients";

export function registerClientWebsite(app: Hono<AppEnv>): void {
  const base = "/api/admin/clients/:client_id";
  const forClient = async (c: C) => {
    await requireSetupCompleted(c);
    return clientForUser(c, c.req.param("client_id")!);
  };

  app.post(`${base}/crawl`, async (c) => {
    const { client, user } = await forClient(c);
    if (!client.website_url) throw new HttpError(400, "Set the website URL first.");
    const job = await jobService.enqueue(c.env.DB, "crawl", client.id, {}, "user", user.id);
    kickJobs(c);
    return json({ job: jobService.jobToDict(job) });
  });

  app.put(`${base}/crawl-settings`, async (c) => {
    const { client, user } = await forClient(c);
    const body = validateBody(await readJson(c.req.raw), {
      max_pages: { kind: "int", default: null },
      delay_seconds: { kind: "float", default: null },
      include_patterns: { kind: "any", default: null },
      exclude_patterns: { kind: "any", default: null },
      extraction: { kind: "str", default: null },
      render_js: { kind: "str", default: null },
      read_images: { kind: "bool", default: null },
      read_documents: { kind: "bool", default: null },
    });
    requireSuper(user);
    const present = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
    const changes = validateCrawlSettings(present);
    if (body.extraction !== null) {
      if (body.extraction !== "auto" && body.extraction !== "main_content") throw new HttpError(400, "Extraction must be auto or main_content.");
      changes.extraction = body.extraction;
    }
    await run(c.env.DB, "UPDATE clients SET crawl_settings = ? WHERE id = ?", toJson({ ...crawlSettings(client), ...changes }), client.id);
    return json({ client: await clientDetail(c, client, user) });
  });

  app.get(`${base}/pages`, async (c) => {
    const { client } = await forClient(c);
    const url = new URL(c.req.url);
    const page = queryInt(url, "page", 1, 1);
    const perPage = queryInt(url, "per_page", 50, 1, 200);
    const search = (url.searchParams.get("search") ?? "").trim();
    let where = "p.client_id = ?";
    const params: unknown[] = [client.id];
    if (search) {
      const like = `%${search}%`;
      where += " AND (p.url LIKE ? OR p.title LIKE ?)";
      params.push(like, like);
    }
    const total = (await first<{ n: number }>(c.env.DB, `SELECT count(*) AS n FROM pages p WHERE ${where}`, ...params))?.n ?? 0;
    const rows = await all(
      c.env.DB,
      "SELECT p.id, p.url, p.title, p.crawled_at, length(p.content) AS characters, " +
        "(SELECT count(*) FROM chunks ch WHERE ch.page_id = p.id AND ch.pending = 0) AS chunks " +
        `FROM pages p WHERE ${where} ORDER BY p.url LIMIT ? OFFSET ?`,
      ...params,
      perPage,
      (page - 1) * perPage,
    );
    return json({
      total,
      page,
      per_page: perPage,
      items: rows.map((r) => ({ id: r.id, url: r.url, title: r.title, crawled_at: r.crawled_at, characters: r.characters, chunks: r.chunks })),
    });
  });

  app.get(`${base}/pages/:page_id{[0-9]+}`, async (c) => {
    const { client } = await forClient(c);
    const page = await first(c.env.DB, "SELECT id, client_id, url, title, content, crawled_at FROM pages WHERE id = ?", Number(c.req.param("page_id")));
    if (!page || page.client_id !== client.id) throw new HttpError(404, "Page not found.");
    return json({ page: { id: page.id, url: page.url, title: page.title, content: page.content, crawled_at: page.crawled_at } });
  });

  app.delete(`${base}/pages/:page_id{[0-9]+}`, async (c) => {
    const { client, user } = await forClient(c);
    requireSuper(user);
    const id = Number(c.req.param("page_id"));
    const page = await first(c.env.DB, "SELECT client_id FROM pages WHERE id = ?", id);
    if (!page || page.client_id !== client.id) throw new HttpError(404, "Page not found.");
    const ids = await chunkIds(c.env.DB, "page_id = ?", id);
    await run(c.env.DB, "DELETE FROM pages WHERE id = ?", id);
    await deleteVectors(c.env.VECTORIZE, ids);
    return json({ ok: true });
  });
}
