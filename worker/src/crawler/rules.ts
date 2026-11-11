/** Extraction rules shared by the streaming (HTMLRewriter) and DOM extractors, ported from app/crawler/extract.py. */

import { splitlines, strip } from "../util/pyurl";

// Elements that never contain page content.
export const DROP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "form", "button", "select", "textarea", "header", "nav", "footer", "aside"]);
const DROP_ROLES = new Set(["navigation", "banner", "contentinfo", "dialog"]);
// Page builders (Elementor, Divi, ...) mark their global header/footer templates.
const DROP_ELEMENTOR = new Set(["header", "footer", "popup"]);

export interface DropAttrs {
  role?: string | null;
  ariaHidden?: string | null;
  elementor?: string | null;
  cls?: string | null;
  id?: string | null;
}

/** The _DROP_XPATH test for one element. */
export function isDropped(tag: string, a: DropAttrs): boolean {
  if (DROP_TAGS.has(tag)) return true;
  if (a.role && DROP_ROLES.has(a.role)) return true;
  if (a.ariaHidden === "true") return true;
  if (a.elementor && DROP_ELEMENTOR.has(a.elementor)) return true;
  if (a.cls !== null && a.cls !== undefined) {
    if ((" " + a.cls.trim().split(/[ \t\n\r\f]+/).join(" ") + " ").includes(" screen-reader-text ")) return true;
    if (a.cls.includes("cookie")) return true;
  }
  if (a.id && a.id.includes("cookie")) return true;
  return false;
}

export const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "li", "ul", "ol", "dl", "dt", "dd", "table", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "address", "figure", "figcaption", "br", "hr",
]);
const SKIP_LINES = new Set(["skip to main content", "skip to content", "menu", "close", "search"]);
// Call-to-action link labels ("Know More »", "View Store ›", "Read more →") carry no facts
// and interleave with real content (e.g. between every movie title).
const CTA_RE = /^(?:read|know|learn|view|see|show|find out|discover|explore)(?: [\p{L}\p{N}_]+){0,2}\s*[»›→>]*$|^.{0,30}\s[»›→]$/iu;

// What an icon next to a detail means (Font Awesome, Elementor, Material, Bootstrap icon names).
export const ICON_LABELS: [RegExp, string][] = [
  [/phone|mobile|whatsapp|\btel\b|call/i, "Phone"],
  [/envelope|\bmail|email|inbox/i, "Email"],
  [/clock|\btime\b|hours|schedule/i, "Opening hours"],
  [/map-marker|map-pin|location|\baddress\b|place/i, "Address"],
];
export const LABEL_WORDS = /\b(?:phone|tel|mobile|call|email|e-mail|mail|hours|timings?|open|address|located)\b/i;
export const ICON_ITEM_TAGS = new Set(["li", "p", "dd", "td"]);
export const MAX_TEXT_CHARS = 200_000;

export function iconLabel(names: string): string | null {
  for (const [pattern, label] of ICON_LABELS) if (pattern.test(names)) return label;
  return null;
}

/** Cloudflare "email protection" hides addresses as XOR-ed hex; browsers decode it with JavaScript. */
export function decodeCfEmail(hexed: string): string | null {
  const hex = (s: string) => (/^[0-9a-fA-F]{1,2}$/.test(s) ? parseInt(s, 16) : NaN);
  const key = hex(hexed.slice(0, 2));
  if (Number.isNaN(key)) return null;
  let out = "";
  for (let i = 2; i < hexed.length; i += 2) {
    const v = hex(hexed.slice(i, i + 2));
    if (Number.isNaN(v)) return null;
    out += String.fromCharCode(v ^ key);
  }
  return out;
}

export function isNoise(line: string): boolean {
  if (SKIP_LINES.has(line.toLowerCase())) return true;
  return line.split(/\s+/).filter(Boolean).length <= 4 && CTA_RE.test(line) && !/\p{Nd}/u.test(line);
}

/** text_content → clean lines (whitespace collapsed, " |" trimmed, noise removed). */
export function cleanLines(textContent: string): string {
  const lines: string[] = [];
  for (const raw of splitlines(textContent)) {
    const line = strip(raw.replace(/\s+/g, " "), " |");
    if (line && !isNoise(line)) lines.push(line);
  }
  return lines.join("\n");
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Link hrefs that are followed: not fragments, mail, phone or script links. */
export function followable(href: string): boolean {
  return Boolean(href) && !(href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:"));
}

export interface Extracted {
  title: string;
  text: string;
  links: string[];
}

/** The page's own summary: often the only text a JavaScript-built site sends to non-browsers. */
export function withDescription(text: string, description: string): string {
  if (description && !text.toLowerCase().includes(description.toLowerCase())) return `${description}\n${text}`.trim();
  return text;
}
