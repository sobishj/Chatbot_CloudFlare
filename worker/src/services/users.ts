/** Admin users: creation, authentication and serialisation. */

import type { User } from "../models";
import { all, bool, first, inList, nowIso, run } from "../util/db";
import { UserFacingError } from "../util/http";
import { DUMMY_HASH, hashPassword, needsRehash, passwordProblem, verifyPassword } from "../security/passwords";

export const ROLES = ["super_admin", "client_admin"];

/** Validation error with a message safe to show in the UI. */
export class UserError extends UserFacingError {}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function withClients(db: D1Database, row: Record<string, any> | null): Promise<User | null> {
  if (!row) return null;
  const clients = await all<{ id: number; client_id: string; name: string }>(
    db,
    "SELECT c.id, c.client_id, c.name FROM user_clients uc JOIN clients c ON c.id = uc.client_id WHERE uc.user_id = ? ORDER BY c.id",
    row.id,
  );
  return { ...(row as User), active: bool(row.active), clients };
}

export async function getUser(db: D1Database, id: number): Promise<User | null> {
  return withClients(db, await first(db, "SELECT * FROM users WHERE id = ?", id));
}

export async function getByEmail(db: D1Database, email: string): Promise<User | null> {
  return withClients(db, await first(db, "SELECT * FROM users WHERE email = ?", normalizeEmail(email)));
}

export async function countUsers(db: D1Database): Promise<number> {
  return (await first<{ n: number }>(db, "SELECT count(*) AS n FROM users"))?.n ?? 0;
}

export async function setUserClients(db: D1Database, userId: number, clientIds: number[]): Promise<void> {
  const l = inList(clientIds);
  await db.batch([
    db.prepare("DELETE FROM user_clients WHERE user_id = ?").bind(userId),
    ...(clientIds.length
      ? [db.prepare(`INSERT OR IGNORE INTO user_clients (user_id, client_id) SELECT ?, id FROM clients WHERE id IN ${l.sql}`).bind(userId, ...l.params)]
      : []),
  ]);
}

export async function createUser(db: D1Database, name: string, email: string, password: string, role: string, clientIds: number[] = []): Promise<User> {
  if (!ROLES.includes(role)) throw new UserError("Invalid role.");
  if (!name.trim()) throw new UserError("Name is required.");
  if (await getByEmail(db, email)) throw new UserError("A user with this email already exists.");
  const problem = passwordProblem(password);
  if (problem) throw new UserError(problem);
  const row = await first<{ id: number }>(
    db,
    "INSERT INTO users (name, email, password_hash, role, active, session_version) VALUES (?, ?, ?, ?, 1, 1) RETURNING id",
    name.trim(),
    normalizeEmail(email),
    await hashPassword(password),
    role,
  );
  if (role === "client_admin" && clientIds.length) await setUserClients(db, row!.id, clientIds);
  return (await getUser(db, row!.id))!;
}

/** New password hash and bumped session version (logs out other sessions); caller stores them. */
export async function newPassword(user: User, password: string): Promise<{ password_hash: string; session_version: number }> {
  const problem = passwordProblem(password);
  if (problem) throw new UserError(problem);
  return { password_hash: await hashPassword(password), session_version: user.session_version + 1 };
}

/** The active user for valid credentials, else null. */
export async function authenticate(db: D1Database, email: string, password: string): Promise<User | null> {
  const user = await getByEmail(db, email);
  if (user === null) {
    await verifyPassword(DUMMY_HASH, password);
    return null;
  }
  if (!(await verifyPassword(user.password_hash, password)) || !user.active) return null;
  const now = nowIso();
  if (needsRehash(user.password_hash)) {
    user.password_hash = await hashPassword(password);
    await run(db, "UPDATE users SET password_hash = ?, last_login_at = ? WHERE id = ?", user.password_hash, now, user.id);
  } else {
    await run(db, "UPDATE users SET last_login_at = ? WHERE id = ?", now, user.id);
  }
  user.last_login_at = now;
  return user;
}

/** Client ids the user may access; null means all (super admin). */
export function accessibleClientIds(user: User): number[] | null {
  if (user.role === "super_admin") return null;
  return user.clients.map((c) => c.id);
}

export function userToDict(user: User): Record<string, any> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    clients: user.clients.map((c) => ({ id: c.id, client_id: c.client_id, name: c.name })),
  };
}
