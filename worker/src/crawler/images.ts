/**
 * Pictures on crawled pages: Workers AI (``env.AI.toMarkdown``) describes each one and writes out
 * the text in it (a phone number on a banner, a price list, opening hours on a poster).
 *
 * What a picture says is cached in KV by its URL for CACHE_DAYS, so re-crawls don't pay for it
 * again. Icons, logos-sized images, SVG and GIF files are skipped.
 */

import type { Env } from "../env";
import { cleanMarkdown } from "../documents/service";
import { sha256Hex } from "../security/crypto";
import type { PageImage } from "./rules";

const CACHE_PREFIX = "cache/image-text/";
const CACHE_DAYS = 60;
const MIN_BYTES = 3_000; // smaller files are icons, bullets and spacers
const MAX_BYTES = 8_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_LINE_CHARS = 800;
// Icons, vector graphics and logos: no facts, and a logo's description is long noise in search.
const SKIP_RE = /\.(?:svg|ico|gif)(?:[?#]|$)|favicon|sprite|spacer|pixel|blank\.|loader|loading|placeholder|logo|brand-?mark/i;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };

export interface ImageBudget {
  /** New pictures that may still be read in this crawl (cached ones are free). */
  left: number;
  /** Stop reading new pictures after this time (ms since epoch), to keep a job step short. */
  deadline: number;
}

/** Pictures worth reading: http(s), not icons or vector graphics, at most ``max``. */
export function candidateImages(images: PageImage[], max: number): PageImage[] {
  const seen = new Set<string>();
  const out: PageImage[] = [];
  for (const img of images) {
    if (!/^https?:\/\//i.test(img.url) || SKIP_RE.test(img.url) || /\blogo\b/i.test(img.alt) || seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
    if (out.length >= max) break;
  }
  return out;
}

/** The description as one plain line: no markdown headings, bold or bullets. */
export function plainText(md: string): string {
  return md
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s*[*-]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function cacheKey(url: string): Promise<string> {
  return CACHE_PREFIX + (await sha256Hex(url));
}

/** What the picture shows and says; "" when it can't be read (cached too, so it isn't retried every crawl). */
async function readOne(env: Env, url: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return "";
  }
  const type = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!resp.ok || !ext) {
    await resp.body?.cancel();
    return "";
  }
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) {
    await resp.body?.cancel();
    return "";
  }
  const data = new Uint8Array(await resp.arrayBuffer());
  if (data.byteLength < MIN_BYTES || data.byteLength > MAX_BYTES) return "";
  const name = `image.${ext}`;
  try {
    let result: any = await env.AI.toMarkdown({ name, blob: new Blob([data], { type }) });
    if (Array.isArray(result)) result = result[0];
    if (!result || result.format === "error") return "";
    return plainText(cleanMarkdown(String(result.data ?? ""), name)).slice(0, MAX_LINE_CHARS);
  } catch {
    return "";
  }
}

/**
 * The "Pictures on this page" section for the page text, or "" when there is nothing to add.
 * Pictures that weren't read (budget or time used up) still contribute their alt text.
 */
export async function describeImages(env: Env, images: PageImage[], budget: ImageBudget, maxPerPage = 10): Promise<{ section: string; read: number }> {
  const lines: string[] = [];
  let read = 0;
  for (const img of candidateImages(images, maxPerPage)) {
    const key = await cacheKey(img.url);
    let text = await env.FILES_KV.get(key);
    if (text === null && budget.left > 0 && Date.now() < budget.deadline) {
      text = await readOne(env, img.url);
      budget.left--;
      read++;
      await env.FILES_KV.put(key, text, { expirationTtl: CACHE_DAYS * 86_400 }).catch(() => {});
    }
    const line = [img.alt, text || ""].filter(Boolean).join(": ");
    if (line && !lines.includes(line)) lines.push(line);
  }
  return { section: lines.length ? "Pictures on this page:\n" + lines.map((l) => `- ${l}`).join("\n") : "", read };
}
