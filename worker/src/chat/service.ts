/**
 * Answer a visitor question: search → prompt → model (with fallback) → log.
 *
 * Shared by the public chat API and the admin "Test chat" tab.
 */

import type { Env } from "../env";
import type { Client } from "../models";
import { EmbeddingAPIError, EmbeddingNotReady, getEmbedder, type Embedder } from "../embeddings/embedder";
import { complete, completeWithTools, LLMError, type ChatMessage, type LLMResult, type ModelConfig, type ToolResult } from "../llm/client";
import { isListQuestion, search, words, type SearchHit } from "../search/hybrid";
import { resolveChain } from "../services/ai_models";
import { branding, documentSettings } from "../services/clients";
import { getSettingsMap } from "../services/settings";
import { all, first, isoMinus, toJson } from "../util/db";
import { zonedNow, type ZonedTime } from "../util/time";
import { keyInformation, pageDirectory } from "./essentials";
import { detectLanguage } from "./language";
import { maskPii } from "./pii";
import { buildMessages, parseAnswer } from "./prompt";

export const MAX_MESSAGE_CHARS = 1000;
const HISTORY_PAIRS = 2; // last 4 messages = 2 questions + 2 answers
const HISTORY_WINDOW_MS = 2 * 3600_000;
const MAX_SOURCES = 3;

export const UNAVAILABLE_ANSWER = "Sorry, I can't answer right now. Please try again in a moment.";

export interface ChatResponse {
  answer: string;
  sources: Record<string, any>[];
  answered: boolean;
  confidence: number;
  model_name: string | null;
  used_fallback: boolean;
  response_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  language: string | null;
  question_id: number | null;
  error: string | null;
  hits: SearchHit[];
  // API actions only: a change waiting for the visitor's confirmation, what ran (Test chat
  // diagnostics) and the action names (logged with the question).
  confirmation: { action: string; summary: string } | null;
  action_results: Record<string, any>[];
  actions_used: string[];
}

export function newResponse(answer: string, language: string | null): ChatResponse {
  return {
    answer, sources: [], answered: false, confidence: 0, model_name: null, used_fallback: false, response_ms: 0,
    input_tokens: 0, output_tokens: 0, cost: 0, language, question_id: null, error: null, hits: [],
    confirmation: null, action_results: [], actions_used: [],
  };
}

/** Model calls, replaceable in tests. */
export interface ChatDeps {
  llm: (cfg: ModelConfig, messages: ChatMessage[]) => Promise<LLMResult>;
  toolLlm: (cfg: ModelConfig, messages: ChatMessage[], tools: any[] | null) => Promise<ToolResult>;
  embedder?: Embedder;
}

export const defaultDeps: ChatDeps = { llm: (cfg, m) => complete(cfg, m), toolLlm: (cfg, m, t) => completeWithTools(cfg, m, t) };

/**
 * Current time for questions like "is it open now?": the client's own time zone (Branding),
 * else the global one (Settings), else UTC.
 */
export function localNow(clientTimezone: string | null | undefined, globalTimezone?: string | null): ZonedTime {
  return zonedNow(clientTimezone || globalTimezone || "UTC");
}

/** Lower-case, strip punctuation and extra spaces: groups 'Where is ASICS?' with 'where is asics'. */
export function normalizeQuestion(text: string): string {
  return words(text).join(" ").slice(0, 500);
}

export async function loadHistory(db: D1Database, clientId: number, sessionId: string, channel: string): Promise<[string, string][]> {
  const rows = await all<{ question: string; answer: string }>(
    db,
    "SELECT question, answer FROM questions WHERE client_id = ? AND session_id = ? AND channel = ? AND created_at >= ? AND error IS NULL " +
      "ORDER BY created_at DESC, id DESC LIMIT ?",
    clientId,
    sessionId,
    channel,
    isoMinus(HISTORY_WINDOW_MS),
    HISTORY_PAIRS,
  );
  return rows.reverse().map((r) => [r.question, r.answer]);
}

