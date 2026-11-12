// Reading "everything" on a website: header/footer on the start page, pictures (Workers AI reads
// them, cached in KV), linked PDF/Word/Excel files, and the test for JavaScript-built pages.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extract } from "../src/crawler/extract";
import { candidateImages, plainText } from "../src/crawler/images";
import { needsRendering } from "../src/crawler/render";
import { hasText } from "../src/documents/service";
import { createClient } from "../src/services/clients";
import * as jobService from "../src/services/jobs";
import { all, run } from "../src/util/db";
import { runJobs } from "../src/worker/runner";
import "../src/worker/handlers";
import { resetDb, routeFetch, testEnv } from "./fakes";

const SITE = "https://www.shop.test";
const BANNER = "BANNER: Call 0484 4061110 for a free consultation. ".repeat(80); // > 3 KB, like a real picture

describe("extraction for reading everything", () => {
  const html =
    "<html><head><title>Home</title></head><body>" +
    "<header><img src='/logo.png' alt='Logo'><nav><img src='/nav-icon.png'></nav></header>" +
    "<main><h1>Welcome</h1><p>We help businesses.</p>" +
    "<img src='/banner.jpg' alt='Office'><img data-src='/lazy.webp' src='data:image/gif;base64,R0lGOD'>" +
    "<img srcset='/small.jpg 320w, /large.jpg 1280w'><img src='/banner.jpg'></main>" +
    "<footer>Phone: 0484 4061110 · mail@taxlead.in</footer></body></html>";

  it("keeps the header and footer only when asked (the start page)", () => {
    expect(extract(html, SITE + "/").text).not.toContain("mail@taxlead.in");
    expect(extract(html, SITE + "/", "auto", { keepChrome: true }).text).toContain("Phone: 0484 4061110 · mail@taxlead.in");
  });

  it("collects content pictures: lazy-loaded, srcset, de-duplicated, not from the dropped navigation", () => {
    const images = extract(html, SITE + "/").images!;
    expect(images).toEqual([
      { url: SITE + "/banner.jpg", alt: "Office" },
      { url: SITE + "/lazy.webp", alt: "" },
      { url: SITE + "/large.jpg", alt: "" },
    ]);
    expect(extract(html, SITE + "/", "auto", { keepChrome: true }).images!.map((i) => i.url)).toContain(SITE + "/logo.png");
  });

  it("skips icons and vector graphics", () => {
    const list = candidateImages([
      { url: SITE + "/a.svg", alt: "" }, { url: SITE + "/favicon-32.png", alt: "" }, { url: SITE + "/anim.gif", alt: "" },
      { url: "data:image/png;base64,xx", alt: "" }, { url: SITE + "/photo.jpg", alt: "" }, { url: SITE + "/photo.jpg", alt: "" },
    ], 10);
    expect(list.map((i) => i.url)).toEqual([SITE + "/photo.jpg"]);
    // Logos say nothing useful and their descriptions are long: skipped by file name or alt text.
    expect(candidateImages([{ url: SITE + "/assets/logo-A2Br.webp", alt: "Taxlead" }, { url: SITE + "/x.png", alt: "Company logo" }], 10)).toEqual([]);
  });

  it("treats a PDF of page markers only as having no text (scanned pages)", () => {
    expect(hasText("[Page 1]\n\n\n[Page 2]\n\n[Page 3]")).toBe(false);
    expect(hasText("[Page 1]\nFees from Rs 999")).toBe(true);
  });

  it("turns the AI's markdown description into one plain line", () => {
    expect(plainText("### Image Overview\nA poster. The text reads **\"Call 0484 4061110\"**.\n* **Colours:** teal")).toBe('Image Overview A poster. The text reads "Call 0484 4061110". Colours: teal');
  });

  it("recognises JavaScript-built pages", () => {
    const shell = "<html><head><title>App</title><meta name='description' content='A long description of the company that is all a crawler sees.'></head><body><div id=\"root\"></div><script type=module src=/main.js></script></body></html>";
    expect(needsRendering(shell, extract(shell, SITE + "/"))).toBe(true);
    const real = `<html><body><main><p>${"Real content. ".repeat(40)}</p></main></body></html>`;
    expect(needsRendering(real, extract(real, SITE + "/"))).toBe(false);
  });
});

