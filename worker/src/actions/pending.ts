/**
 * Per-conversation action state, encrypted at rest (it holds personal data).
 *
 * * The *vault* maps placeholders the model sees (``[phone_1]``) to the visitor's real values.
 * * A *pending* action waits for the visitor's explicit confirmation (10-minute expiry).
 *   Only the server executes it, and only after a clear yes: the model can't skip this step.
 */

import type { ClientAction } from "../models";
import { decryptSecret, encryptSecret } from "../security/crypto";
import { first, nowIso, run } from "../util/db";

const PENDING_TTL_MS = 10 * 60_000;

// A clear yes or no is the whole message (after removing punctuation), not a word inside a sentence.
const YES = new Set([
  "yes", "y", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "correct", "go ahead",
  "yes please", "please do", "book it", "do it", "proceed", "yes book it", "yes confirm",
  "അതെ", "ശരി", "ഉവ്വ്", "ആം", "ഓക്കെ", "ശരി ബുക്ക് ചെയ്യൂ",
  "हाँ", "हां", "हा", "जी हाँ", "जी हां", "जी", "ठीक है", "हाँ जी", "haan", "han", "ha", "ji", "theek hai", "pakka",
]);
const NO = new Set([
  "no", "n", "nope", "cancel", "stop", "dont", "don't", "do not", "no thanks", "not now", "never mind", "nevermind",
  "വേണ്ട", "ഇല്ല", "റദ്ദാക്കുക",
  "नहीं", "नही", "ना", "मत करो", "रद्द करें", "nahi", "nahin", "na",
]);
// Python's [^\w\s'ऀ-ॿഀ-ൿ]: \w is letters, digits and underscore; the two script blocks keep their vowel signs.
const STRIP_RE = /[^\p{L}\p{N}_\s'ऀ-ॿഀ-ൿ]+/gu;

function normalize(text: string): string {
  return text.toLowerCase().replace(STRIP_RE, " ").split(/\s+/).filter(Boolean).join(" ");
}

export function isYes(text: string): boolean {
  return YES.has(normalize(text));
}

export function isNo(text: string): boolean {
  return NO.has(normalize(text));
}

// ----------------------------------------------------------------------------- storage
interface StateRow {
  vault_encrypted: string | null;
  pending_encrypted: string | null;
  pending_expires_at: string | null;
}

async function state(db: D1Database, clientId: number, sessionId: string): Promise<StateRow | null> {
  return first<StateRow>(db, "SELECT vault_encrypted, pending_encrypted, pending_expires_at FROM action_sessions WHERE client_id = ? AND session_id = ?", clientId, sessionId.slice(0, 64));
}

async function load(secret: string, token: string | null): Promise<any> {
  if (!token) return null;
  const plain = await decryptSecret(secret, token);
  return plain ? JSON.parse(plain) : null;
}

export async function loadVault(env: { DB: D1Database; SECRET_KEY: string }, clientId: number, sessionId: string): Promise<Record<string, string>> {
  const row = await state(env.DB, clientId, sessionId);
  return row ? { ...((await load(env.SECRET_KEY, row.vault_encrypted)) || {}) } : {};
}

export async function saveVault(env: { DB: D1Database; SECRET_KEY: string }, clientId: number, sessionId: string, vault: Record<string, string>): Promise<void> {
  if (!Object.keys(vault).length) return;
  const token = await encryptSecret(env.SECRET_KEY, JSON.stringify(vault));
  await run(
    env.DB,
    "INSERT INTO action_sessions (client_id, session_id, vault_encrypted, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (client_id, session_id) DO UPDATE SET vault_encrypted = excluded.vault_encrypted, updated_at = excluded.updated_at",
    clientId, sessionId.slice(0, 64), token, nowIso(),
  );
}

/** The action waiting for confirmation, or null (expired ones are dropped). */
export async function getPending(env: { DB: D1Database; SECRET_KEY: string }, clientId: number, sessionId: string): Promise<Record<string, any> | null> {
  const row = await state(env.DB, clientId, sessionId);
  if (!row || !row.pending_encrypted) return null;
  if (!row.pending_expires_at || row.pending_expires_at < nowIso()) {
    await clearPending(env.DB, clientId, sessionId);
    return null;
  }
  return load(env.SECRET_KEY, row.pending_encrypted);
}

export async function setPending(env: { DB: D1Database; SECRET_KEY: string }, clientId: number, sessionId: string, action: string, args: Record<string, any>, summary: string): Promise<void> {
  const token = await encryptSecret(env.SECRET_KEY, JSON.stringify({ action, args, summary }));
  const expires = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  await run(
    env.DB,
    "INSERT INTO action_sessions (client_id, session_id, pending_encrypted, pending_expires_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (client_id, session_id) DO UPDATE SET pending_encrypted = excluded.pending_encrypted, pending_expires_at = excluded.pending_expires_at, updated_at = excluded.updated_at",
    clientId, sessionId.slice(0, 64), token, expires, nowIso(),
  );
}

export async function clearPending(db: D1Database, clientId: number, sessionId: string): Promise<void> {
  await run(db, "UPDATE action_sessions SET pending_encrypted = NULL, pending_expires_at = NULL WHERE client_id = ? AND session_id = ? AND pending_encrypted IS NOT NULL", clientId, sessionId.slice(0, 64));
}

// ----------------------------------------------------------------------------- confirmation text
/** Enough for the visitor to recognise their details, without repeating them in full. */
function partlyHidden(kind: string, value: string): string {
  if (kind === "phone") {
    const digits = value.replace(/\D/g, "");
    return digits.length > 6 ? digits.slice(0, 2) + "x".repeat(Math.max(digits.length - 4, 3)) + digits.slice(-2) : "x".repeat(digits.length);
  }
  if (kind === "email" && value.includes("@")) {
    const at = value.indexOf("@");
    return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
  }
  return value;
}

/** Replace placeholders in a reply with partly hidden values the visitor recognises. */
export function displayPlaceholders(text: string, vault: Record<string, string>): string {
  return text.replace(/\[(phone|email)_\d+\]/g, (m, kind: string) => (m in vault ? partlyHidden(kind, vault[m]) : m));
}

/** Plain-language summary written by the server (not the model) from the validated parameters. */
export function confirmationSummary(action: ClientAction, params: Record<string, any>): string {
  const kinds = new Map((action.parameters || []).map((p) => [p.name, p.type || "string"]));
  const order = (action.parameters || []).map((p) => p.name as string).filter((n) => n in params);
  const details = order.map((name) => `${name.replace(/_/g, " ")}: ${partlyHidden(kinds.get(name) || "string", pyStr(params[name]))}`).join(", ");
  const words = action.name.replace(/_/g, " ");
  const title = words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  return `Please confirm: ${title}${details ? " (" + details + ")" : ""}. Reply yes to confirm or no to cancel.`;
}

/** str() of a JSON value as Python prints it (True/False for booleans). */
function pyStr(v: unknown): string {
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}
