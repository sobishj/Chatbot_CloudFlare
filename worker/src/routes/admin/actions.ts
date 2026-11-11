/**
 * Client → API actions: connection settings, action definitions, tests and the call log.
 *
 * client_admins may view (the key is always masked); every change and every live call
 * needs a super admin. Disabling keeps the configuration but stops its use at once.
 */

import type { Hono } from "hono";
import { toAction, type Client, type ClientAction, type User } from "../../models";
import { ActionError, allowPrivateTargets, buildRequest, execute, resultAsDict, send } from "../../actions/executor";
import { endpoints, fetchSpec, MAX_SPEC_BYTES, parseText, SpecError } from "../../actions/openapi";
import { ActionConfigError, actionToDict, addTemplate, listActions, listCalls, saveAction, settingsView, updateSettings } from "../../services/actions";
import { getById } from "../../services/clients";
import { getSetting } from "../../services/settings";
import { first, run, toJson } from "../../util/db";
import { HttpError, json, queryInt, readJson, validateBody } from "../../util/http";
import { clientForUser, requireSetupCompleted, requireSuperAdmin, type AppEnv, type C } from "../context";

async function view(c: C, client: Client, user: User): Promise<Record<string, any>> {
  client = (await getById(c.env.DB, client.id)) ?? client;
  const mode = await getSetting(c.env.DB, "mode");
  return {
    enabled: client.api_actions_enabled,
    settings: await settingsView(c.env.SECRET_KEY, client),
    actions: (await listActions(c.env.DB, client)).map(actionToDict),
    can_edit: user.role === "super_admin",
    mode,
    allows_private: allowPrivateTargets(mode),
  };
}

async function actionOr404(db: D1Database, client: Client, id: number): Promise<ClientAction> {
  const row = await first(db, "SELECT * FROM client_actions WHERE id = ?", id);
  if (!row || row.client_id !== client.id) throw new HttpError(404, "Action not found.");
  return toAction(row);
}

function bad(exc: unknown): never {
  if (exc instanceof ActionConfigError || exc instanceof SpecError) throw new HttpError(400, exc.message);
  throw exc;
}

