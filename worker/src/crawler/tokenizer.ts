/**
 * A small HTML tokenizer: start tags (with attributes), end tags and text, in document order.
 *
 * HTMLRewriter calls into JavaScript for every element and end tag, which costs ~100 ms of CPU on a
 * 100 KB page (the free plan allows 10 ms per invocation); one regular-expression pass over the
 * string costs about 1 ms. Raw-text elements (script, style) and RCDATA (title, textarea) are read
 * up to their end tag, like a browser does. Character references are decoded in text and attributes.
 */

import { decodeEntities } from "./entities";

export interface TokenHandler {
  start(tag: string, attrs: Map<string, string>, selfClosing: boolean): void;
  end(tag: string): void;
  text(text: string): void;
}

const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<|[^<]+/g;
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const RCDATA = new Set(["title", "textarea"]);

function parseAttrs(src: string): Map<string, string> {
  const attrs = new Map<string, string>();
  if (!src) return attrs;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase();
    if (attrs.has(name)) continue; // the first occurrence wins
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

export function tokenize(html: string, handler: TokenHandler): void {
  const re = new RegExp(TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const token = m[0];
    if (m[2] === undefined) {
      // Text (a lone "<" is text too); comments, doctypes and processing instructions are skipped.
      if (token.startsWith("<!") || token.startsWith("<?")) continue;
      handler.text(decodeEntities(token));
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      handler.end(tag);
      continue;
    }
    const rawAttrs = m[3] ?? "";
    const selfClosing = /\/\s*$/.test(rawAttrs);
    handler.start(tag, parseAttrs(selfClosing ? rawAttrs.replace(/\/\s*$/, "") : rawAttrs), selfClosing);
    if (RAW_TEXT.has(tag) || RCDATA.has(tag)) {
      if (selfClosing && tag !== "script") continue;
      const close = new RegExp(`</${tag}[\\s/>]`, "ig");
      close.lastIndex = re.lastIndex;
      const found = close.exec(html);
      const endAt = found ? found.index : html.length;
      const content = html.slice(re.lastIndex, endAt);
      if (content) handler.text(RCDATA.has(tag) ? decodeEntities(content) : content);
      handler.end(tag);
      if (!found) return;
      const gt = html.indexOf(">", endAt);
      re.lastIndex = gt < 0 ? html.length : gt + 1;
    }
  }
}
