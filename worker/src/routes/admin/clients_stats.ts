/** Client → Stats and Conversations tabs, and the CSV export. */

import type { Hono } from "hono";
import { exportCsv, listConversations, questionStats } from "../../analytics/stats";
import { json, queryBool, queryInt, queryPattern } from "../../util/http";
import { clientForUser, requireSetupCompleted, type AppEnv, type C } from "../context";

export function registerClientStats(app: Hono<AppEnv>): void {
  const base = "/api/admin/clients/:client_id";
  const forClient = async (c: C) => {
    await requireSetupCompleted(c);
    return clientForUser(c, c.req.param("client_id")!);
  };
  const filters = (url: URL) => ({
    search: url.searchParams.get("search") ?? "",
    answered: queryPattern(url, "answered", "all", /^(all|yes|no)$/),
    channel: queryPattern(url, "channel", "all", /^(all|widget|test|cli)$/),
  });

  app.get(`${base}/stats`, async (c) => {
    const { client } = await forClient(c);
    const url = new URL(c.req.url);
    return json(await questionStats(c.env.DB, [client.id], queryInt(url, "days", 30, 1, 365), queryBool(url, "include_test", false)));
  });

  app.get(`${base}/conversations`, async (c) => {
    const { client } = await forClient(c);
    const url = new URL(c.req.url);
    const f = filters(url);
    return json(await listConversations(c.env.DB, client.id, queryInt(url, "page", 1, 1), queryInt(url, "per_page", 50, 1, 200), f));
  });

  // The CSV route ends in ".csv", so it gets its own pattern next to /conversations.
  app.get("/api/admin/clients/:client_id{[^/]+}/conversations.csv", async (c) => {
    const { client } = await forClient(c);
    const url = new URL(c.req.url);
    const f = filters(url);
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    return new Response(exportCsv(c.env.DB, client.id, f), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="conversations-${client.client_id}-${stamp}.csv"` },
    });
  });
}
