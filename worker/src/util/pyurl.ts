/**
 * Faithful ports of the Python standard-library URL helpers the crawler relies on
 * (urllib.parse: urlsplit/urlparse/urlunparse/urljoin/urldefrag, quote/unquote, parse_qsl/urlencode,
 * and fnmatch). The WHATWG URL class normalises URLs differently (percent-encodes non-ASCII paths,
 * lower-cases differently), which would change which URLs count as the same page.
 */

const SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";
const USES_RELATIVE = new Set(["", "ftp", "http", "gopher", "nntp", "imap", "wais", "file", "https", "shttp", "mms", "prospero", "rtsp", "rtsps", "rtspu", "sftp", "svn", "svn+ssh", "ws", "wss"]);
const USES_NETLOC = new Set(["", "ftp", "http", "gopher", "nntp", "telnet", "imap", "wais", "file", "mms", "https", "shttp", "snews", "prospero", "rtsp", "rtsps", "rtspu", "rsync", "svn", "svn+ssh", "sftp", "nfs", "git", "git+ssh", "ws", "wss", "itms-services"]);
const USES_PARAMS = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtsps", "rtspu", "sip", "sips", "mms", "sftp", "tel"]);

export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

export interface ParseResult extends SplitResult {
  params: string;
}

function lstripC0(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 0x20) i++;
  return s.slice(i);
}

function splitNetloc(url: string, start = 0): [string, string] {
  let delim = url.length;
  for (const c of "/?#") {
    const w = url.indexOf(c, start);
    if (w >= 0) delim = Math.min(delim, w);
  }
  return [url.slice(start, delim), url.slice(delim)];
}

export function urlsplit(input: string, scheme = "", allowFragments = true): SplitResult {
  let url = lstripC0(input).replace(/[\t\r\n]/g, "");
  let netloc = "";
  let query = "";
  let fragment = "";
  const i = url.indexOf(":");
  if (i > 0 && /^[A-Za-z]$/.test(url[0])) {
    let ok = true;
    for (const c of url.slice(0, i)) {
      if (!SCHEME_CHARS.includes(c)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      scheme = url.slice(0, i).toLowerCase();
      url = url.slice(i + 1);
    }
  }
  if (url.slice(0, 2) === "//") [netloc, url] = splitNetloc(url, 2);
  if (allowFragments && url.includes("#")) {
    const k = url.indexOf("#");
    fragment = url.slice(k + 1);
    url = url.slice(0, k);
  }
  if (url.includes("?")) {
    const k = url.indexOf("?");
    query = url.slice(k + 1);
    url = url.slice(0, k);
  }
  return { scheme, netloc, path: url, query, fragment };
}

function splitParams(url: string): [string, string] {
  let i: number;
  if (url.includes("/")) {
    i = url.indexOf(";", url.lastIndexOf("/"));
    if (i < 0) return [url, ""];
  } else {
    i = url.indexOf(";");
  }
  return [url.slice(0, i), url.slice(i + 1)];
}

export function urlparse(url: string, scheme = "", allowFragments = true): ParseResult {
  const s = urlsplit(url, scheme, allowFragments);
  let path = s.path;
  let params = "";
  if (USES_PARAMS.has(s.scheme) && path.includes(";")) [path, params] = splitParams(path);
  return { ...s, path, params };
}

export function urlunsplit(p: SplitResult): string {
  let url = p.path;
  if (p.netloc) {
    if (url && url[0] !== "/") url = "/" + url;
    url = "//" + p.netloc + url;
  } else if (url.slice(0, 2) === "//") {
    url = "//" + url;
  }
  if (p.scheme) url = p.scheme + ":" + url;
  if (p.query) url = url + "?" + p.query;
  if (p.fragment) url = url + "#" + p.fragment;
  return url;
}

export function urlunparse(p: ParseResult): string {
  const path = p.params ? `${p.path};${p.params}` : p.path;
  return urlunsplit({ scheme: p.scheme, netloc: p.netloc, path, query: p.query, fragment: p.fragment });
}

export function urljoin(base: string, url: string, allowFragments = true): string {
  if (!base) return url;
  if (!url) return base;
  const b = urlparse(base, "", allowFragments);
  const u = urlparse(url, b.scheme, allowFragments);
  let { scheme, netloc, path, params, query, fragment } = u;
  if (scheme !== b.scheme || !USES_RELATIVE.has(scheme)) return url;
  if (USES_NETLOC.has(scheme)) {
    if (netloc) return urlunparse({ scheme, netloc, path, params, query, fragment });
    netloc = b.netloc;
  }
  if (!path && !params) {
    path = b.path;
    params = b.params;
    if (!query) query = b.query;
    return urlunparse({ scheme, netloc, path, params, query, fragment });
  }
  const baseParts = b.path.split("/");
  if (baseParts[baseParts.length - 1] !== "") baseParts.pop();
  let segments: string[];
  if (path.slice(0, 1) === "/") {
    segments = path.split("/");
  } else {
    segments = [...baseParts, ...path.split("/")];
    // segments[1:-1] = filter(None, segments[1:-1])
    if (segments.length > 2) {
      segments = [segments[0], ...segments.slice(1, -1).filter(Boolean), segments[segments.length - 1]];
    }
  }
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      resolved.pop();
    } else if (seg === ".") {
      continue;
    } else {
      resolved.push(seg);
    }
  }
  const last = segments[segments.length - 1];
  if (last === "." || last === "..") resolved.push("");
  return urlunparse({ scheme, netloc, path: resolved.join("/") || "/", params, query, fragment });
}

