/**
 * Password hashing with PBKDF2-SHA256 (WebCrypto). Replaces Argon2id, which Workers can't run.
 *
 * Workers cap PBKDF2 at 100,000 iterations, and the free plan allows 10 ms of CPU per request:
 * 100,000 iterations take about 12 ms, and changing a password derives twice (check the current
 * one, hash the new one). 40,000 iterations (~5 ms) keep every request within the limit. The count
 * is stored in each hash, so raising ITERATIONS later re-hashes passwords at the next sign-in.
 */

import { b64urlDecode, b64urlEncode, safeEqual } from "./crypto";

export const ITERATIONS = 40_000;
export const MIN_PASSWORD_LENGTH = 10;
const enc = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2_sha256$${ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

/** True when ``password`` matches; never throws for bad input. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    const [algo, iters, salt, hash] = passwordHash.split("$");
    const iterations = Number(iters);
    if (algo !== "pbkdf2_sha256" || !Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return false;
    const actual = await derive(password, b64urlDecode(salt), iterations);
    return safeEqual(b64urlEncode(actual), hash);
  } catch {
    return false;
  }
}

export function needsRehash(passwordHash: string): boolean {
  const [algo, iters] = passwordHash.split("$");
  return algo !== "pbkdf2_sha256" || Number(iters) !== ITERATIONS;
}

/** A human-readable reason the password is too weak, or null if acceptable. */
export function passwordProblem(password: string): string | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (/^\p{Nd}+$/u.test(password)) return "Password must not be only digits.";
  return null;
}

// Verified against when the email is unknown, so response time doesn't reveal which emails exist.
// Precomputed (hash of "dummy-password-for-timing" at ITERATIONS) so it costs one derivation, like a real check.
export const DUMMY_HASH = "pbkdf2_sha256$40000$ha5aL8dMfHuxksLaKGn1hQ$hfermxMidjkP7I3kMt10uaf2bgIAxVtmlblEEwrsq_M";
