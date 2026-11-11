/** Signed, HttpOnly session cookies and double-submit CSRF tokens for the admin UI. */

import { parseCookies, serializeCookie } from "../util/http";
import { b64urlDecode, b64urlEncode, safeEqual } from "./crypto";

export const SESSION_COOKIE = "wa_session";
export const CSRF_COOKIE = "wa_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_MAX_AGE = 12 * 3600; // seconds

const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secretKey: string): Promise<CryptoKey> {
  let key = keyCache.get(secretKey);
  if (!key) {
    key = crypto.subtle
      .digest("SHA-256", enc.encode("website-assistant:session:" + secretKey))
      .then((raw) => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
    keyCache.set(secretKey, key);
  }
  return key;
}

/** True when the browser reached us over HTTPS. */
export function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export async function sessionToken(secretKey: string, userId: number, sessionVersion: number): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ u: userId, v: sessionVersion, iat: Math.floor(Date.now() / 1000) })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secretKey), enc.encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

export async function sessionCookie(secretKey: string, request: Request, userId: number, sessionVersion: number): Promise<string> {
  return serializeCookie(SESSION_COOKIE, await sessionToken(secretKey, userId, sessionVersion), {
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    secure: isHttps(request), // Secure cookies don't work over plain HTTP (wrangler dev)
    sameSite: "lax",
    path: "/",
  });
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=""; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
}

export async function readSession(secretKey: string, request: Request): Promise<{ u: number; v: number } | null> {
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secretKey), b64urlDecode(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(b64urlDecode(payload)));
    if (typeof data !== "object" || data === null || !("u" in data) || !("v" in data)) return null;
    const iat = Number(data.iat);
    if (!Number.isFinite(iat) || Date.now() / 1000 - iat > SESSION_MAX_AGE || iat - Date.now() / 1000 > 300) return null;
    return { u: Number(data.u), v: Number(data.v) };
  } catch {
    return null;
  }
}

/** A Set-Cookie value giving the browser a CSRF token (readable by JS, echoed back in a header), or null. */
export function csrfCookieIfMissing(request: Request): string | null {
  if (parseCookies(request.headers.get("cookie"))[CSRF_COOKIE]) return null;
  return serializeCookie(CSRF_COOKIE, b64urlEncode(crypto.getRandomValues(new Uint8Array(32))), {
    maxAge: 30 * 24 * 3600,
    httpOnly: false,
    secure: isHttps(request),
    sameSite: "strict",
    path: "/",
  });
}

export function csrfValid(request: Request): boolean {
  const cookie = parseCookies(request.headers.get("cookie"))[CSRF_COOKIE];
  const header = request.headers.get(CSRF_HEADER);
  return Boolean(cookie && header && safeEqual(cookie, header));
}