export function urldefrag(url: string): [string, string] {
  if (url.includes("#")) {
    const p = urlparse(url);
    const defrag = urlunparse({ ...p, fragment: "" });
    return [defrag, p.fragment];
  }
  return [url, ""];
}

/** Python's SplitResult.hostname: no user info, no port, no brackets, lower-case; null when empty. */
export function hostnameOf(netloc: string): string | null {
  const hostinfo = netloc.includes("@") ? netloc.slice(netloc.lastIndexOf("@") + 1) : netloc;
  let host: string;
  if (hostinfo.startsWith("[")) {
    const end = hostinfo.indexOf("]");
    host = end >= 0 ? hostinfo.slice(1, end) : hostinfo.slice(1);
  } else {
    const k = hostinfo.indexOf(":");
    host = k >= 0 ? hostinfo.slice(0, k) : hostinfo;
  }
  host = host.split("%")[0] === host ? host : host; // zone ids are kept, like Python
  return host ? host.toLowerCase() : null;
}

/** Python's SplitResult.port: the port number, or null; throws for an invalid port. */
export function portOf(netloc: string): number | null {
  const hostinfo = netloc.includes("@") ? netloc.slice(netloc.lastIndexOf("@") + 1) : netloc;
  let portStr = "";
  if (hostinfo.startsWith("[")) {
    const end = hostinfo.indexOf("]");
    const rest = end >= 0 ? hostinfo.slice(end + 1) : "";
    if (rest.startsWith(":")) portStr = rest.slice(1);
  } else {
    const k = hostinfo.indexOf(":");
    if (k >= 0) portStr = hostinfo.slice(k + 1);
  }
  if (!portStr) return null;
  if (!/^\d+$/.test(portStr)) throw new Error(`Port could not be cast to integer value as '${portStr}'`);
  const n = Number(portStr);
  if (n < 0 || n > 65535) throw new Error("Port out of range 0-65535");
  return n;
}

export function usernameOf(netloc: string): string | null {
  if (!netloc.includes("@")) return null;
  const userinfo = netloc.slice(0, netloc.lastIndexOf("@"));
  const k = userinfo.indexOf(":");
  return k >= 0 ? userinfo.slice(0, k) : userinfo;
}

export function passwordOf(netloc: string): string | null {
  if (!netloc.includes("@")) return null;
  const userinfo = netloc.slice(0, netloc.lastIndexOf("@"));
  const k = userinfo.indexOf(":");
  return k >= 0 ? userinfo.slice(k + 1) : null;
}

// ----------------------------------------------------------------------------- quoting
const ALWAYS_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~";
const encoder = new TextEncoder();

