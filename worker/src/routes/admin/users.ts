/** Users & roles (super admin only). */

import type { Hono } from "hono";
import { all, first, run } from "../../util/db";
import { HttpError, json, readJson, validateBody } from "../../util/http";
import { createUser, getByEmail, getUser, newPassword, normalizeEmail, ROLES, setUserClients, UserError, userToDict } from "../../services/users";
import { requireSetupCompleted, requireSuperAdmin, type AppEnv, type C } from "../context";

async function listing(db: D1Database): Promise<Record<string, any>> {
  const ids = await all<{ id: number }>(db, "SELECT id FROM users ORDER BY name COLLATE NOCASE");
  const users = [];
  for (const { id } of ids) users.push(userToDict((await getUser(db, id))!));
  const clients = await all(db, "SELECT id, client_id, name FROM clients ORDER BY name COLLATE NOCASE");
  return { users, clients: clients.map((c) => ({ id: c.id, client_id: c.client_id, name: c.name })), roles: [...ROLES] };
}

async function activeSuperAdmins(db: D1Database): Promise<number> {
  return (await first<{ n: number }>(db, "SELECT count(id) AS n FROM users WHERE role = 'super_admin' AND active = 1"))?.n ?? 0;
}

async function guard(c: C) {
  await requireSetupCompleted(c);
  return requireSuperAdmin(c);
}

export function registerUsers(app: Hono<AppEnv>): void {
  app.get("/api/admin/users", async (c) => {
    await guard(c);
    return json(await listing(c.env.DB));
  });

  app.post("/api/admin/users", async (c) => {
    await guard(c);
    const body = validateBody(await readJson(c.req.raw), {
      name: { kind: "str", required: true },
      email: { kind: "str", required: true },
      password: { kind: "str", required: true },
      role: { kind: "str", required: true },
      client_ids: { kind: "list_int", default: [] },
    });
    if (!body.email.includes("@")) throw new HttpError(400, "Enter a valid email address.");
    await createUser(c.env.DB, body.name, body.email, body.password, body.role, body.client_ids);
    return json(await listing(c.env.DB));
  });

  app.patch("/api/admin/users/:user_id{[0-9]+}", async (c) => {
    const me = await guard(c);
    const db = c.env.DB;
    const body = validateBody(await readJson(c.req.raw), {
      name: { kind: "str", default: null },
      email: { kind: "str", default: null },
      role: { kind: "str", default: null },
      active: { kind: "bool", default: null },
      password: { kind: "str", default: null },
      client_ids: { kind: "list_int", default: null },
    });
    const user = await getUser(db, Number(c.req.param("user_id")));
    if (!user) throw new HttpError(404, "User not found.");
    const demoting = body.role !== null && body.role !== "super_admin" && user.role === "super_admin";
    const disabling = body.active === false && user.active && user.role === "super_admin";
    if ((demoting || disabling) && (await activeSuperAdmins(db)) <= 1) throw new HttpError(400, "There must always be at least one active super admin.");
    if (user.id === me.id && body.active === false) throw new HttpError(400, "You cannot disable your own account.");
    const u = { ...user };
    if (body.name !== null) {
      if (!body.name.trim()) throw new HttpError(400, "Name is required.");
      u.name = body.name.trim();
    }
    if (body.email !== null && normalizeEmail(body.email) !== user.email) {
      if (!body.email.includes("@") || (await getByEmail(db, body.email))) throw new HttpError(400, "Invalid email, or it is already in use.");
      u.email = normalizeEmail(body.email);
    }
    if (body.role !== null) {
      if (!ROLES.includes(body.role)) throw new UserError("Invalid role.");
      u.role = body.role;
    }
    if (body.active !== null) {
      u.active = body.active;
      if (!body.active) u.session_version += 1; // sign the user out everywhere
    }
    if (body.password) {
      const changed = await newPassword(u, body.password);
      u.password_hash = changed.password_hash;
      u.session_version = changed.session_version;
    }
    await run(
      db,
      "UPDATE users SET name = ?, email = ?, role = ?, active = ?, password_hash = ?, session_version = ? WHERE id = ?",
      u.name, u.email, u.role, u.active ? 1 : 0, u.password_hash, u.session_version, u.id,
    );
    if (u.role === "super_admin") await setUserClients(db, u.id, []);
    else if (body.client_ids !== null) await setUserClients(db, u.id, body.client_ids);
    return json(await listing(db));
  });
}