/** Distinct sources of the best hits: web pages as links, documents by name. */
export function sourcesFromHits(hits: SearchHit[], limit = MAX_SOURCES): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.source)) continue;
    seen.add(hit.source);
    if (hit.source_type === "web") out.push({ type: "web", title: hit.title || hit.source, url: hit.source });
    else out.push({ type: "doc", title: hit.source });
    if (out.length >= limit) break;
  }
  return out;
}

/** Try the models in priority order; returns [result, whether a lower-priority model answered]. */
export async function callWithFallback(chain: ModelConfig[], messages: ChatMessage[], llm: ChatDeps["llm"]): Promise<[LLMResult, boolean]> {
  for (let i = 0; i < chain.length; i++) {
    try {
      return [await llm(chain[i], messages), i > 0];
    } catch (exc) {
      if (!(exc instanceof LLMError) || i + 1 === chain.length) throw exc;
      console.warn(`Model ${chain[i].display_name} failed (${exc.message}); trying ${chain[i + 1].display_name}`);
    }
  }
  throw new LLMError("No AI model is configured. Add one in Settings → AI Models.");
}

/** Errors that end an answer with the "can't answer right now" message (logged with the question). */
export function isAnswerFailure(exc: unknown): exc is Error {
  return exc instanceof LLMError || exc instanceof EmbeddingNotReady || exc instanceof EmbeddingAPIError;
}

export async function embedderFor(env: Env, deps: ChatDeps): Promise<Embedder> {
  if (deps.embedder) return deps.embedder;
  const { embedding } = await getSettingsMap(env.DB, ["embedding"]);
  return getEmbedder(env, embedding || {});
}

/** One plain (non-actions) answer in progress: shared by normal and streamed answers. */
export class PreparedAnswer {
  modelId: number | null = null;
  constructor(
    public env: Env,
    public client: Client,
    public sessionId: string,
    public channel: string,
    public question: string,
    public language: string | null,
    public settings: Record<string, any>,
    public response: ChatResponse,
    public started: number,
  ) {}

  /** Search, build the prompt and pick the models (in priority order). Throws LLMError / EmbeddingNotReady. */
  async modelInputs(deps: ChatDeps): Promise<[ModelConfig[], ChatMessage[]]> {
    const db = this.env.DB;
    const b = branding(this.client);
    const history = await loadHistory(db, this.client.id, this.sessionId, this.channel);
    const embedder = await embedderFor(this.env, deps);
    const result = await search(this.env, embedder, this.client.id, this.question, null, history.length ? history[history.length - 1][0] : null);
    this.response.hits = result.hits;
    this.response.confidence = Math.round(result.confidence * 10000) / 10000;
    const docSettings = documentSettings(this.client);
    const listQuestion = isListQuestion(this.question);
    const [keyInfo, directory] = await Promise.all([
      keyInformation(db, this.client.id, docSettings.key_facts || ""),
      listQuestion ? pageDirectory(db, this.client.id) : Promise.resolve(""),
    ]);
    const messages = buildMessages(this.settings.system_prompt, b.bot_name, this.client.name, result.hits, history, this.question, keyInfo, localNow(b.timezone, this.settings.timezone), directory);
    let chain = await resolveChain(db, this.env.SECRET_KEY, this.client);
    if (!chain.length) throw new LLMError("No AI model is configured. Add one in Settings → AI Models.");
    // Completeness needs the model's reasoning; other answers start faster without it.
    if (listQuestion) chain = chain.map((cfg) => ({ ...cfg, deep: true }));
    return [chain, messages];
  }