export function registerActions(app: Hono<AppEnv>): void {
  const base = "/api/admin/clients/:client_id/api-actions";
  const forClient = async (c: C) => {
    await requireSetupCompleted(c);
    return clientForUser(c, c.req.param("client_id")!);
  };
  const forSuper = async (c: C) => {
    const { client } = await forClient(c);
    const user = await requireSuperAdmin(c);
    return { client, user };
  };
  const allowPrivate = async (c: C) => allowPrivateTargets(await getSetting(c.env.DB, "mode"));
  const dictBody = async (c: C) => validateBody({ body: await readJson(c.req.raw) }, { body: { kind: "dict", required: true } }).body;

  app.get(base, async (c) => {
    const { client, user } = await forClient(c);
    return json(await view(c, client, user));
  });

  app.put(`${base}/settings`, async (c) => {
    const { client, user } = await forSuper(c);
    const body = await dictBody(c);
    try {
      await updateSettings(c.env.DB, c.env.SECRET_KEY, client, body, await allowPrivate(c));
    } catch (exc) {
      bad(exc);
    }
    return json(await view(c, client, user));
  });

  app.post(`${base}/actions`, async (c) => {
    const { client, user } = await forSuper(c);
    const body = await dictBody(c);
    try {
      await saveAction(c.env.DB, client, body);
    } catch (exc) {
      bad(exc);
    }
    return json(await view(c, client, user));
  });

  /** Add the appointment-booking actions (only those that don't exist yet). */
  app.post(`${base}/actions/template`, async (c) => {
    const { client, user } = await forSuper(c);
    const added = await addTemplate(c.env.DB, client);
    return json({ ...(await view(c, client, user)), added });
  });

  /** List the endpoints of the client's OpenAPI/Swagger spec as action drafts (nothing is saved). */
  app.post(`${base}/openapi/discover`, async (c) => {
    const { client } = await forSuper(c);
    const body = validateBody(await readJson(c.req.raw), {
      spec_url: { kind: "str", default: null, max_length: 1000 },
      spec_text: { kind: "str", default: null, max_length: MAX_SPEC_BYTES },
    });
    let spec: Record<string, any>;
    let source: string;
    try {
      if (body.spec_text) {
        spec = parseText(body.spec_text);
        source = "uploaded file";
      } else {
        [spec, source] = await fetchSpec(c.env.SECRET_KEY, client, body.spec_url || (client.api_settings || {}).openapi_url || null, await allowPrivate(c));
        client.api_settings = { ...(client.api_settings || {}), openapi_url: source }; // remembered for next time
        await run(c.env.DB, "UPDATE clients SET api_settings = ? WHERE id = ?", toJson(client.api_settings), client.id);
      }
    } catch (exc) {
      bad(exc);
    }
    const settings = client.api_settings || {};
    const found = endpoints(spec!, settings.auth_name || "X-API-Key", settings.base_url || "");
    const existing = new Set((await listActions(c.env.DB, client)).map((a) => `${a.method} ${a.path}`));
    const info = spec!.info && typeof spec!.info === "object" ? spec!.info : {};
    return json({
      source: source!,
      title: String(info.title ?? ""),
      version: String(info.version ?? ""),
      endpoints: found.map((e) => ({ ...e, added: existing.has(`${e.method} ${e.path}`) })),
    });
  });

  /** Create actions from the chosen drafts. Each is validated like a hand-made action; bad ones are reported. */
  app.post(`${base}/openapi/import`, async (c) => {
    const { client, user } = await forSuper(c);
    const body = validateBody(await readJson(c.req.raw), { actions: { kind: "any", required: true } });
    if (!Array.isArray(body.actions) || body.actions.some((a: unknown) => !a || typeof a !== "object" || Array.isArray(a))) {
      throw new HttpError(422, [{ loc: ["body", "actions"], msg: "Input should be a valid list", type: "list_type" }]);
    }
    if (body.actions.length > 50) throw new HttpError(422, [{ loc: ["body", "actions"], msg: `List should have at most 50 items after validation, not ${body.actions.length}`, type: "too_long" }]);
    const added: string[] = [];
    const errors: string[] = [];
    for (const draft of body.actions as Record<string, any>[]) {
      try {
        await saveAction(c.env.DB, client, draft);
        added.push(String(draft.name));
      } catch (exc) {
        if (exc instanceof ActionConfigError) errors.push(`${draft.name || draft.path}: ${exc.message}`);
        else throw exc;
      }
    }
    return json({ ...(await view(c, client, user)), added, errors });
  });

  app.put(`${base}/actions/:action_id{[0-9]+}`, async (c) => {
    const { client, user } = await forSuper(c);
    const action = await actionOr404(c.env.DB, client, Number(c.req.param("action_id")));
    const body = await dictBody(c);
    try {
      await saveAction(c.env.DB, client, body, action);
    } catch (exc) {
      bad(exc);
    }
    return json(await view(c, client, user));
  });

  app.delete(`${base}/actions/:action_id{[0-9]+}`, async (c) => {
    const { client, user } = await forSuper(c);
    const action = await actionOr404(c.env.DB, client, Number(c.req.param("action_id")));
    await run(c.env.DB, "DELETE FROM client_actions WHERE id = ?", action.id);
    return json(await view(c, client, user));
  });

  app.post(`${base}/actions/:action_id{[0-9]+}/test`, async (c) => {
    const { client, user } = await forSuper(c);
    const action = await actionOr404(c.env.DB, client, Number(c.req.param("action_id")));
    const body = validateBody(await readJson(c.req.raw), { params: { kind: "dict", default: {} }, live: { kind: "bool", default: false } });
    if (action.method !== "GET" && !body.live) {
      throw new HttpError(400, "This action changes data in the client's live system. Tick “I understand this will call the live API” to run it.");
    }
    if (!(client.api_settings || {}).base_url) throw new HttpError(400, "Set the API URL first.");
    const result = await execute(c.env, client, action, body.params, { session_id: `admin-test-${user.id}`, channel: "admin", allow_private: await allowPrivate(c) });
    return json(resultAsDict(result));
  });

  /** GET the health path (or the API URL itself) with the configured authentication. */
  app.post(`${base}/test-connection`, async (c) => {
    const { client } = await forSuper(c);
    const settings = client.api_settings || {};
    if (!settings.base_url) throw new HttpError(400, "Set the API URL first.");
    let built;
    try {
      built = await buildRequest(c.env.SECRET_KEY, client, { method: "GET", path: settings.health_path || "", parameters: [] }, {});
    } catch (exc) {
      if (exc instanceof ActionError) return json({ ok: false, error: exc.message });
      throw exc;
    }
    const [resp, error, ms] = await send(client, built.method, built.url, built.headers, built.query, null, await allowPrivate(c));
    if (resp === null) return json({ ok: false, error, response_ms: ms });
    const ok = resp.status < 400;
    return json({ ok, status_code: resp.status, response_ms: ms, excerpt: (resp.text || "").slice(0, 300), error: ok ? null : `HTTP ${resp.status}` });
  });

  app.get(`${base}/calls`, async (c) => {
    const { client } = await forClient(c);
    const url = new URL(c.req.url);
    return json(await listCalls(c.env.DB, client, queryInt(url, "page", 1, 1), queryInt(url, "size", 25, 1, 100)));
  });
}
