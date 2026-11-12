/**
 * JavaScript-built pages (React, Vue, Angular, … apps that send an empty <div id="root">) are opened
 * in Cloudflare Browser Rendering (the BROWSER binding), so the crawler reads what visitors see.
 *
 * One browser session is kept for the whole crawl (its id lives in the crawl cursor) and re-joined
 * by each job step; it closes itself after KEEP_ALIVE_MS without use, or at the end of the crawl.
 */

import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../env";
import type { Extracted, PageImage } from "./rules";

const KEEP_ALIVE_MS = 120_000;
const NAVIGATION_TIMEOUT_MS = 25_000;
const MIN_OWN_TEXT_CHARS = 300;
const MAX_IMAGES = 40;
// The empty mount point of a single-page app: <div id="root"></div>, <div id="app"></div>, …
const APP_SHELL_RE = /<div[^>]*\bid=["'](?:root|app|__next|__nuxt|svelte|main-app)["'][^>]*>\s*<\/div>/i;

/** The browser's daily allowance (or concurrency limit) is used up: stop rendering for this crawl. */
export class RenderLimit extends Error {}

export interface Rendered {
  html: string;
  images: PageImage[];
}

/** True when the plain HTML hardly has any text of its own, or is an app shell filled by JavaScript. */
export function needsRendering(html: string, extracted: Extracted): boolean {
  return (extracted.bodyChars ?? extracted.text.length) < MIN_OWN_TEXT_CHARS || APP_SHELL_RE.test(html);
}

function isLimit(exc: unknown): boolean {
  return /429|limit|quota|too many|rate/i.test(String((exc as Error)?.message ?? exc));
}

// Runs in the page: loaded pictures big enough to be content (not icons), plus CSS background
// pictures of large blocks (banners, hero images). Passed as a string: the Worker has no DOM types.
const COLLECT_IMAGES = `(() => {
  const out = [];
  for (const img of Array.from(document.images)) {
    const src = img.currentSrc || img.src;
    if (src && img.naturalWidth >= 100 && img.naturalHeight >= 60) out.push({ url: src, alt: (img.alt || "").trim() });
  }
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (el.offsetWidth < 300 || el.offsetHeight < 150) continue;
    const m = /url\\(["']?([^"')]+)["']?\\)/.exec(getComputedStyle(el).backgroundImage || "");
    if (m) out.push({ url: new URL(m[1], location.href).href, alt: "" });
  }
  return out;
})()`;

// Runs in the page: apps often lay out <span>s and <div>s as blocks with CSS, which the HTML alone
// doesn't show ("Project Reports" + "Know your business" would read "Project ReportsKnow your …").
// A space before and after every element the browser shows as a block keeps the words apart
// (also "<strong>Title</strong><p>Text</p>": inline text followed by a block).
const SEPARATE_BLOCKS = `(() => {
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const d = getComputedStyle(el).display;
    if (d && d !== "inline" && d !== "contents" && d !== "none" && el.parentNode && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName)) {
      el.before(document.createTextNode(" "));
      el.after(document.createTextNode(" "));
    }
  }
})()`;

/** Open the page in the browser and return its HTML after scripts ran. ``session.id`` is reused and updated. */
export async function renderPage(env: Env, url: string, session: { id: string | null }): Promise<Rendered> {
  if (!env.BROWSER) throw new Error("Browser Rendering is not set up (no BROWSER binding).");
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  if (session.id) {
    try {
      browser = await puppeteer.connect(env.BROWSER, session.id);
    } catch {
      browser = null; // the session timed out or is busy: start a new one
    }
  }
  if (!browser) {
    try {
      browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
    } catch (exc) {
      if (isLimit(exc)) throw new RenderLimit(String((exc as Error)?.message ?? exc));
      throw exc;
    }
    session.id = browser.sessionId();
  }
  const page = await browser.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (exc) {
      // Pages that keep a connection open never go idle: read what has loaded by now.
      if (!/timeout/i.test(String((exc as Error)?.message ?? exc))) throw exc;
    }
    // Scroll to the end so pictures and sections that load on scroll appear, then give them a moment.
    await page.evaluate("window.scrollTo(0, document.body ? document.body.scrollHeight : 0)");
    await new Promise((r) => setTimeout(r, 800));
    let images: PageImage[] = [];
    try {
      const found = (await page.evaluate(COLLECT_IMAGES)) as PageImage[];
      const seen = new Set<string>();
      images = found.filter((i) => /^https?:\/\//i.test(i.url) && !seen.has(i.url) && seen.add(i.url)).slice(0, MAX_IMAGES);
    } catch {
      images = [];
    }
    await page.evaluate(SEPARATE_BLOCKS).catch(() => {});
    const html = await page.content();
    return { html, images };
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

/** End the crawl's browser session (best effort: it also closes by itself when idle). */
export async function closeSession(env: Env, id: string | null): Promise<void> {
  if (!id || !env.BROWSER) return;
  try {
    const browser = await puppeteer.connect(env.BROWSER, id);
    await browser.close();
  } catch {
    // already gone
  }
}
