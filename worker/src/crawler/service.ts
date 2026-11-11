/**
 * Crawl a client's website and keep ``pages`` + ``chunks`` in sync, as a resumable job.
 *
 * Phases (each step does a little, the cursor in the job payload says where to continue):
 *   robots   → read robots.txt (Disallow, Crawl-delay, Sitemap: entries)
 *   sitemaps → read sitemaps (one per step); their pages are the crawl's seeds
 *   crawl    → fetch pages one by one (delay_seconds apart), index new/changed ones, follow links
 *              when no sitemap listed pages; the frontier (URLs to fetch and what happened to each)
 *              is the crawl_frontier table
 *   finish   → remove pages that are gone (404/410) and, after a complete crawl, pages no longer
 *              linked/listed; set last_crawl_at
 */

import type { Env } from "../env";
import type { Client } from "../models";
import { getEmbedder } from "../embeddings/embedder";
import { chunkIds, deleteVectors } from "../indexer/cleanup";
import { indexStep, newIndexCursor, type IndexCursor } from "../indexer/indexer";
import { sha256Hex } from "../security/crypto";
import { crawlSettings } from "../services/clients";
import { getSetting } from "../services/settings";
import { all, first, nowIso, run } from "../util/db";
import { hostnameOf, urlparse } from "../util/pyurl";
import type { StepContext, StepResult } from "../worker/runner";
import { allowed, decodeBody, FetchError, fetchCapped, MAX_SITEMAPS, normalizeUrl, parseSitemap, RobotsBlocked, robotsLines, sameSite, siteKey, SITEMAP_PATHS, USER_AGENT, type CrawlConfig, type Fetched } from "./crawler";
import { extract } from "./extract";
import { crawlDelay, parseRobots, type Robots } from "./robots";

interface CrawlCursor {
  phase: "robots" | "sitemaps" | "crawl" | "finish";
  config: CrawlConfig;
  site: string;
  origin: string;
  delay: number;
  robots: Robots;
  sitemap_queue: string[];
  sitemap_visited: string[];
  seeds: number;
  seq: number;
  queued: number;
  truncated: boolean;
  follow_links: boolean;
  used_sitemap: boolean;
  pages: number;
  failed: number;
  hit_limit: boolean;
  errors: string[];
  stats: { new: number; updated: number; unchanged: number; removed: number; chunks: number };
  next_fetch_at: number;
  index: { cursor: IndexCursor; url: string } | null;
}

// Frontier states.
const QUEUED = 0;
const SEEN = 1;
const GONE = 2;
const SKIPPED = 3;

const PAGES_PER_STEP = 2;
const MAX_WAIT_IN_STEP_MS = 2500;
const MAX_ERRORS_KEPT = 50;

/** URLs kept in the frontier: enough for the page limit plus pages that turn out not to count. */
function frontierCap(maxPages: number): number {
  return Math.max(2 * maxPages, maxPages + 500);
}

function newCursor(client: Client): CrawlCursor {
  if (!client.website_url) throw new Error("This client has no website URL.");
  const settings = crawlSettings(client);
  const config: CrawlConfig = {
    start_url: client.website_url,
    max_pages: Number(settings.max_pages),
    delay_seconds: Number(settings.delay_seconds),
    include_patterns: [...settings.include_patterns],
    exclude_patterns: [...settings.exclude_patterns],
    extraction: String(settings.extraction ?? "auto"),
  };
  const start = urlparse(config.start_url);
  const host = hostnameOf(start.netloc);
  if (!["http", "https"].includes(start.scheme) || !host) throw new Error(`Invalid start URL: ${config.start_url}`);
  return {
    phase: "robots",
    config,
    site: siteKey(host),
    origin: `${start.scheme}://${start.netloc}`,
    delay: config.delay_seconds,
    robots: parseRobots([]),
    sitemap_queue: [],
    sitemap_visited: [],
    seeds: 0,
    seq: 0,
    queued: 0,
    truncated: false,
    follow_links: false,
    used_sitemap: false,
    pages: 0,
    failed: 0,
    hit_limit: false,
    errors: [],
    stats: { new: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0 },
    next_fetch_at: 0,
    index: null,
  };
}

/** Polite delay between requests: wait inside the step when it is short, otherwise come back later. */
async function waitTurn(ctx: StepContext, cur: CrawlCursor): Promise<boolean> {
  const wait = cur.next_fetch_at - Date.now();
  if (wait <= 0) return true;
  if (wait <= MAX_WAIT_IN_STEP_MS) {
    await new Promise((r) => setTimeout(r, wait));
    return true;
  }
  ctx.notBefore(cur.next_fetch_at);
  return false;
}

