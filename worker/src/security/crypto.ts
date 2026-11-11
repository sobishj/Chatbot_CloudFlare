/** Encrypt secrets (AI provider API keys, API action vaults) at rest with AES-GCM, key derived from SECRET_KEY. */

const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof value === "string" ? enc.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function aesKey(secretKey: string): Promise<CryptoKey> {
  let key = keyCache.get(secretKey);
  if (!key) {
    // Domain-separated derivation so the session-signing key and this key differ (as in the Python version).
    key = crypto.subtle
      .digest("SHA-256", enc.encode("website-assistant:api-keys:" + secretKey))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    keyCache.set(secretKey, key);
  }
  return key;
}

export async function encryptSecret(secretKey: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secretKey), enc.encode(plaintext)));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return "v1." + b64urlEncode(out);
}

/** The plaintext, or null if it can't be decrypted (e.g. SECRET_KEY changed). */
export async function decryptSecret(secretKey: string, token: string | null | undefined): Promise<string | null> {
  if (!token || !token.startsWith("v1.")) return null;
  try {
    const raw = b64urlDecode(token.slice(3));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(secretKey), raw.slice(12));
    return dec.decode(plain);
  } catch {
    return null;
  }
}

/** Show only the last 4 characters, e.g. ``••••abcd``. */
export function maskSecret(plaintext: string | null | undefined): string {
  if (!plaintext) return "";
  return plaintext.length > 8 ? "••••" + plaintext.slice(-4) : "••••";
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
