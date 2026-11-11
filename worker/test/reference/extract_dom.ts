/**
 * Reference implementation for the tests: the lxml ``auto`` rules of app/crawler/extract.py ported
 * one-to-one onto a DOM (linkedom). The production extractor (src/crawler/extract.ts) reads the page
 * in one streaming pass instead; the tests check that both give the same result.
 */

import { parseHTML } from "linkedom";
import { urljoin } from "../../src/util/pyurl";
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
} from "../../src/crawler/rules";

type El = any;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function tagOf(el: El): string {
  return String(el.tagName || el.localName || "").toLowerCase();
}

function children(el: El): El[] {
  return [...(el.childNodes || [])];
}

/** Text nodes that lxml calls el.text (before the first child element). */
function leadingTextNodes(el: El): El[] {
  const out: El[] = [];
  for (const n of children(el)) {
    if (n.nodeType === ELEMENT_NODE) break;
    if (n.nodeType === TEXT_NODE) out.push(n);
  }
  return out;
}

/** Text nodes that lxml calls el.tail (after the element, before the next element sibling). */
function tailTextNodes(el: El): El[] {
  const out: El[] = [];
  for (let n = el.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE) break;
    if (n.nodeType === TEXT_NODE) out.push(n);
  }
  return out;
}

function joinText(nodes: El[]): string {
  return nodes.map((n) => n.data ?? n.textContent ?? "").join("");
}

/** Replace a run of text nodes by one node with ``text`` (or insert it at ``before``). */
function setTextNodes(doc: El, parent: El, nodes: El[], text: string, before: El | null): void {
  const node = doc.createTextNode(text);
  if (nodes.length) {
    parent.insertBefore(node, nodes[0]);
    for (const n of nodes) n.remove();
  } else {
    parent.insertBefore(node, before);
  }
}

function preorder(el: El, out: El[] = []): El[] {
  out.push(el);
  for (const c of children(el)) if (c.nodeType === ELEMENT_NODE) preorder(c, out);
  return out;
}

function textContent(el: El): string {
  return el.textContent ?? "";
}

function prefix(doc: El, el: El, label: string): void {
  if (LABEL_WORDS.test(textContent(el))) return;
  // Attach the label to the first real text (not the element's start), so "Phone:" and the
  // number stay on one line even when the markup has line breaks between icon and value.
  for (const node of preorder(el)) {
    const lead = leadingTextNodes(node);
    const text = joinText(lead);
    if (text.trim()) {
      setTextNodes(doc, node, lead, `${label}: ` + text.replace(/^\s+/, ""), node.firstChild);
      return;
    }
    if (node !== el) {
      const tailNodes = tailTextNodes(node);
      const tail = joinText(tailNodes);
      if (tail.trim()) {
        setTextNodes(doc, node.parentNode, tailNodes, ` ${label}: ` + tail.replace(/^\s+/, ""), node.nextSibling);
        return;
      }
    }
  }
  const lead = leadingTextNodes(el);
  setTextNodes(doc, el, lead, `${label}: ` + joinText(lead), el.firstChild);
}

function setText(el: El, text: string): void {
  el.textContent = text;
}

/** Make implicit details explicit before the text is extracted (_annotate). */
function annotate(doc: El): void {
  for (const el of doc.querySelectorAll("[data-cfemail]")) {
    const email = decodeCfEmail(el.getAttribute("data-cfemail") || "");
    if (email) setText(el, email);
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") || "").trim();
    if (href.includes("/cdn-cgi/l/email-protection#")) {
      const email = decodeCfEmail(href.slice(href.lastIndexOf("#") + 1));
      if (email) {
        setText(a, email);
        prefix(doc, a, "Email");
      }
    } else if (href.toLowerCase().startsWith("tel:") && textContent(a).trim()) {
      prefix(doc, a, "Phone");
    } else if (href.toLowerCase().startsWith("mailto:") && textContent(a).trim()) {
      prefix(doc, a, "Email");
    }
  }
  for (const icon of doc.querySelectorAll("svg[class], i[class], span[class*='icon'][class]")) {
    const names = [icon.getAttribute("class"), icon.getAttribute("data-icon"), icon.getAttribute("aria-label")].filter(Boolean).join(" ");
    const label = iconLabel(names);
    if (!label) continue;
    let item = icon.parentElement;
    for (let i = 0; i < 3; i++) {
      if (!item || ICON_ITEM_TAGS.has(tagOf(item)) || textContent(item).trim().length > 0) break;
      item = item.parentElement;
    }
    if (!item) continue;
    const text = collapse(textContent(item));
    if (text && [...text].length <= 120 && !text.toLowerCase().startsWith(label.toLowerCase())) prefix(doc, item, label);
  }
}

function structuralText(doc: El, root: El): string {
  {
    for (const el of preorder(root)) {
      const a = { role: el.getAttribute?.("role"), ariaHidden: el.getAttribute?.("aria-hidden"), elementor: el.getAttribute?.("data-elementor-type"), cls: el.getAttribute?.("class"), id: el.getAttribute?.("id") };
      if (el !== root && el.parentNode && el.isConnected !== false && isDropped(tagOf(el), a)) el.remove();
    }
  }
  for (const el of preorder(root)) {
    if (el === root || !BLOCK_TAGS.has(tagOf(el))) continue;
    const tailNodes = tailTextNodes(el);
    let tail = "\n" + joinText(tailNodes);
    if (tagOf(el) === "td" || tagOf(el) === "th") tail = " | " + tail.replace(/^\n+/, "");
    setTextNodes(doc, el.parentNode, tailNodes, tail, el.nextSibling);
  }
  return cleanLines(textContent(root));
}

function bodyOf(doc: El): El {
  return doc.querySelector("body") ?? doc.documentElement;
}

function firstAttr(doc: El, selector: string, attr: string): string {
  for (const el of doc.querySelectorAll(selector)) {
    const v = el.getAttribute(attr);
    if (v && v.trim()) return v;
  }
  return "";
}

function firstText(doc: El, selector: string): string {
  for (const el of doc.querySelectorAll(selector)) {
    for (const n of descendantsText(el)) if (n.trim()) return n.trim();
  }
  return "";
}

function descendantsText(el: El, out: string[] = []): string[] {
  for (const n of children(el)) {
    if (n.nodeType === TEXT_NODE) out.push(n.data ?? "");
    else if (n.nodeType === ELEMENT_NODE) descendantsText(n, out);
  }
  return out;
}

/** Extract title, text and outgoing links using a DOM (auto mode). */
export function extractDom(html: string, url: string): Extracted {
  if (!html.trim()) return { title: "", text: "", links: [] };
  const { document } = parseHTML(html);
  const doc: El = document;
  const ogTitle = firstAttr(doc, "meta[property='og:title']", "content").trim();
  const title = (ogTitle || firstText(doc, "title") || firstText(doc, "h1")).replace(/\s+/g, " ").slice(0, 300);
  const baseEl = doc.querySelector("base[href]");
  const base = baseEl ? urljoin(url, baseEl.getAttribute("href") || "") : url;
  const links = [...doc.querySelectorAll("a[href]")].map((a: El) => (a.getAttribute("href") || "").trim()).filter(followable).map((h: string) => urljoin(base, h));
  const description = collapse(firstAttr(doc, "meta[name='description']", "content") || firstAttr(doc, "meta[property='og:description']", "content")).slice(0, 1000);
  annotate(doc);
  const text = structuralText(doc, bodyOf(doc));
  return { title, text: withDescription(text, description).slice(0, MAX_TEXT_CHARS), links };
}
