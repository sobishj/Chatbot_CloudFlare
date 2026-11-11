// The crawl job end to end (robots, sitemaps, links, limits, gone pages, gzip), as in tests/test_crawler.py,
// run step by step through the job runner against an in-memory website.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchesPatterns, normalizeUrl } from "../src/crawler/crawler";
import { createClient } from "../src/services/clients";
import * as jobService from "../src/services/jobs";
import { runJobs } from "../src/worker/runner";
import "../src/worker/handlers";
import { all, run } from "../src/util/db";
import { page } from "./fixtures/html";
import { resetDb, routeFetch, testEnv } from "./fakes";

const SITE = "https://www.shop.test";
type Site = Record<string, [number, string, string]>;

function serve(site: Site, robots = "User-agent: *\nDisallow: /private/\n", sitemap: string | null = null) {
  return routeFetch((url) => {
    const path = url.pathname + url.search;
    if (path === "/robots.txt") return new Response(robots, { headers: { "content-type": "text/plain" } });
    if (path === "/sitemap.xml" && sitemap !== null) return new Response(sitemap, { headers: { "content-type": "application/xml" } });
    const entry = site[path];
    if (entry) return new Response(entry[2], { status: entry[0], headers: { "content-type": entry[1] } });
    return undefined;
  });
}

async function crawl(env: ReturnType<typeof testEnv>, crawlSettings: Record<string, any> = {}) {
  const client = await createClient(env.DB, "shop", "Shop", SITE + "/");
  await run(env.DB, "UPDATE clients SET crawl_settings = ? WHERE id = ?", JSON.stringify({ max_pages: 500, delay_seconds: 0, include_patterns: [], exclude_patterns: [], ...crawlSettings }), client.id);
  const job = await jobService.enqueue(env.DB, "crawl", client.id);
  for (let i = 0; i < 200; i++) {
    const current = (await jobService.getJob(env.DB, job.id))!;
    if (!["queued", "running"].includes(current.status)) break;
    await runJobs(env, 1);
  }
  const done = (await jobService.getJob(env.DB, job.id))!;
  const pages = await all<{ url: string; title: string; content: string }>(env.DB, "SELECT url, title, content FROM pages WHERE client_id = ? ORDER BY url", client.id);
  return { job: done, pages, client };
}

