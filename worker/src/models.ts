/** Typed rows of the D1 tables (JSON columns parsed, booleans as booleans). */

import { bool, boolOrNull, parseJson, type Row } from "./util/db";

export interface Client {
  id: number;
  client_id: string;
  name: string;
  website_url: string | null;
  allowed_domains: string[];
  branding: Record<string, any>;
  crawl_settings: Record<string, any>;
  document_settings: Record<string, any>;
  ai_model_id: number | null;
  active: boolean;
  last_crawl_at: string | null;
  created_at: string;
  api_actions_enabled: boolean;
  api_settings: Record<string, any>;
}

export function toClient(r: Row): Client {
  return {
    id: r.id,
    client_id: r.client_id,
    name: r.name,
    website_url: r.website_url ?? null,
    allowed_domains: parseJson(r.allowed_domains, []),
    branding: parseJson(r.branding, {}),
    crawl_settings: parseJson(r.crawl_settings, {}),
    document_settings: parseJson(r.document_settings, {}),
    ai_model_id: r.ai_model_id ?? null,
    active: bool(r.active),
    last_crawl_at: r.last_crawl_at ?? null,
    created_at: r.created_at,
    api_actions_enabled: bool(r.api_actions_enabled),
    api_settings: parseJson(r.api_settings, {}),
  };
}

export interface AIModelRow {
  id: number;
  name: string;
  provider: string;
  base_url: string | null;
  model_name: string;
  api_key_encrypted: string | null;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  cost_input_per_m: number | null;
  cost_output_per_m: number | null;
  last_test_ok: boolean | null;
  last_test_at: string | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export function toModel(r: Row): AIModelRow {
  return { ...(r as AIModelRow), last_test_ok: boolOrNull(r.last_test_ok) };
}

export interface User {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  active: boolean;
  session_version: number;
  last_login_at: string | null;
  created_at: string;
  clients: { id: number; client_id: string; name: string }[];
}

export interface ClientAction {
  id: number;
  client_id: number;
  name: string;
  description: string;
  method: string;
  path: string;
  parameters: Record<string, any>[];
  requires_confirmation: boolean;
  enabled: boolean;
  response_hint: string | null;
  created_at: string;
  updated_at: string;
}

export function toAction(r: Row): ClientAction {
  return {
    ...(r as ClientAction),
    parameters: parseJson(r.parameters, []),
    requires_confirmation: bool(r.requires_confirmation),
    enabled: bool(r.enabled),
  };
}

export interface Job {
  id: number;
  type: string;
  client_id: number | null;
  status: string;
  progress: number;
  progress_text: string | null;
  payload: Record<string, any>;
  result: Record<string, any> | null;
  log: string;
  error: string | null;
  cancel_requested: boolean;
  triggered_by: string;
  created_by_id: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  lock_until: string | null;
  // joined
  client_slug?: string | null;
  client_name?: string | null;
}

export function toJob(r: Row): Job {
  return {
    ...(r as Job),
    payload: parseJson(r.payload, {}),
    result: parseJson(r.result, null),
    cancel_requested: bool(r.cancel_requested),
  };
}

export interface DocumentRow {
  id: number;
  client_id: number;
  source: string;
  path: string;
  filename: string;
  file_hash: string | null;
  size_bytes: number;
  status: string;
  error: string | null;
  chunk_count: number;
  enabled: boolean;
  uploaded_at: string;
  indexed_at: string | null;
  r2_key: string | null;
  text_r2_key: string | null;
  text_hash: string | null;
}

export function toDocument(r: Row): DocumentRow {
  return { ...(r as DocumentRow), enabled: bool(r.enabled) };
}

export interface Question {
  id: number;
  client_id: number;
  session_id: string;
  channel: string;
  question: string;
  question_normalized: string;
  answer: string;
  sources: any[];
  answered: boolean;
  top_score: number | null;
  language: string | null;
  model_id: number | null;
  model_name: string | null;
  used_fallback: boolean;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  response_ms: number;
  error: string | null;
  actions_used: string[];
  created_at: string;
}

export function toQuestion(r: Row): Question {
  return {
    ...(r as Question),
    sources: parseJson(r.sources, []),
    answered: bool(r.answered),
    used_fallback: bool(r.used_fallback),
    actions_used: parseJson(r.actions_used, []),
  };
}