async function get(cur: CrawlCursor, url: string): Promise<Fetched> {
  cur.next_fetch_at = Date.now() + cur.delay * 1000;
  return fetchCapped(url);
}

/** Add URLs to the frontier (deduplicated); returns how many were new. */
async function enqueueUrls(env: Env, jobId: number, cur: CrawlCursor, urls: string[]): Promise<number> {
  const cap = frontierCap(cur.config.max_pages);
  const fresh = [...new Set(urls)];
  if (!fresh.length) return 0;
  const existing = new Set(
    (await all<{ url: string }>(env.DB, "SELECT url FROM crawl_frontier WHERE job_id = ? AND url IN (SELECT value FROM json_each(?))", jobId, JSON.stringify(fresh))).map((r) => r.url),
  );
  const add = fresh.filter((u) => !existing.has(u));
  const room = Math.max(0, cap - cur.queued);
  if (add.length > room) cur.truncated = true;
  const take = add.slice(0, room);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < take.length; i += 30) {
    const part = take.slice(i, i + 30);
    const values: unknown[] = [];
    for (const u of part) values.push(jobId, u, cur.seq++, QUEUED);
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO crawl_frontier (job_id, url, seq, state) VALUES ${part.map(() => "(?, ?, ?, ?)").join(", ")}`).bind(...values));
  }
  if (statements.length) await env.DB.batch(statements);
  cur.queued += take.length;
  return take.length;
}

function markStmt(env: Env, jobId: number, cur: CrawlCursor, url: string, state: number): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO crawl_frontier (job_id, url, seq, state) VALUES (?, ?, ?, ?) ON CONFLICT (job_id, url) DO UPDATE SET state = excluded.state").bind(jobId, url, cur.seq++, state);
}

export async function crawlStep(ctx: StepContext, client: Client): Promise<StepResult> {
  const env = ctx.env;
  const jobId = ctx.job.id;
  let cur: CrawlCursor = ctx.payload._cursor;
  if (!cur) {
    ctx.log(`Crawling ${client.website_url}`);
    cur = newCursor(client);
    ctx.payload._cursor = cur;
  }
  const allowedUrl = (u: string) => allowed(cur.config, cur.site, cur.robots, u);

  // ------------------------------------------------------------------ robots.txt
  if (cur.phase === "robots") {
    let lines: string[] = [];
    let sitemaps: string[] = [];
    try {
      const resp = await get(cur, cur.origin + "/robots.txt");
      if (resp.status >= 500) throw new RobotsBlocked(`robots.txt returned HTTP ${resp.status}; not crawling to stay polite.`);
      if (resp.status < 400) ({ lines, sitemaps } = robotsLines(decodeBody(resp))); // no robots.txt: everything allowed
    } catch (exc) {
      if (exc instanceof RobotsBlocked) throw exc;
      console.warn(`robots.txt unreachable (${(exc as Error).message}); assuming allowed`);
    }
    cur.robots = parseRobots(lines);
    const delay = crawlDelay(cur.robots, USER_AGENT);
    if (delay) cur.delay = Math.max(cur.delay, delay);
    cur.sitemap_queue = [...new Set([...sitemaps, ...SITEMAP_PATHS.map((p) => cur.origin + p)])];
    const start = normalizeUrl(cur.config.start_url);
    if (allowedUrl(start)) await enqueueUrls(env, jobId, cur, [start]);
    cur.phase = "sitemaps";
    return { done: false };
  }

  // ------------------------------------------------------------------ sitemaps
  if (cur.phase === "sitemaps") {
    const visited = new Set(cur.sitemap_visited);
    let fetched = false;
    while (!fetched && cur.sitemap_queue.length && visited.size < MAX_SITEMAPS) {
      const sm = cur.sitemap_queue.shift()!;
      const key = normalizeUrl(sm);
      if (visited.has(key)) continue;
      visited.add(key);
      if (!(await waitTurn(ctx, cur))) {
        visited.delete(key);
        cur.sitemap_queue.unshift(sm);
        cur.sitemap_visited = [...visited];
        return { done: false };
      }
      fetched = true;
      let resp: Fetched;
      try {
        resp = await get(cur, sm);
      } catch {
        continue;
      }
      const final = normalizeUrl(resp.url);
      if (resp.status !== 200) continue;
      if (final !== key && visited.has(final)) continue; // e.g. /sitemap.xml redirecting to an index already read
      visited.add(final);
      const parsed = await parseSitemap(sm, resp.body);
      if (!parsed) continue; // not XML (e.g. HTML 404 page)
      if (parsed.kind === "sitemapindex") {
        cur.sitemap_queue.push(...parsed.locs.slice(0, 2 * MAX_SITEMAPS));
      } else if (parsed.kind === "urlset") {
        ctx.log(`Sitemap ${sm}: ${parsed.locs.length} URLs`);
        const seeds = parsed.locs.map(normalizeUrl).filter(allowedUrl);
        cur.seeds += seeds.length;
        await enqueueUrls(env, jobId, cur, seeds);
      }
    }
    cur.sitemap_visited = [...visited];
    if (cur.sitemap_queue.length && visited.size < MAX_SITEMAPS) return { done: false };
    cur.follow_links = cur.seeds === 0;
    cur.used_sitemap = cur.seeds > 0;
    ctx.log(cur.seeds ? `Found ${cur.seeds} pages in sitemaps` : "No usable sitemap; following links from the start page");
    cur.sitemap_queue = [];
    cur.phase = "crawl";
    return { done: false };
  }

  // ------------------------------------------------------------------ crawl
  if (cur.phase === "crawl") {
    const embedding = (await getSetting(env.DB, "embedding")) || {};
    const embedder = await getEmbedder(env, embedding);
    for (let n = 0; n < PAGES_PER_STEP; n++) {
      if (cur.index) {
        const page = await first<{ content: string }>(env.DB, "SELECT content FROM pages WHERE id = ?", cur.index.cursor.src.page_id);
        const outcome = await indexStep(env, embedder, cur.index.cursor, page?.content ?? "");
        if (!outcome.done) return { done: false };
        cur.stats.chunks += outcome.chunks;
        ctx.log(`Indexed ${cur.index.url}`);
        cur.index = null;
        break; // indexing was this step's work
      }
      if (ctx.cancelRequested) {
        cur.phase = "finish";
        break;
      }
      const next = await first<{ url: string }>(env.DB, "SELECT url FROM crawl_frontier WHERE job_id = ? AND state = ? ORDER BY seq LIMIT 1", jobId, QUEUED);
      if (!next) {
        cur.phase = "finish";
        break;
      }
      if (cur.pages + cur.failed >= cur.config.max_pages) {
        cur.hit_limit = true;
        cur.phase = "finish";
        break;
      }
      if (!(await waitTurn(ctx, cur))) return { done: false };
      const indexed = await crawlOne(ctx, client, cur, next.url, embedder);
      if (indexed === "pending") return { done: false };
      if (indexed) break; // one indexed page per step keeps the step small
    }
    if (cur.phase !== "finish") return { done: false };
  }

  // ------------------------------------------------------------------ finish
  if (cur.index) return { done: false }; // can't happen: the page in progress finishes first
  // Remove pages that are gone (404/410), and — after a complete crawl — pages no longer linked/listed.
  const complete = !cur.hit_limit && !cur.truncated && !ctx.cancelRequested;
  const doomed = await all<{ id: number }>(
    env.DB,
    "SELECT id FROM pages WHERE client_id = ? AND (url IN (SELECT url FROM crawl_frontier WHERE job_id = ? AND state = ?) " +
      "OR (? AND url NOT IN (SELECT url FROM crawl_frontier WHERE job_id = ? AND state = ?)))",
    client.id, jobId, GONE, complete ? 1 : 0, jobId, SEEN,
  );
  for (const { id } of doomed) {
    const ids = await chunkIds(env.DB, "page_id = ?", id);
    await run(env.DB, "DELETE FROM pages WHERE id = ?", id); // chunks go by ON DELETE CASCADE
    await deleteVectors(env.VECTORIZE, ids);
    cur.stats.removed++;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE clients SET last_crawl_at = ? WHERE id = ?").bind(nowIso(), client.id),
    env.DB.prepare("DELETE FROM crawl_frontier WHERE job_id = ?").bind(jobId),
  ]);
  const s = cur.stats;
  ctx.log(
    `Crawl done: ${s.new} new, ${s.updated} updated, ${s.unchanged} unchanged, ${s.removed} removed, ${cur.failed} failed` +
      (cur.hit_limit ? " (page limit reached)" : ""),
  );
  return {
    done: true,
    result: { ...s, pages_crawled: cur.pages, failed: cur.failed, hit_limit: cur.hit_limit, used_sitemap: cur.used_sitemap, errors: cur.errors.slice(0, MAX_ERRORS_KEPT) },
  };
}

/** Fetch one frontier URL; true when it was indexed this step, "pending" when indexing continues next step. */
async function crawlOne(ctx: StepContext, client: Client, cur: CrawlCursor, url: string, embedder: Awaited<ReturnType<typeof getEmbedder>>): Promise<boolean | "pending"> {
  const env = ctx.env;
  const jobId = ctx.job.id;
  const fail = async (state: number, error?: string) => {
    if (error) {
      cur.failed++;
      if (cur.errors.length < MAX_ERRORS_KEPT) cur.errors.push(error);
    }
    await markStmt(env, jobId, cur, url, state).run();
    return false;
  };
  let resp: Fetched;
  try {
    resp = await get(cur, url);
  } catch (exc) {
    return fail(SKIPPED, `${url}: ${exc instanceof FetchError ? exc.kind : (exc as Error).name}`);
  }
  if (resp.status === 404 || resp.status === 410) return fail(GONE);
  const finalUrl = normalizeUrl(resp.url);
  const html = resp.status === 200 && resp.contentType.toLowerCase().includes("html");
  if (!html) return fail(SKIPPED, resp.status !== 200 ? `${url}: HTTP ${resp.status}` : undefined);
  if (!sameSite(cur.site, finalUrl)) return fail(SKIPPED); // redirected off-site
  const extracted = extract(decodeBody(resp), finalUrl, cur.config.extraction);
  const alreadyDone = finalUrl !== url && Boolean(await first(env.DB, "SELECT 1 FROM crawl_frontier WHERE job_id = ? AND url = ? AND state = ?", jobId, finalUrl, SEEN));
  await env.DB.batch([markStmt(env, jobId, cur, url, SEEN), ...(finalUrl !== url ? [markStmt(env, jobId, cur, finalUrl, SEEN)] : [])]);
  if (alreadyDone) return false;
  let indexed: boolean | "pending" = false;
  if (extracted.text.trim()) {
    cur.pages++;
    indexed = await onPage(ctx, client, cur, finalUrl, extracted.title, extracted.text, embedder);
  }
  if (cur.follow_links) {
    const links = extracted.links.map(normalizeUrl).filter((l) => allowed(cur.config, cur.site, cur.robots, l));
    await enqueueUrls(env, jobId, cur, links);
  }
  const done = cur.pages + cur.failed;
  const total = Math.min(cur.config.max_pages, cur.queued);
  ctx.progress((done * 100) / Math.max(total, 1), `${done} of ${total} pages · ${finalUrl}`);
  return indexed;
}

/** New/changed page: store and index it; unchanged: just note it was seen. */
async function onPage(ctx: StepContext, client: Client, cur: CrawlCursor, url: string, title: string, text: string, embedder: Awaited<ReturnType<typeof getEmbedder>>): Promise<boolean | "pending"> {
  const db = ctx.env.DB;
  const contentHash = await sha256Hex(title + "\n" + text);
  const page = await first<{ id: number; content_hash: string }>(db, "SELECT id, content_hash FROM pages WHERE client_id = ? AND url = ?", client.id, url);
  const now = nowIso();
  if (page && page.content_hash === contentHash) {
    await run(db, "UPDATE pages SET crawled_at = ? WHERE id = ?", now, page.id);
    cur.stats.unchanged++;
    return false;
  }
  const row = await first<{ id: number }>(
    db,
    "INSERT INTO pages (client_id, url, title, content, content_hash, crawled_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (client_id, url) DO UPDATE SET title = excluded.title, content = excluded.content, content_hash = excluded.content_hash, crawled_at = excluded.crawled_at RETURNING id",
    client.id, url, title, text, contentHash, now,
  );
  if (page) cur.stats.updated++;
  else cur.stats.new++;
  const cursor = newIndexCursor({ client_id: client.id, source_type: "web", source: url, title, page_id: row!.id, document_id: null });
  const outcome = await indexStep(ctx.env, embedder, cursor, text);
  if (!outcome.done) {
    cur.index = { cursor, url };
    return "pending";
  }
  cur.stats.chunks += outcome.chunks;
  ctx.log(`Indexed ${url}`);
  return true;
}

/** Re-index one stored page from its saved text (no network). Returns chunks, or null while it continues. */
export async function reindexPageStep(env: Env, embedder: Awaited<ReturnType<typeof getEmbedder>>, cursor: IndexCursor): Promise<number | null> {
  const page = await first<{ content: string }>(env.DB, "SELECT content FROM pages WHERE id = ?", cursor.src.page_id);
  if (!page) return 0;
  const outcome = await indexStep(env, embedder, cursor, page.content);
  return outcome.done ? outcome.chunks : null;
}