describe("crawl reads pictures and linked documents", () => {
  let restore = () => {};
  beforeEach(resetDb);
  afterEach(() => restore());

  function serve() {
    return routeFetch((url) => {
      const path = url.pathname;
      if (path === "/robots.txt") return new Response("User-agent: *\n", { headers: { "content-type": "text/plain" } });
      if (path === "/") {
        return new Response(
          "<html><head><title>Home</title></head><body><main><h1>Home</h1><p>Tax and business services in Kochi.</p>" +
            "<img src='/banner.png' alt='Offer'><a href='/brochure.pdf'>Brochure</a></main>" +
            "<footer>Email: mail@taxlead.in</footer></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (path === "/banner.png") return new Response(BANNER, { headers: { "content-type": "image/png" } });
      if (path === "/brochure.pdf") return new Response("%PDF-1.7\nOur fees: GST filing from Rs 999 a month.", { headers: { "content-type": "application/pdf" } });
      return undefined;
    });
  }

  async function crawl(env: ReturnType<typeof testEnv>, clientId?: number) {
    const client = clientId ? { id: clientId } : await createClient(env.DB, "shop", "Shop", SITE + "/");
    await run(env.DB, "UPDATE clients SET crawl_settings = ? WHERE id = ?", JSON.stringify({ max_pages: 50, delay_seconds: 0, include_patterns: [], exclude_patterns: [] }), client.id);
    const job = await jobService.enqueue(env.DB, "crawl", client.id);
    for (let i = 0; i < 100; i++) {
      const current = (await jobService.getJob(env.DB, job.id))!;
      if (!["queued", "running"].includes(current.status)) break;
      await runJobs(env, 1);
    }
    const done = (await jobService.getJob(env.DB, job.id))!;
    const pages = await all<{ url: string; title: string; content: string }>(env.DB, "SELECT url, title, content FROM pages WHERE client_id = ? ORDER BY url", client.id);
    return { job: done, pages, clientId: client.id };
  }

  it("adds what pictures say, keeps the start page footer, reads the linked PDF, and caches pictures", async () => {
    const fake = serve();
    restore = fake.restore;
    const env = testEnv(); // no BROWSER binding: pages are read without JavaScript
    const first = await crawl(env);
    expect(first.job.status).toBe("succeeded");
    const home = first.pages.find((p) => p.url === SITE + "/")!;
    expect(home.content).toContain("Email: mail@taxlead.in");
    expect(home.content).toContain("Pictures on this page:\n- Offer: BANNER: Call 0484 4061110");
    const pdf = first.pages.find((p) => p.url === SITE + "/brochure.pdf")!;
    expect(pdf.title).toBe("brochure");
    expect(pdf.content).toContain("GST filing from Rs 999 a month.");
    expect(first.job.result).toMatchObject({ images_read: 1, documents: 1 });

    // A re-crawl uses the remembered picture text: the picture isn't downloaded again.
    const before = fake.seen.filter((u) => u.endsWith("/banner.png")).length;
    const second = await crawl(env, first.clientId);
    expect(second.job.status).toBe("succeeded");
    expect(fake.seen.filter((u) => u.endsWith("/banner.png")).length).toBe(before);
    expect(second.pages.find((p) => p.url === SITE + "/")!.content).toContain("Call 0484 4061110");
  });

  it("can be switched off", async () => {
    const fake = serve();
    restore = fake.restore;
    const env = testEnv();
    const client = await createClient(env.DB, "shop", "Shop", SITE + "/");
    await run(env.DB, "UPDATE clients SET crawl_settings = ? WHERE id = ?", JSON.stringify({ max_pages: 50, delay_seconds: 0, include_patterns: [], exclude_patterns: [], read_images: false, read_documents: false }), client.id);
    const job = await jobService.enqueue(env.DB, "crawl", client.id);
    for (let i = 0; i < 100; i++) {
      const current = (await jobService.getJob(env.DB, job.id))!;
      if (!["queued", "running"].includes(current.status)) break;
      await runJobs(env, 1);
    }
    const pages = await all<{ url: string; content: string }>(env.DB, "SELECT url, content FROM pages WHERE client_id = ?", client.id);
    expect(pages.map((p) => p.url)).toEqual([SITE + "/"]);
    expect(pages[0].content).not.toContain("Pictures on this page");
    expect(fake.seen.some((u) => u.endsWith("/banner.png") || u.endsWith("/brochure.pdf"))).toBe(false);
  });
});
