/**
 * HTML → (title, clean text, links).
 *
 * Two extraction modes (per client, Website tab → crawl settings):
 *
 * * ``auto`` (default): structural cleaning. Page chrome (header, nav, footer, aside, scripts,
 *   forms, cookie banners, page-builder header/footer templates) is dropped and ALL remaining text
 *   is kept with line breaks between blocks. High recall: keeps small facts like
 *   "Located on: Second Floor" or opening hours that article extractors drop.
 * * ``main_content``: only the page's main content: its <article> (the one with the most text),
 *   else <main> / role="main", else the block holding the most paragraph text; the same cleaning
 *   rules apply inside it. (The self-hosted version uses trafilatura here; a full article-extraction
 *   library doesn't fit the free plan's CPU limit.)
 *
 * The rules are those of the lxml version (app/crawler/extract.py). The page is read in one pass
 * by a small tokenizer (tokenizer.ts) and kept as text segments in document order, each tagged with
 * the element it belongs to as lxml would see it (an element's .text or .tail); annotations and
 * drops then edit exactly the pieces lxml would have edited. HTML's implied end tags (a <li> closes
 * the previous <li>, a block closes an open <p>) are applied like a browser does.
 */

import { urljoin } from "../util/pyurl";
import {
  BLOCK_TAGS,
  cleanLines,
  collapse,
  decodeCfEmail,
  followable,
  ICON_ITEM_TAGS,
  iconLabel,
  isDropped,
  LABEL_WORDS,
  MAX_TEXT_CHARS,
  withDescription,
  type Extracted,
} from "./rules";
import { tokenize } from "./tokenizer";