  apply(llmResult: LLMResult, usedFallback: boolean): void {
    const response = this.response;
    const [answer, flaggedNoAnswer] = parseAnswer(llmResult.text);
    response.answer = answer || UNAVAILABLE_ANSWER;
    response.answered = Boolean(answer) && !flaggedNoAnswer && response.hits.length > 0 && response.confidence >= Number(this.settings.confidence_threshold);
    response.sources = response.answered ? sourcesFromHits(response.hits) : [];
    response.model_name = llmResult.model_name;
    response.used_fallback = usedFallback;
    response.input_tokens = llmResult.input_tokens;
    response.output_tokens = llmResult.output_tokens;
    response.cost = llmResult.cost;
    this.modelId = llmResult.model_id;
  }

  fail(exc: Error): void {
    console.warn(`Chat failed for client ${this.client.client_id}: ${exc.message}`);
    this.response.answer = UNAVAILABLE_ANSWER;
    this.response.error = exc.message.slice(0, 1000);
    this.modelId = null;
  }

  async finish(): Promise<ChatResponse> {
    this.response.response_ms = Date.now() - this.started;
    await saveQuestion(this.env.DB, this.client, this.sessionId, this.channel, this.question, this.language, this.response, this.modelId);
    return this.response;
  }
}

export async function prepareAnswer(env: Env, client: Client, sessionId: string, message: string, channel: string): Promise<PreparedAnswer> {
  const question = [...maskPii(message.trim())].slice(0, MAX_MESSAGE_CHARS).join("");
  const b = branding(client);
  const settings = await getSettingsMap(env.DB, ["system_prompt", "confidence_threshold", "timezone"]);
  const language = detectLanguage(question, b.default_language || "en");
  return new PreparedAnswer(env, client, sessionId, channel, question, language, settings, newResponse(UNAVAILABLE_ANSWER, language), Date.now());
}

/** Log the (already masked) question and its answer; sets ``response.question_id``. */
export async function saveQuestion(
  db: D1Database,
  client: Client,
  sessionId: string,
  channel: string,
  question: string,
  language: string | null,
  response: ChatResponse,
  modelId: number | null,
): Promise<number> {
  const row = await first<{ id: number }>(
    db,
    "INSERT INTO questions (client_id, session_id, channel, question, question_normalized, answer, sources, answered, top_score, language, " +
      "model_id, model_name, used_fallback, input_tokens, output_tokens, cost, response_ms, error, actions_used, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    client.id,
    sessionId.slice(0, 64),
    channel,
    question,
    normalizeQuestion(question),
    response.answer,
    toJson(response.sources),
    response.answered ? 1 : 0,
    response.confidence,
    language,
    modelId,
    response.model_name,
    response.used_fallback ? 1 : 0,
    response.input_tokens,
    response.output_tokens,
    response.cost,
    response.response_ms,
    response.error,
    toJson(response.actions_used),
    new Date().toISOString(),
  );
  response.question_id = row!.id;
  return row!.id;
}

/** Hook for API actions (set by the actions module, so plain chat doesn't load it). */
export const actionsHook: {
  answer?: (env: Env, client: Client, sessionId: string, message: string, channel: string, confirm: boolean | null, deps: ChatDeps) => Promise<ChatResponse | null>;
} = {};

/** ``confirm`` is the widget's Confirm (true) / Cancel (false) button for a pending API action. */
export async function answerQuestion(
  env: Env,
  client: Client,
  sessionId: string,
  message: string,
  channel = "widget",
  confirm: boolean | null = null,
  deps: ChatDeps = defaultDeps,
): Promise<ChatResponse> {
  if (client.api_actions_enabled && actionsHook.answer) {
    const answered = await actionsHook.answer(env, client, sessionId, message, channel, confirm, deps);
    if (answered) return answered;
  }
  const prepared = await prepareAnswer(env, client, sessionId, message, channel);
  try {
    const [chain, messages] = await prepared.modelInputs(deps);
    const [llmResult, usedFallback] = await callWithFallback(chain, messages, deps.llm);
    prepared.apply(llmResult, usedFallback);
  } catch (exc) {
    if (!isAnswerFailure(exc)) throw exc;
    prepared.fail(exc);
  }
  return prepared.finish();
}