/** urllib.parse.quote(string, safe='/'): UTF-8 percent-encoding. */
export function quote(s: string, safe = "/"): string {
  let out = "";
  for (const ch of s) {
    if (ALWAYS_SAFE.includes(ch) || (safe.includes(ch) && ch.charCodeAt(0) < 128)) {
      out += ch;
    } else {
      for (const byte of encoder.encode(ch)) out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** urllib.parse.quote_plus: spaces become '+'. */
export function quotePlus(s: string, safe = ""): string {
  if (s.includes(" ")) return quote(s, safe + " ").replace(/ /g, "+");
  return quote(s, safe);
}

const decoder = new TextDecoder(); // UTF-8; invalid bytes become U+FFFD (errors='replace')

/** urllib.parse.unquote: decode %XX sequences as UTF-8 (invalid bytes become U+FFFD). */
export function unquote(s: string): string {
  if (!s.includes("%")) return s;
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return decoder.decode(bytes);
  });
}

export function unquotePlus(s: string): string {
  return unquote(s.replace(/\+/g, " "));
}

/** urllib.parse.parse_qsl(qs, keep_blank_values=True). */
export function parseQsl(qs: string, keepBlankValues = true): [string, string][] {
  const out: [string, string][] = [];
  if (!qs) return out;
  for (const field of qs.split("&")) {
    if (!field) continue;
    const eq = field.indexOf("=");
    let name: string;
    let value: string;
    if (eq < 0) {
      if (!keepBlankValues) continue;
      name = field;
      value = "";
    } else {
      name = field.slice(0, eq);
      value = field.slice(eq + 1);
    }
    if (value || keepBlankValues) out.push([unquotePlus(name), unquotePlus(value)]);
  }
  return out;
}

/** urllib.parse.urlencode(list of pairs) with quote_plus. */
export function urlencode(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
}

// ----------------------------------------------------------------------------- fnmatch
const fnCache = new Map<string, RegExp>();

/** fnmatch.translate: shell wildcard pattern -> anchored regular expression. */
export function fnTranslate(pat: string): string {
  let i = 0;
  const n = pat.length;
  let res = "";
  while (i < n) {
    const c = pat[i];
    i++;
    if (c === "*") {
      if (!res.endsWith(".*")) res += ".*";
    } else if (c === "?") {
      res += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j++;
      if (j < n && pat[j] === "]") j++;
      while (j < n && pat[j] !== "]") j++;
      if (j >= n) {
        res += "\\[";
      } else {
        let stuff = pat.slice(i, j);
        if (!stuff.includes("-")) {
          stuff = stuff.replace(/\\/g, "\\\\");
        } else {
          // Ranges: escape backslashes and hyphens of each chunk, keep the range hyphens.
          const chunks: string[] = [];
          let k = pat[i] === "!" ? i + 2 : i + 1;
          let start = i;
          for (;;) {
            k = pat.indexOf("-", k);
            if (k < 0 || k >= j) break;
            chunks.push(pat.slice(start, k));
            start = k + 1;
            k = k + 3;
          }
          const tail = pat.slice(start, j);
          if (tail) chunks.push(tail);
          else chunks[chunks.length - 1] += "-";
          // Remove empty ranges (invalid in a regular expression).
          for (let m = chunks.length - 1; m > 0; m--) {
            const prev = chunks[m - 1];
            if (prev && chunks[m] && prev[prev.length - 1] > chunks[m][0]) {
              chunks[m - 1] = prev.slice(0, -1) + chunks[m].slice(1);
              chunks.splice(m, 1);
            }
          }
          stuff = chunks.map((s) => s.replace(/\\/g, "\\\\").replace(/-/g, "\\-")).join("-");
        }
        stuff = stuff.replace(/([&~|])/g, "\\$1");
        i = j + 1;
        if (!stuff) {
          res += "(?!)";
        } else if (stuff === "!") {
          res += ".";
        } else {
          if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
          else if (stuff[0] === "^" || stuff[0] === "[") stuff = "\\" + stuff;
          res += `[${stuff}]`;
        }
      }
    } else {
      res += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return `^(?:${res})$`;
}

/** fnmatch.fnmatch on a POSIX server (case-sensitive, '*' matches '/' too). */
export function fnmatch(name: string, pat: string): boolean {
  let re = fnCache.get(pat);
  if (!re) {
    re = new RegExp(fnTranslate(pat), "s");
    if (fnCache.size > 500) fnCache.clear();
    fnCache.set(pat, re);
  }
  return re.test(name);
}

// ----------------------------------------------------------------------------- Python string helpers
/** str.splitlines(): every line boundary Python recognises. */
export function splitlines(s: string): string[] {
  const lines = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85  ]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** str.split() without arguments: split on runs of whitespace, no empty strings. */
export function pySplit(s: string): string[] {
  return s.split(/[\s\x1c-\x1f]+/u).filter(Boolean);
}

/** str.strip(chars). */
export function strip(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

export function lstrip(s: string, chars: string): string {
  let a = 0;
  while (a < s.length && chars.includes(s[a])) a++;
  return s.slice(a);
}