describe("crawler", () => {
  let restore = () => {};
  beforeEach(resetDb);
  afterEach(() => restore());

  it("follows same-site links only and respects robots.txt", async () => {
    const site: Site = {
      "/": [200, "text/html", page("Home", "<p>Welcome</p>", ["/a/", "/private/secret/", "https://other.test/x", "/file.pdf", "/b/#frag"])],
      "/a/": [200, "text/html", page("A", "<p>Page A</p>", ["/"])],
      "/b/": [200, "text/html", page("B", "<p>Page B</p>")],
      "/private/secret/": [200, "text/html", page("Secret", "<p>no</p>")],
    };
    const fake = serve(site);
    restore = fake.restore;
    const env = testEnv();
    const { job, pages } = await crawl(env);
    expect(job.status).toBe("succeeded");
    expect(pages.map((p) => p.url)).toEqual([SITE + "/", SITE + "/a/", SITE + "/b/"]);
    expect(fake.seen.some((u) => u.includes("/private/secret/"))).toBe(false);
    expect(fake.seen.some((u) => u.includes("other.test"))).toBe(false);
    expect(job.result!.used_sitemap).toBe(false);
    expect(job.result!.new).toBe(3);
    // every page is chunked, with its vectors in the client's namespace
    const chunks = await all<{ id: number }>(env.DB, "SELECT id FROM chunks");
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(env.VECTORIZE.vectors.size).toBe(chunks.length);
    expect(job.log).toContain("No usable sitemap; following links from the start page");
  });

  it("uses the sitemap first", async () => {
    const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>${SITE}/x/</loc></url><url><loc>${SITE}/y/</loc></url></urlset>`;
    const site: Site = {
      "/": [200, "text/html", page("Home", "<p>Home</p>", ["/not-in-sitemap/"])],
      "/x/": [200, "text/html", page("X", "<p>X</p>")],
      "/y/": [200, "text/html", page("Y", "<p>Y</p>")],
      "/not-in-sitemap/": [200, "text/html", page("N", "<p>N</p>")],
    };
    restore = serve(site, undefined, sitemap).restore;
    const { job, pages } = await crawl(testEnv());
    expect(job.result!.used_sitemap).toBe(true);
    expect(pages.map((p) => p.url)).toEqual([SITE + "/", SITE + "/x/", SITE + "/y/"]);
  });

  it("stops at max_pages and records gone pages", async () => {
    const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>${SITE}/gone/</loc></url><url><loc>${SITE}/p1/</loc></url><url><loc>${SITE}/p2/</loc></url></urlset>`;
    const site: Site = { "/": [200, "text/html", page("Home", "<p>H</p>")], "/p1/": [200, "text/html", page("1", "<p>1</p>")], "/p2/": [200, "text/html", page("2", "<p>2</p>")] };
    restore = serve(site, undefined, sitemap).restore;
    const env = testEnv();
    // A page that disappeared from the site is removed at the end of the crawl.
    const first = await crawl(env);
    expect(first.pages.length).toBe(3);
    await run(env.DB, "INSERT INTO pages (client_id, url, title, content, content_hash) VALUES (?, ?, 'Old', 'old text', 'x')", first.client.id, SITE + "/gone/");
    const job2 = await jobService.enqueue(env.DB, "crawl", first.client.id);
    for (let i = 0; i < 100 && ["queued", "running"].includes((await jobService.getJob(env.DB, job2.id))!.status); i++) await runJobs(env, 1);
    const urls = (await all<{ url: string }>(env.DB, "SELECT url FROM pages ORDER BY url")).map((r) => r.url);
    expect(urls).not.toContain(SITE + "/gone/");
    expect((await jobService.getJob(env.DB, job2.id))!.result!.unchanged).toBe(3);

    await resetDb();
    const limited = await crawl(testEnv(), { max_pages: 2 });
    expect(limited.job.result!.hit_limit).toBe(true);
    expect(limited.pages.length).toBeLessThanOrEqual(2);
  });

  it("include/exclude patterns", () => {
    expect(matchesPatterns("https://s.test/shop/asics/", ["/shop/*"], [])).toBe(true);
    expect(matchesPatterns("https://s.test/dine/x/", ["/shop/*"], [])).toBe(false);
    expect(matchesPatterns("https://s.test/shop/x/?print=1", [], ["*?print=*"])).toBe(false);
  });

  it("normalize_url strips tracking parameters and the fragment", () => {
    expect(normalizeUrl("HTTPS://WWW.Shop.test/a?utm_source=x&id=2#top")).toBe("https://www.shop.test/a?id=2");
  });

  it("a robots.txt server error stops the crawl", async () => {
    restore = routeFetch(() => new Response("down", { status: 503 })).restore;
    const { job } = await crawl(testEnv());
    expect(job.status).toBe("failed");
    expect(job.error).toContain("robots.txt returned HTTP 503");
  });

  it("reads gzipped sitemaps", async () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>${SITE}/z/</loc></url></urlset>`;
    const gz = new Uint8Array(await new Response(new Blob([xml]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    restore = routeFetch((url) => {
      if (url.pathname === "/robots.txt") return new Response(`User-agent: *\nDisallow:\nSitemap: ${SITE}/s.xml.gz\n`);
      if (url.pathname === "/s.xml.gz") return new Response(gz, { headers: { "content-type": "application/gzip" } });
      if (url.pathname === "/" || url.pathname === "/z/") return new Response(page("P", `<p>Page ${url.pathname}</p>`), { headers: { "content-type": "text/html; charset=UTF-8" } });
      return undefined;
    }).restore;
    const { job, pages } = await crawl(testEnv());
    expect(job.result!.used_sitemap).toBe(true);
    expect(pages.map((p) => p.url)).toEqual([SITE + "/", SITE + "/z/"]);
    expect(job.result!.failed).toBe(0);
  });

  it("a cancelled crawl keeps its pages and ends without removing unseen ones", async () => {
    const site: Site = { "/": [200, "text/html", page("Home", "<p>Home</p>", ["/a/", "/b/", "/c/"])], "/a/": [200, "text/html", page("A", "<p>A</p>")], "/b/": [200, "text/html", page("B", "<p>B</p>")], "/c/": [200, "text/html", page("C", "<p>C</p>")] };
    restore = serve(site).restore;
    const env = testEnv();
    const client = await createClient(env.DB, "shop", "Shop", SITE + "/");
    await run(env.DB, "UPDATE clients SET crawl_settings = ? WHERE id = ?", JSON.stringify({ delay_seconds: 0 }), client.id);
    await run(env.DB, "INSERT INTO pages (client_id, url, title, content, content_hash) VALUES (?, ?, 'Old', 'x', 'x')", client.id, SITE + "/old/");
    const job = await jobService.enqueue(env.DB, "crawl", client.id);
    for (let i = 0; i < 4; i++) await runJobs(env, 1);
    await jobService.requestCancel(env.DB, (await jobService.getJob(env.DB, job.id))!);
    for (let i = 0; i < 20 && ["queued", "running"].includes((await jobService.getJob(env.DB, job.id))!.status); i++) await runJobs(env, 1);
    const done = (await jobService.getJob(env.DB, job.id))!;
    expect(done.status).toBe("succeeded"); // like the self-hosted crawler: a stopped crawl reports what it did
    expect((await all<{ url: string }>(env.DB, "SELECT url FROM pages")).map((r) => r.url)).toContain(SITE + "/old/");
  });
});
