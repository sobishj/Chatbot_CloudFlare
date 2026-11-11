/** Per-request helpers for routes: current user, role checks, client access, background work. */

import type { Context } from "hono";
import type { Env } from "../env";
import type { Client, User } from "../models";
import { readSession } from "../security/sessions";
import { getBySlug } from "../services/clients";
import { getSetting } from "../services/settings";
import { getUser } from "../services/users";
import { HttpError } from "../util/http";

export type AppEnv = { Bindings: Env; Variables: { user: User | null | undefined } };
export type C = Context<AppEnv>;

/** The logged-in, active user for this request, or null. */
export async function currentUser(c: C): Promise<User | null> {
  const cached = c.get("user");
  if (cached !== undefined) return cached;
  let user: User | null = null;
  const data = await readSession(c.env.SECRET_KEY, c.req.raw);
  if (data) {
    const row = await getUser(c.env.DB, data.u);
    if (row && row.active && row.session_version === data.v) user = row;
  }
  c.set("user", user);
  return user;
}

export async function requireUser(c: C): Promise<User> {
  const user = await currentUser(c);
  if (!user) throw new HttpError(401, "Please sign in.");
  return user;
}

export async function requireSuperAdmin(c: C): Promise<User> {
  const user = await requireUser(c);
  if (user.role !== "super_admin") throw new HttpError(403, "Only super admins can do this.");
  return user;
}

export async function requireSetupCompleted(c: C): Promise<void> {
  if (!(await getSetting(c.env.DB, "setup_completed"))) throw new HttpError(409, "setup_required");
}

export function canAccessClient(user: User, client: Client): boolean {
  return user.role === "super_admin" || user.clients.some((x) => x.id === client.id);
}

/**
 * Resolve ``{client_id}`` (slug) from the path, enforcing per-user access.
 * Inaccessible and missing clients both return 404, so client_admins can't probe which other clients exist.
 */
export async function clientForUser(c: C, slug: string): Promise<{ client: Client; user: User }> {
  const user = await requireUser(c);
  const client = await getBySlug(c.env.DB, slug);
  if (!client || !canAccessClient(user, client)) throw new HttpError(404, "Client not found.");
  return { client, user };
}

/** Run work after the response (job steps); errors are logged, never shown. */
export function background(c: C, work: Promise<unknown>): void {
  const guarded = work.catch((exc) => console.error("Background work failed", exc));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    /* no execution context (tests) */
  }
}
