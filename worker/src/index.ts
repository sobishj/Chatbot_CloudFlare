/** Worker entry point: HTTP requests (public API, admin API, admin UI) and the per-minute scheduler. */

import type { Env } from "./env";
import { app } from "./app";
import { scheduledTick } from "./worker/scheduler";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduledTick(env, ctx);
  },
} satisfies ExportedHandler<Env>;