export type { Extracted } from "./rules";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen", "frame", "basefont", "bgsound", "command", "image"]);
// Start tags that close an open <p> (HTML tree construction: "close a p element").
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "dd", "dt", "listing", "main", "menu", "nav", "ol", "p",
  "plaintext", "pre", "section", "summary", "table", "ul", "xmp",
]);
const P_SCOPE = new Set(["html", "table", "td", "th", "caption", "marquee", "object", "applet", "template", "button"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const TABLE_END_TAGS = new Set(["table", "caption", "tbody", "thead", "tfoot", "tr", "td", "th"]);
const TABLE_ONLY = new Set(["table", "html"]);
const HTML_ONLY = new Set(["html"]);
const FOREIGN = new Set(["svg", "math"]);
const PARAGRAPH_TAGS = new Set(["p", "pre", "blockquote"]);
const MIN_MAIN_CHARS = 200;

interface Seg {
  t: string;
  owner: number; // preorder index of the element whose .text (kind 0) or .tail (kind 1) this is
  kind: 0 | 1 | 2; // 2 = block break added after an element (not part of the text the annotations see)
  dropped: boolean;
  head: boolean;
  link: boolean; // inside <a> (main-content scoring)
  td?: boolean; // break after td/th: strip leading newlines of the tail that follows
}

interface PendingIcon {
  label: string;
  level: number; // which of the icon's ancestors this frame is (0 = parent)
}

interface Frame {
  idx: number;
  tag: string;
  role: string | null;
  parent: Frame | null;
  startSeg: number; // index of this element's own (.text) placeholder segment
  endSeg: number; // segment index after its content (set when closed)
  dropped: boolean; // this element or an ancestor is dropped
  head: boolean; // inside <head>/<title>: not part of the body text
  link: boolean;
  foreign: boolean; // inside <svg>/<math>, where "/>" closes an element
  suppress: boolean; // content replaced (Cloudflare-protected email)
  closed: boolean;
  aLabel: string | null; // "Phone"/"Email" for tel:/mailto:/protected-email links
  aNeedsText: boolean;
  icons: PendingIcon[];
  pText: number; // text in direct paragraph children (main-content scoring)
}

class Builder {
  segs: Seg[] = [];
  stack: Frame[] = [];
  frames: Frame[] = [];
  counter = 0;
  owner = -1;
  kind: 0 | 1 = 0;
  suppressDepth = 0;
  ogTitle: string[] = [];
  titleTexts: string[] = [];
  h1Texts: string[] = [];
  descriptions: string[] = [];
  ogDescriptions: string[] = [];
  hrefs: string[] = [];
  baseHref: string | null = null;
  inTitle = 0;
  inH1 = 0;
  keepChrome = false;
  images: { src: string; alt: string }[] = [];

  top(): Frame | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  text(text: string): void {
    if (!text) return;
    if (this.inTitle) this.titleTexts.push(text);
    if (this.inH1) this.h1Texts.push(text);
    if (this.suppressDepth) return;
    const top = this.top();
    this.segs.push({ t: text, owner: this.owner, kind: this.kind, dropped: top ? top.dropped : false, head: top ? top.head : false, link: top ? top.link : false });
  }

  start(tag: string, attrs: Map<string, string>, selfClosing: boolean): void {
    if (tag === "meta") this.meta(attrs);
    if (tag === "base" && this.baseHref === null && attrs.has("href")) this.baseHref = attrs.get("href")!;
    if (tag === "a" && attrs.has("href")) this.hrefs.push(attrs.get("href")!);
    this.impliedCloses(tag);
    const parent = this.top();
    const idx = this.counter++;
    const cls = attrs.get("class") ?? null;
    const role = attrs.get("role") ?? null;
    const dropped = (parent?.dropped ?? false) || isDropped(tag, { role, ariaHidden: attrs.get("aria-hidden"), elementor: attrs.get("data-elementor-type"), cls, id: attrs.get("id") }, this.keepChrome);
    if (tag === "img" && !dropped) {
      const src = imageSrc(attrs);
      if (src) this.images.push({ src, alt: collapse(attrs.get("alt") ?? "").trim() });
    }
    const head = (parent?.head ?? false) || tag === "head" || tag === "title";
    const link = (parent?.link ?? false) || tag === "a";
    const foreign = (parent?.foreign ?? false) || FOREIGN.has(tag);
    this.segs.push({ t: "", owner: idx, kind: 0, dropped, head, link });
    const frame: Frame = {
      idx, tag, role, parent, startSeg: this.segs.length - 1, endSeg: -1, dropped, head, link, foreign,
      suppress: false, closed: false, aLabel: null, aNeedsText: false, icons: [], pText: 0,
    };
    // 1. Cloudflare-protected emails, 2. phone/email links (the order of the lxml passes).
    const cfemail = attrs.get("data-cfemail");
    if (cfemail !== undefined) {
      const email = decodeCfEmail(cfemail);
      if (email && !this.suppressDepth) {
        this.segs[frame.startSeg].t = email;
        frame.suppress = true;
      }
    }
    const href = attrs.get("href");
    if (tag === "a" && href !== undefined) {
      const h = href.trim();
      if (h.includes("/cdn-cgi/l/email-protection#")) {
        const email = decodeCfEmail(h.slice(h.lastIndexOf("#") + 1));
        if (email && !this.suppressDepth) {
          this.segs[frame.startSeg].t = email;
          frame.suppress = true;
          frame.aLabel = "Email";
        }
      } else if (h.toLowerCase().startsWith("tel:")) {
        frame.aLabel = "Phone";
        frame.aNeedsText = true;
      } else if (h.toLowerCase().startsWith("mailto:")) {
        frame.aLabel = "Email";
        frame.aNeedsText = true;
      }
    }
    if (frame.suppress) this.suppressDepth++;
    // 3. A detail shown with only an icon: label the item it belongs to (resolved when that item ends).
    const isIcon = cls !== null && (tag === "svg" || tag === "i" || (tag === "span" && cls.includes("icon")));
    if (isIcon && parent) {
      const label = iconLabel([cls, attrs.get("data-icon"), attrs.get("aria-label")].filter(Boolean).join(" "));
      if (label) parent.icons.push({ label, level: 0 });
    }
    if (tag === "title") this.inTitle++;
    if (tag === "h1") this.inH1++;
    this.stack.push(frame);
    this.frames.push(frame);
    this.owner = idx;
    this.kind = 0;
    if (VOID.has(tag) || (selfClosing && foreign)) this.close(frame);
  }

  meta(attrs: Map<string, string>): void {
    const content = attrs.get("content");
    if (!content || !content.trim()) return;
    if (attrs.get("property") === "og:title") this.ogTitle.push(content);
    if (attrs.get("name") === "description") this.descriptions.push(content);
    if (attrs.get("property") === "og:description") this.ogDescriptions.push(content);
  }

  end(tag: string): void {
    // An end tag only closes an element "in scope": not past a table cell, table or button it isn't in.
    const boundary = TABLE_END_TAGS.has(tag) ? (tag === "table" ? HTML_ONLY : TABLE_ONLY) : tag === "html" || tag === "body" ? HTML_ONLY : P_SCOPE;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].tag === tag) {
        this.close(this.stack[i]);
        return;
      }
      if (boundary.has(this.stack[i].tag)) return;
    }
  }

  /** HTML's implied end tags for the common cases (lists, paragraphs, tables, definition lists). */
  impliedCloses(tag: string): void {
    const closeUpTo = (match: (f: Frame) => boolean, boundary: Set<string>) => {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const f = this.stack[i];
        if (match(f)) {
          this.close(f);
          return;
        }
        if (boundary.has(f.tag)) return;
      }
    };
    if (tag === "body") closeUpTo((f) => f.tag === "head", new Set(["html"]));
    if (CLOSES_P.has(tag)) closeUpTo((f) => f.tag === "p", P_SCOPE);
    if (tag === "li") closeUpTo((f) => f.tag === "li", new Set(["ul", "ol", "menu", "table", "html"]));
    if (tag === "dt" || tag === "dd") closeUpTo((f) => f.tag === "dt" || f.tag === "dd", new Set(["dl", "table", "html"]));
    if (tag === "tr") closeUpTo((f) => f.tag === "tr", new Set(["table", "tbody", "thead", "tfoot", "html"]));
    if (tag === "td" || tag === "th") closeUpTo((f) => f.tag === "td" || f.tag === "th", new Set(["tr", "table", "html"]));
    if (tag === "tbody" || tag === "thead" || tag === "tfoot") closeUpTo((f) => ["tbody", "thead", "tfoot"].includes(f.tag), new Set(["table", "html"]));
    if (tag === "option") closeUpTo((f) => f.tag === "option", new Set(["select", "datalist", "optgroup", "html"]));
    if (HEADINGS.has(tag) && this.top() && HEADINGS.has(this.top()!.tag)) this.close(this.top()!);
  }

  /** Close ``frame`` (and any of its children still open). */
  close(frame: Frame): void {
    if (frame.closed) return;
    while (this.stack.length && this.top() !== frame) this.closeTop();
    this.closeTop();
  }

  private closeTop(): void {
    const frame = this.stack.pop()!;
    if (frame.suppress) this.suppressDepth--;
    frame.endSeg = this.segs.length;
    if (frame.aLabel) {
      if (!frame.aNeedsText || this.textContent(frame).trim()) this.prefix(frame, frame.aLabel);
    }
    for (const icon of frame.icons) this.resolveIcon(frame, icon);
    if (BLOCK_TAGS.has(frame.tag) && !frame.dropped) {
      const td = frame.tag === "td" || frame.tag === "th";
      this.segs.push({ t: td ? " | " : "\n", owner: frame.idx, kind: 2, dropped: false, head: frame.head, link: frame.link, td });
    }
    if (PARAGRAPH_TAGS.has(frame.tag) && frame.parent && !frame.dropped) frame.parent.pText += this.plainLength(frame);
    if (frame.tag === "title") this.inTitle--;
    if (frame.tag === "h1") this.inH1--;
    frame.closed = true;
    this.owner = frame.idx;
    this.kind = 1;
  }

  /** lxml's text_content() of an element as it is now (annotations applied, before drops). */
  textContent(frame: Frame): string {
    const end = frame.closed ? frame.endSeg : this.segs.length;
    let out = "";
    for (let i = frame.startSeg; i < end; i++) if (this.segs[i].kind !== 2) out += this.segs[i].t;
    return out;
  }

  /** Visible, non-link text length of an element (main-content scoring). */
  plainLength(frame: Frame): number {
    const end = frame.closed ? frame.endSeg : this.segs.length;
    let n = 0;
    for (let i = frame.startSeg; i < end; i++) {
      const s = this.segs[i];
      if (s.kind !== 2 && !s.dropped && !s.link) n += s.t.replace(/\s+/g, "").length;
    }
    return n;
  }

  /** Put "Label: " before an element's text, unless it already says what it is (_prefix). */
  prefix(frame: Frame, label: string): void {
    if (LABEL_WORDS.test(this.textContent(frame))) return;
    const end = frame.closed ? frame.endSeg : this.segs.length;
    // The first real text in lxml's el.iter() order: each element's .text, then (for descendants) its .tail.
    let bestKey = Infinity;
    for (let i = frame.startSeg; i < end; i++) {
      const s = this.segs[i];
      if (s.kind === 2 || !/\S/.test(s.t)) continue;
      const key = s.owner * 2 + s.kind;
      if (key < bestKey) bestKey = key;
    }
    if (bestKey === Infinity) {
      const seg = this.segs[frame.startSeg];
      seg.t = `${label}: ` + seg.t;
      return;
    }
    const tail = bestKey % 2 === 1;
    for (let i = frame.startSeg; i < end; i++) {
      const s = this.segs[i];
      if (s.kind === 2 || s.owner * 2 + s.kind !== bestKey) continue;
      if (!/\S/.test(s.t)) {
        s.t = ""; // leading whitespace of the text is stripped
        continue;
      }
      s.t = (tail ? ` ${label}: ` : `${label}: `) + s.t.replace(/^\s+/, "");
      return;
    }
  }

  /** The icon's item: the first of parent, grandparent, great-grandparent that is li/p/dd/td or has text, else the next one up. */
  resolveIcon(frame: Frame, icon: PendingIcon): void {
    const qualifies = icon.level >= 3 || ICON_ITEM_TAGS.has(frame.tag) || this.textContent(frame).trim().length > 0;
    if (!qualifies) {
      if (frame.parent) frame.parent.icons.push({ label: icon.label, level: icon.level + 1 });
      return;
    }
    const text = collapse(this.textContent(frame));
    if (text && [...text].length <= 120 && !text.toLowerCase().startsWith(icon.label.toLowerCase())) this.prefix(frame, icon.label);
  }

  finish(): void {
    while (this.stack.length) this.closeTop();
  }

  /** The text of segments [from, to) with block breaks, drops applied. */
  text_(from = 0, to = this.segs.length): string {
    let out = "";
    let stripFor = -1; // td/th whose tail starts after a " | " break: leading newlines go
    for (let i = from; i < to; i++) {
      const s = this.segs[i];
      if (s.dropped || s.head) continue;
      let t = s.t;
      if (s.kind === 2) {
        out += t;
        stripFor = s.td ? s.owner : -1;
        continue;
      }
      if (stripFor >= 0) {
        if (s.owner === stripFor && s.kind === 1) {
          t = t.replace(/^\n+/, "");
          if (t) stripFor = -1;
        } else {
          stripFor = -1;
        }
      }
      out += t;
    }
    return out;
  }

  /** The main-content element: the article with the most text, else main / role=main, else the best paragraph parent. */
  mainFrame(): Frame | null {
    const visible = this.frames.filter((f) => !f.dropped && !f.head);
    const best = (list: Frame[], score: (f: Frame) => number) => {
      let top: Frame | null = null;
      let topScore = 0;
      for (const f of list) {
        const s = score(f);
        if (s > topScore) {
          top = f;
          topScore = s;
        }
      }
      return top && topScore >= MIN_MAIN_CHARS ? top : null;
    };
    return (
      best(visible.filter((f) => f.tag === "article"), (f) => this.plainLength(f)) ??
      best(visible.filter((f) => f.tag === "main" || f.role === "main"), (f) => this.plainLength(f)) ??
      best(visible, (f) => f.pText)
    );
  }
}

