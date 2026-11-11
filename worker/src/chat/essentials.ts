/**
 * A client's essential pages (opening hours, contact, about, location), always given to the assistant.
 *
 * Vague questions like "is it open now?" or "how do I reach you?" don't always match these pages
 * in search, so the assistant gets them every time, found automatically by page title or URL.
 */

import { all } from "../util/db";

// The Postgres regular expressions as case-insensitive LIKE patterns (SQLite's LIKE ignores ASCII case):
// timing|opening|hours|contact|about|location|find[ -]us|direction|reach[ -]us|visit[ -]us
const ESSENTIAL_WORDS = ["timing", "opening", "hours", "contact", "about", "location", "find us", "find-us", "direction", "reach us", "reach-us", "visit us", "visit-us"];
const FIRST_WORDS = ["timing", "opening", "hours"]; // ordered first
const SECOND_WORDS = ["contact", "reach", "find"]; // then these
const MAX_PAGES = 4;
const MAX_CHARS_PER_PAGE = 1200;
const MAX_TOTAL_CHARS = 3500;

function likeAny(expr: string, words: string[]): string {
  return "(" + words.map((w) => `${expr} LIKE '%${w}%'`).join(" OR ") + ")";
}

/** Opening-hours pages first, then contact, then about/location; trimmed to a small total. */
export async function essentialPages(db: D1Database, clientId: number): Promise<string> {
  const both = "(coalesce(title, '') || ' ' || url)";
  const rows = await all<{ title: string | null; url: string; content: string }>(
    db,
    "SELECT title, url, content FROM pages WHERE client_id = ? AND content <> '' " +
      `AND (${likeAny("coalesce(title, '')", ESSENTIAL_WORDS)} OR ${likeAny("url", ESSENTIAL_WORDS)}) ` +
      `ORDER BY CASE WHEN ${likeAny(both, FIRST_WORDS)} THEN 0 WHEN ${likeAny(both, SECOND_WORDS)} THEN 1 ELSE 2 END, length(content) LIMIT ?`,
    clientId,
    MAX_PAGES,
  );
  const blocks: string[] = [];
  let used = 0;
  for (const { title, url, content } of rows) {
    const body = content.trim().slice(0, MAX_CHARS_PER_PAGE);
    const block = `From "${title || url}":\n${body}`;
    if (used + block.length > MAX_TOTAL_CHARS && blocks.length) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join("\n\n");
}

/** The admin's own key information plus the essential pages. */
export async function keyInformation(db: D1Database, clientId: number, keyFacts: string): Promise<string> {
  return [keyFacts.trim(), await essentialPages(db, clientId)].filter(Boolean).join("\n\n");
}

const MAX_DIRECTORY_CHARS = 6000;

/**
 * Names of all the client's pages (e.g. every shop), for "which shops sell …?" questions.
 *
 * A shop's page often doesn't say what it sells ("the latest gear to take on sports"), so
 * search alone misses it; with the full list the assistant can pick the matching ones.
 */
export async function pageDirectory(db: D1Database, clientId: number): Promise<string> {
  const rows = await all<{ title: string | null }>(db, "SELECT title FROM pages WHERE client_id = ? AND title <> ''", clientId);
  const titles = rows.map((r) => r.title).filter((t): t is string => Boolean(t)).map((t) => t.trim());
  if (titles.length < 3) return "";
  // Drop the site name most titles end with ("NIKE - Lulu Malls" -> "NIKE").
  const suffixes = new Map<string, number>();
  for (const title of titles) {
    for (const sep of [" - ", " | ", " – "]) {
      if (title.includes(sep)) {
        const key = sep + title.slice(title.lastIndexOf(sep) + sep.length);
        suffixes.set(key, (suffixes.get(key) || 0) + 1);
      }
    }
  }
  let common = "";
  let best = -1;
  for (const [k, n] of suffixes) {
    if (n > best) {
      common = k;
      best = n;
    }
  }
  if (common && best < titles.length / 2) common = "";
  const names = [...new Set(titles.map((t) => (common && t.endsWith(common) ? t.slice(0, -common.length) : t)))];
  names.sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const listing = names.join(", ");
  if (listing.length <= MAX_DIRECTORY_CHARS) return listing;
  const cut = listing.slice(0, MAX_DIRECTORY_CHARS);
  const i = cut.lastIndexOf(", ");
  return (i >= 0 ? cut.slice(0, i) : cut) + ", …";
}
