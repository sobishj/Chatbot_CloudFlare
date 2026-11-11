/** Login / logout / current user. */

import type { Hono } from "hono";
import { clearSessionCookie, sessionCookie } from "../../security/sessions";
import { verifyPassword } from "../../security/passwords";
import * as rateLimit from "../../services/rate_limit";
import { getById } from "../../services/clients";
import { getSetting, getSettingsMap } from "../../services/settings";
import { authenticate, newPassword, UserError, userToDict } from "../../services/users";
import { run } from "../../util/db";
import { clientIp, HttpError, json, readJson, validateBody } from "../../util/http";
import { currentUser, requireUser, type AppEnv } from "../context";

export function registerAuth(app: Hono<AppEnv>): void {
  app.post("/api/admin/auth/login", async (c) => {
    const body = validateBody(await readJson(c.req.raw), { email: { kind: "str", required: true }, password: { kind: "str", required: true } });
    const limit = Number(((await getSetting(c.env.DB, "rate_limits")) || {}).login_per_ip_per_15min ?? 10);
    if (!(await rateLimit.hit(c.env.DB, `login:${clientIp(c.req.raw)}`, limit, 15 * 60))) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");
    }
    const user = await authenticate(c.env.DB, body.email, body.password);
    if (!user) throw new HttpError(401, "Incorrect email or password.");
    return json({ user: userToDict(user) }, 200, { "Set-Cookie": await sessionCookie(c.env.SECRET_KEY, c.req.raw, user.id, user.session_version) });
  });

  app.post("/api/admin/auth/logout", () => json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() }));

  /** Session bootstrap for the SPA: who am I, is setup done, which mode. */
  app.get("/api/admin/auth/me", async (c) => {
    const user = await currentUser(c);
    const values = await getSettingsMap(c.env.DB, ["setup_completed", "mode", "onprem_client_id"]);
    let onpremSlug: string | null = null;
    if (values.mode === "onprem" && values.onprem_client_id) {
      const client = await getById(c.env.DB, values.onprem_client_id);
      onpremSlug = client ? client.client_id : null;
    }
    return json({
      user: user ? userToDict(user) : null,
      setup_completed: Boolean(values.setup_completed),
      mode: values.mode,
      onprem_client_id: onpremSlug,
    });
  });

  app.post("/api/admin/auth/password", async (c) => {
    const user = await requireUser(c);
    const body = validateBody(await readJson(c.req.raw), { current_password: { kind: "str", required: true }, new_password: { kind: "str", required: true } });
    if (!(await verifyPassword(user.password_hash, body.current_password))) throw new HttpError(400, "Current password is incorrect.");
    let changed;
    try {
      changed = await newPassword(user, body.new_password);
    } catch (exc) {
      if (exc instanceof UserError) throw new HttpError(400, exc.message);
      throw exc;
    }
    await run(c.env.DB, "UPDATE users SET password_hash = ?, session_version = ? WHERE id = ?", changed.password_hash, changed.session_version, user.id);
    // Keep this session valid.
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(c.env.SECRET_KEY, c.req.raw, user.id, changed.session_version) });
  });
}