/** An <img>'s picture: src, else a lazy-loading attribute, else the largest srcset entry. */
function imageSrc(attrs: Map<string, string>): string {
  for (const name of ["src", "data-src", "data-lazy-src", "data-original"]) {
    const v = (attrs.get(name) ?? "").trim();
    if (v && !v.startsWith("data:")) return v;
  }
  for (const name of ["srcset", "data-srcset"]) {
    const entries = (attrs.get(name) ?? "").split(",").map((e) => e.trim().split(/\s+/)[0]).filter((e) => e && !e.startsWith("data:"));
    if (entries.length) return entries[entries.length - 1];
  }
  return "";
}

export interface ExtractOptions {
  /** Keep the site header and footer (the start page: contact details often live there). */
  keepChrome?: boolean;
}

/** Extract title, text, outgoing links and content images from an HTML page. */
export function extract(html: string, url: string, mode = "auto", options: ExtractOptions = {}): Extracted {
  if (!html.trim()) return { title: "", text: "", links: [] };
  const b = new Builder();
  b.keepChrome = Boolean(options.keepChrome);
  tokenize(html, b);
  b.finish();

  const firstNonEmpty = (values: string[]) => values.map((v) => v.trim()).find((v) => v) ?? "";
  const titleRaw = firstNonEmpty(b.ogTitle) || firstNonEmpty(b.titleTexts) || firstNonEmpty(b.h1Texts);
  const title = titleRaw.replace(/\s+/g, " ").slice(0, 300);
  const description = (firstNonEmpty(b.descriptions.map(collapse)) || firstNonEmpty(b.ogDescriptions.map(collapse))).slice(0, 1000);
  const base = b.baseHref !== null ? urljoin(url, b.baseHref) : url;
  const links = b.hrefs.map((h) => h.trim()).filter(followable).map((h) => urljoin(base, h));
  let body: string;
  if (mode === "main_content") {
    const main = b.mainFrame();
    body = main ? b.text_(main.startSeg, main.endSeg) : b.text_();
  } else {
    body = b.text_();
  }
  const own = cleanLines(body);
  const text = withDescription(own, description);
  const images: { url: string; alt: string }[] = [];
  const seen = new Set<string>();
  for (const img of b.images) {
    const abs = urljoin(base, img.src);
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    images.push({ url: abs, alt: img.alt });
  }
  return { title, text: text.slice(0, MAX_TEXT_CHARS), links, images, bodyChars: own.length };
}
