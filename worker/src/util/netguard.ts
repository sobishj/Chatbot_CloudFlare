/**
 * Recognise host names that point at a private network.
 *
 * Workers can't resolve DNS, so this checks what the URL itself says: IP literals in private,
 * loopback, link-local, CGNAT or unique-local ranges, "localhost", Docker's host alias and
 * .local/.internal names. Cloudflare itself refuses to connect a Worker to private destinations,
 * so a public name that resolves to a private address fails at connect time instead.
 */

import { hostnameOf, urlparse } from "./pyurl";

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function privateIpv4(o: number[]): boolean {
  const [a, b] = o;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && o[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

function privateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) {
    const o = ipv4Octets(mapped[1]);
    return o ? privateIpv4(o) : true;
  }
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true; // mapped, hex form
  const first = parseInt(h.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 // multicast
  );
}

/** True for loopback/private/link-local IP literals, localhost, host.docker.internal and .local/.internal names. */
export function isPrivateHost(rawHost: string | null | undefined): boolean {
  if (!rawHost) return false;
  let host = rawHost.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "host.docker.internal" || host.endsWith(".local") || host.endsWith(".internal") || host === "local" || host === "internal") return true;
  if (host.includes(":")) return privateIpv6(host);
  const o = ipv4Octets(host);
  if (o) return privateIpv4(o);
  return false;
}

/** Checks both the Python-style host and the WHATWG-normalised one (which decodes forms like 0x7f.1 or 2130706433). */
export function urlTargetsPrivateNetwork(url: string | null | undefined): boolean {
  if (!url) return false;
  if (isPrivateHost(hostnameOf(urlparse(url.trim()).netloc))) return true;
  try {
    return isPrivateHost(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}
