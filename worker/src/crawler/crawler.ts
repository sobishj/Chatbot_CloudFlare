/**
 * Polite same-site crawling: URL rules, robots.txt, sitemaps and page fetching.
 *
 * 1. Read robots.txt (respect Disallow and Crawl-delay; collect Sitemap: entries).
 * 2. Try sitemaps (robots.txt entries, /sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml).
 *    If they list pages, crawl those. Otherwise follow internal links from the start URL.
 * 3. Fetch pages one by one with a delay, extract clean text.
 *
 * The crawl itself runs as a resumable job (crawler/service.ts); these helpers know nothing about
 * the database.
 */

import { VERSION } from "../env";
import { fnmatch, hostnameOf, parseQsl, splitlines, urldefrag, urlencode, urlparse, urlunparse } from "../util/pyurl";
import { canFetch, type Robots } from "./robots";

export const USER_AGENT = `WebsiteAssistantBot/${VERSION} (+website assistant crawler)`;
export const SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"];
export const MAX_PAGE_BYTES = 5_000_000;
export const MAX_DOCUMENT_BYTES = 20_000_000;
/** Files linked from the site that are read like uploaded documents (crawl setting read_documents). */
export const DOC_EXTENSIONS = [".pdf", ".docx", ".xlsx"];
export const MAX_SITEMAPS = 200;
export const SKIP_EXTENSIONS = [
  ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".css", ".js", ".json", ".xml", ".zip",
  ".rar", ".gz", ".mp4", ".mp3", ".avi", ".mov", ".webm", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".eot", ".txt", ".csv",
];
const TRACKING_PARAMS = ["utm_", "fbclid", "gclid", "mc_cid", "mc_eid", "_ga"];
const FETCH_TIMEOUT_MS = 20_000;

/** Host without a leading 'www.' — www and bare domain count as the same site. */
export function siteKey(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** Drop fragments and tracking parameters, lower-case the host, keep a stable form. */
export function normalizeUrl(url: string): string {
  const [defrag] = urldefrag(url.trim());
  const p = urlparse(defrag);
  const query = urlencode(parseQsl(p.query, true).filter(([k]) => !TRACKING_PARAMS.some((t) => k.toLowerCase().startsWith(t))));
  return urlunparse({ scheme: p.scheme.toLowerCase(), netloc: (p.netloc || "").toLowerCase(), path: p.path || "/", params: "", query, fragment: "" });
}

/** Wildcard patterns match the URL path (+query), e.g. ``/blog/*`` or ``*?print=*``. */
export function matchesPatterns(url: string, include: string[], exclude: string[]): boolean {
  const p = urlparse(url);
  const target = p.path + (p.query ? `?${p.query}` : "");
  if (include.length && !include.some((pat) => fnmatch(target, pat) || fnmatch(url, pat))) return false;
  return !exclude.some((pat) => fnmatch(target, pat) || fnmatch(url, pat));
}

export interface CrawlConfig {
  start_url: string;
  max_pages: number;
  delay_seconds: number;
  include_patterns: string[];
  exclude_patterns: string[];
  extraction: string; // auto | main_content
  render_js?: string; // auto | always | never: open JavaScript-built pages in a browser
  read_images?: boolean; // describe pictures and read the text in them (Workers AI)
  read_documents?: boolean; // read linked PDF, Word and Excel files
}

/** A linked PDF/Word/Excel file that the crawl reads (when read_documents is on). */
export function isDocumentUrl(url: string): boolean {
  const path = urlparse(url).path.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export function sameSite(site: string, url: string): boolean {
  const p = urlparse(url);
  return (p.scheme === "http" || p.scheme === "https") && siteKey(hostnameOf(p.netloc) || "") === site;
}

export function allowed(config: CrawlConfig, site: string, robots: Robots, url: string): boolean {
  const path = urlparse(url).path.toLowerCase();
  return (
    sameSite(site, url) &&
    (!SKIP_EXTENSIONS.some((ext) => path.endsWith(ext)) || (config.read_documents !== false && isDocumentUrl(url))) &&
    canFetch(robots, USER_AGENT, url) &&
    matchesPatterns(url, config.include_patterns, config.exclude_patterns)
  );
}

/** robots.txt could not be read (server error) — crawling would be impolite. */
export class RobotsBlocked extends Error {}

/** A network failure, named like the httpx exception it replaces (shown in the crawl errors). */
export class FetchError extends Error {
  constructor(public kind: string, message: string) {
    super(message);
  }
}

export interface Fetched {
  status: number;
  url: string; // final URL after redirects
  contentType: string;
  body: Uint8Array;
}

/** GET with redirects followed; the body is cut at MAX_PAGE_BYTES (decompressed by the runtime). */
export async function fetchCapped(url: string, fetcher: typeof fetch = fetch, maxBytes = MAX_PAGE_BYTES): Promise<Fetched> {
  let resp: Response;
  try {
    resp = await fetcher(url, { redirect: "follow", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (exc) {
    const err = exc as Error;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new FetchError("ReadTimeout", String(err.message));
    throw new FetchError("ConnectError", String(err?.message ?? exc));
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (resp.body) {
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          break;
        }
      }
    } catch (exc) {
      throw new FetchError("ReadError", String((exc as Error)?.message ?? exc));
    }
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return { status: resp.status, url: resp.url || url, contentType: resp.headers.get("content-type") || "", body };
}

/** The response text in its declared charset (UTF-8 by default, like httpx). */
export function decodeBody(f: Fetched): string {
  const m = /charset=["']?([\w-]+)/i.exec(f.contentType);
  try {
    return new TextDecoder(m ? m[1] : "utf-8").decode(f.body);
  } catch {
    return new TextDecoder().decode(f.body);
  }
}

/** robots.txt lines and the Sitemap: entries they list. */
export function robotsLines(text: string): { lines: string[]; sitemaps: string[] } {
  const lines = splitlines(text);
  const sitemaps = lines.filter((ln) => ln.toLowerCase().startsWith("sitemap:")).map((ln) => ln.slice(ln.indexOf(":") + 1).trim());
  return { lines, sitemaps };
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1];
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e],
  );
}

/** A sitemap's kind (root element) and <loc> entries; null when it isn't a sitemap (e.g. an HTML 404 page). */
export async function parseSitemap(url: string, data: Uint8Array): Promise<{ kind: string; locs: string[] } | null> {
  let content = data;
  if (url.endsWith(".gz") || (content[0] === 0x1f && content[1] === 0x8b)) {
    try {
      content = await gunzip(content);
    } catch {
      return null;
    }
  }
  const text = new TextDecoder().decode(content);
  // The root element: the first tag that isn't a declaration, comment or processing instruction.
  const root = /<(?![?!])(?:[\w.-]+:)?([\w.-]+)[\s>/]/.exec(text.replace(/<!--[\s\S]*?-->/g, ""));
  if (!root) return null;
  const kind = root[1];
  const locs: string[] = [];
  for (const m of text.matchAll(/<(?:[\w.-]+:)?loc(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?loc>/g)) {
    const value = xmlText(m[1]).trim();
    if (value) locs.push(value);
  }
  return { kind, locs };
}
