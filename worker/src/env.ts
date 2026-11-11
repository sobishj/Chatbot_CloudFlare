/** Bindings and variables of the Worker (see wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  /** Workers KV: uploaded documents, logos and large extracted texts (see src/storage/files.ts). */
  FILES_KV: KVNamespace;
  ASSETS: Fetcher;
  /** `wrangler secret put SECRET_KEY`: encrypts API keys and signs sessions (32+ characters). */
  SECRET_KEY: string;
  /** Optional: when set, the admin UI API answers only on this host name (e.g. admin.example.com). */
  ADMIN_HOSTNAME?: string;
  /** Development only (.dev.vars): let model/API URLs point at this computer, for local mock servers. */
  DEV_ALLOW_PRIVATE_URLS?: string;
}

export const VERSION = "0.1.0";
