/**
 * Every model call, through fetch-based provider adapters (they replace LiteLLM with the same behaviour):
 *
 * * OpenAI-compatible chat completions: openai, moonshot, deepseek, mistral, groq, openrouter,
 *   deepinfra, openai_compatible and the local providers (bionic, ollama, vllm, lmstudio);
 * * Anthropic Messages API (tool calls/results converted both ways);
 * * Google Gemini generateContent.
 *
 * All configuration comes from an ai_models row, so adding or switching models never needs a deploy.
 */

import type { AIModelRow } from "../models";
import { runtimeFlags } from "../runtime";
import { urlTargetsPrivateNetwork } from "../util/netguard";
import { getProvider } from "./providers";
import { listPrice } from "./prices";

export class LLMError extends Error {}

/** The provider or model rejected tool definitions; callers fall back to a plain answer. */
export class ToolsUnsupported extends LLMError {}

export const LOCAL_MODELS_MESSAGE =
  "Local model servers can't be reached from Cloudflare. Use a cloud provider, or expose the server on a public HTTPS URL.";


export interface LLMResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
  response_ms: number;
  cost: number;
  model_id: number | null;
  model_name: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  raw_arguments: string;
}

export interface ToolResult extends LLMResult {
  tool_calls: ToolCall[];
  /** Provider-native content of this reply (Claude thinking blocks, Gemini thought signatures), sent back unchanged. */
  provider_content?: ProviderContent;
}

export interface ProviderContent {
  anthropic?: any[];
  gemini?: any[];
}

/** OpenAI-style chat message (the format every caller builds). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  provider_content?: ProviderContent;
}

/** Everything needed to call a model, decoupled from the database row (also used for unsaved test configs). */
export interface ModelConfig {
  provider: string;
  model_name: string;
  base_url: string | null;
  api_key: string | null;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  cost_input_per_m: number | null;
  cost_output_per_m: number | null;
  model_id: number | null;
  display_name: string;
  // Let thinking models reason before answering (list questions). Otherwise thinking is
  // switched off where the model allows it: answers start about twice as fast.
  deep: boolean;
}

export function modelConfig(fields: Partial<ModelConfig> & { provider: string; model_name: string }): ModelConfig {
  return {
    base_url: null,
    api_key: null,
    temperature: 0.2,
    max_tokens: 600,
    timeout_seconds: 60,
    cost_input_per_m: null,
    cost_output_per_m: null,
    model_id: null,
    display_name: "",
    deep: false,
    ...fields,
  };
}

export function configFromRow(row: AIModelRow, apiKey: string | null): ModelConfig {
  return modelConfig({
    provider: row.provider,
    model_name: row.model_name,
    base_url: row.base_url,
    api_key: apiKey,
    temperature: row.temperature,
    max_tokens: row.max_tokens,
    timeout_seconds: row.timeout_seconds,
    cost_input_per_m: row.cost_input_per_m,
    cost_output_per_m: row.cost_output_per_m,
    model_id: row.id,
    display_name: row.name,
  });
}

const THINKING_HEADROOM = 2000; // extra max_tokens for hidden reasoning, so it never starves the visible answer

/** Reasoning/sampling settings of one call (what LiteLLM got as extra kwargs). */
interface CallOptions {
  temperature?: number;
  thinking?: Record<string, any>;
  output_config?: Record<string, any>;
  thinkingConfig?: Record<string, any>;
}

/**
 * Options and max_tokens for one call.
 *
 * Hidden reasoning counts against max_tokens. For quick answers it is switched off where the
 * model allows it; otherwise the cap gets THINKING_HEADROOM on top of the answer length.
 * ``allowQuick`` is false for tool calling, where thinking stays on (models with thinking off
 * occasionally write a tool call as plain text).
 */
function requestOptions(cfg: ModelConfig, maxTokens: number | null | undefined, allowQuick = true): [CallOptions, number] {
  const claude = claudeOptions(cfg);
  const opts: CallOptions = { ...fastThinking(cfg) };
  if (claude.output_config) opts.output_config = claude.output_config;
  if (!claude._no_sampling) opts.temperature = cfg.temperature;
  let mayThink = Boolean(claude._may_think) || geminiMayThink(cfg);
  if (claude._thinking_off && allowQuick && !cfg.deep) {
    opts.thinking = claude._thinking_off;
    mayThink = false;
  }
  return [opts, (maxTokens || cfg.max_tokens) + (mayThink ? THINKING_HEADROOM : 0)];
}

const CLAUDE_VERSION_RE = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/;

/**
 * Settings for current Claude models (sampling and effort).
 *
 * Claude Opus 4.7+, Sonnet 5+, Haiku 5+ and Fable/Mythos reject non-default sampling
 * parameters, so ``temperature`` is left out. Chat answers are short and grounded in the
 * retrieved context, so low effort gives faster replies without worse answers.
 */
export function claudeOptions(cfg: ModelConfig): Record<string, any> {
  if (cfg.provider !== "anthropic") return {};
  const match = CLAUDE_VERSION_RE.exec(cfg.model_name.toLowerCase());
  if (!match) return {};
  const family = match[1];
  const major = Number(match[2]);
  const minor = Number(match[3] || 0);
  const version = major + minor / 10;
  const noSampling = family === "fable" || family === "mythos" || (family === "opus" && version >= 4.7) || ((family === "sonnet" || family === "haiku") && version >= 5);
  const effort = noSampling || ((family === "opus" || family === "sonnet") && version >= 4.6);
  const options: Record<string, any> = {};
  if (noSampling) options._no_sampling = true;
  if (effort) options.output_config = { effort: "low" };
  // Models that think by default (adaptive thinking), and how to switch it off at our "low" effort:
  // Haiku 5.5 / Opus 5 / Sonnet 5 accept "disabled"; Sonnet 5.5 uses "between_tools";
  // Opus 5.5 and Fable/Mythos can't switch it off (effort is the only control).
  const thinksByDefault = family === "fable" || family === "mythos" || (["opus", "sonnet", "haiku"].includes(family) && version >= 5);
  if (thinksByDefault) {
    options._may_think = true;
    if (family === "sonnet" && version >= 5.5) options._thinking_off = { type: "between_tools" };
    else if (!(family === "fable" || family === "mythos" || (family === "opus" && version >= 5.5))) options._thinking_off = { type: "disabled" };
  }
  return options;
}

const GEMINI_VERSION_RE = /gemini-(\d+(?:\.\d+)?)/;
// Speech, image, live-audio and embedding models: not for chat, and they don't take reasoning settings.
export const GEMINI_NON_CHAT_RE = /tts|image|audio|live|embedding|veo|imagen|lyria|banana|robotics|computer-use|deep-research/i;

/**
 * Keep Gemini's hidden "thinking" to a minimum.
 *
 * Answers are short and grounded in the retrieved context, so deep reasoning adds
 * latency (about 1 s per answer) and cost without better answers. Thinking tokens
 * also count against max_tokens, which can cut answers short.
 */
export function fastThinking(cfg: ModelConfig): Record<string, any> {
  if (cfg.provider !== "gemini" || GEMINI_NON_CHAT_RE.test(cfg.model_name)) return {};
  const match = GEMINI_VERSION_RE.exec(cfg.model_name.toLowerCase());
  if (!match) return {};
  const version = Number(match[1]);
  const flash = cfg.model_name.toLowerCase().includes("flash");
  if (version >= 3) {
    // Gemini 3+ can't switch thinking off; Flash models support "minimal", Pro models "low".
    return { thinkingConfig: { thinkingLevel: flash ? "minimal" : "low" } };
  }
  if (version >= 2.5 && flash) return { thinkingConfig: { thinkingBudget: 0 } }; // 2.5 Flash can switch thinking off
  return {};
}

/** Gemini 2.5 Pro and 3+ always reason a little, and that counts against max_tokens. */
export function geminiMayThink(cfg: ModelConfig): boolean {
  if (cfg.provider !== "gemini" || GEMINI_NON_CHAT_RE.test(cfg.model_name)) return false;
  const match = GEMINI_VERSION_RE.exec(cfg.model_name.toLowerCase());
  if (!match) return false;
  const version = Number(match[1]);
  return version >= 3 || (version >= 2.5 && !cfg.model_name.toLowerCase().includes("flash"));
}

/** The admin-entered prices when set, otherwise the bundled list price (0 if unknown). */
export function estimateCost(cfg: ModelConfig, inputTokens: number, outputTokens: number): number {
  if (cfg.cost_input_per_m !== null || cfg.cost_output_per_m !== null) {
    return (inputTokens * (cfg.cost_input_per_m || 0) + outputTokens * (cfg.cost_output_per_m || 0)) / 1_000_000;
  }
  const price = listPrice(cfg.provider, cfg.model_name);
  if (!price) return 0;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

// ----------------------------------------------------------------------------- errors
/** An HTTP or network failure, named like the LiteLLM exception it replaces (for the same UI messages). */
export class ProviderError extends Error {
  constructor(
    public kind: string, // AuthenticationError, NotFoundError, Timeout, APIConnectionError, RateLimitError, BadRequestError, ...
    message: string,
    public status: number | null = null,
  ) {
    super(message);
  }
}

const EXCEPTION_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  deepseek: "Deepseek",
  mistral: "Mistral",
  groq: "Groq",
  openrouter: "Openrouter",
  deepinfra: "DeepInfra",
};

function kindForStatus(status: number): string {
  if (status === 400) return "BadRequestError";
  if (status === 401) return "AuthenticationError";
  if (status === 403) return "PermissionDeniedError";
  if (status === 404) return "NotFoundError";
  if (status === 408) return "Timeout";
  if (status === 422) return "UnprocessableEntityError";
  if (status === 429) return "RateLimitError";
  if (status === 503) return "ServiceUnavailableError";
  if (status >= 500) return "InternalServerError";
  return "APIError";
}

async function httpError(cfg: ModelConfig, resp: Response): Promise<ProviderError> {
  let body = "";
  try {
    body = (await resp.text()).replace(/\s*\n\s*/g, " ").trim();
  } catch {
    /* ignore */
  }
  const kind = kindForStatus(resp.status);
  const label = EXCEPTION_LABEL[cfg.provider] ?? "OpenAI";
  return new ProviderError(kind, `litellm.${kind}: ${label}Exception - ${body || resp.statusText || `HTTP ${resp.status}`}`, resp.status);
}

function networkError(cfg: ModelConfig, exc: unknown): ProviderError {
  const label = EXCEPTION_LABEL[cfg.provider] ?? "OpenAI";
  const err = exc as Error;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new ProviderError("Timeout", `litellm.Timeout: ${label}Exception - Request timed out after ${cfg.timeout_seconds} seconds.`);
  }
  return new ProviderError("APIConnectionError", `litellm.APIConnectionError: ${label}Exception - ${err?.message || String(exc)}`);
}

/** Turn provider/HTTP failures into a short message for the admin UI (no secrets). */
export function friendlyError(exc: unknown): string {
  const name = exc instanceof ProviderError ? exc.kind : (exc as Error)?.name || "Error";
  const message = String((exc as Error)?.message ?? exc).split("\n")[0].slice(0, 300);
  const hints: [string, string][] = [
    ["AuthenticationError", "Authentication failed: check the API key."],
    ["NotFoundError", "Model or URL not found: check the model name and base URL."],
    ["Timeout", "The model did not answer in time."],
    ["APIConnectionError", "Could not connect: check the base URL and that the server is running (inside Docker use host.docker.internal instead of localhost)."],
    ["RateLimitError", "The provider rate limit was reached."],
    ["BadRequestError", "The provider rejected the request."],
  ];
  for (const [key, hint] of hints) {
    if (name.includes(key)) return `${hint} (${message})`;
  }
  return `${name}: ${message}`;
}

const THINKING_KEYS = ["thinkingConfig", "thinking"] as const;

/** The provider refused a reasoning setting (e.g. a speech or image model, or an older model). */
function rejectsThinking(exc: unknown): boolean {
  if (!(exc instanceof ProviderError)) return false;
  return (exc.kind.includes("BadRequest") || exc.kind.includes("UnsupportedParams")) && /thinking/i.test(exc.message);
}

/** The next reasoning setting to try after a rejection: Gemini level minimal -> low -> none; otherwise none. */
function relaxed(opts: CallOptions): CallOptions | null {
  const level = opts.thinkingConfig?.thinkingLevel;
  if (level === "minimal") return { ...opts, thinkingConfig: { thinkingLevel: "low" } };
  if (THINKING_KEYS.some((k) => k in opts)) {
    const out = { ...opts };
    for (const k of THINKING_KEYS) delete out[k];
    return out;
  }
  return null;
}

// ----------------------------------------------------------------------------- endpoints
function baseUrl(cfg: ModelConfig): string {
  const provider = getProvider(cfg.provider);
  const base = (cfg.base_url || "").trim() || provider.default_base_url || "https://api.openai.com/v1";
  return base.replace(/\/+$/, "");
}

function guardPrivate(url: string): void {
  if (!runtimeFlags.allowPrivateUrls && urlTargetsPrivateNetwork(url)) throw new LLMError(LOCAL_MODELS_MESSAGE);
}

function anthropicUrl(base: string): string {
  return (base.endsWith("/v1") ? base : `${base}/v1`) + "/messages";
}

function geminiUrl(base: string, model: string, stream: boolean): string {
  const root = base.endsWith("/v1") || base.endsWith("/v1beta") ? base : `${base}/v1beta`;
  const name = model.replace(/^models\//, "");
  return `${root}/models/${encodeURIComponent(name).replace(/%2F/g, "/")}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}

const OPENAI_REASONING_RE = /^(o\d|gpt-5)/;

interface Built {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

function buildRequest(cfg: ModelConfig, messages: ChatMessage[], opts: CallOptions, cap: number, tools: any[] | null, stream: boolean): Built {
  const base = baseUrl(cfg);
  guardPrivate(base);
  if (cfg.provider === "anthropic") return buildAnthropic(cfg, base, messages, opts, cap, tools, stream);
  if (cfg.provider === "gemini") return buildGemini(cfg, base, messages, opts, cap, tools, stream);
  const provider = getProvider(cfg.provider);
  const key = cfg.api_key || (provider.openai_compatible ? "not-needed" : "");
  const body: Record<string, any> = { model: cfg.model_name, messages: messages.map(openaiMessage) };
  if (cfg.provider === "openai" && OPENAI_REASONING_RE.test(cfg.model_name)) body.max_completion_tokens = cap;
  else body.max_tokens = cap;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return { url: `${base}/chat/completions`, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body };
}

function openaiMessage(m: ChatMessage): Record<string, any> {
  const out: Record<string, any> = { role: m.role, content: m.content };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

function parseArgs(raw: string): Record<string, any> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function buildAnthropic(cfg: ModelConfig, base: string, messages: ChatMessage[], opts: CallOptions, cap: number, tools: any[] | null, stream: boolean): Built {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content || "").join("\n\n");
  const out: { role: string; content: any[] }[] = [];
  const push = (role: string, blocks: any[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") push("user", [{ type: "text", text: m.content || "" }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "" }]);
    else if (m.provider_content?.anthropic) push("assistant", m.provider_content.anthropic);
    else {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls || []) blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
      push("assistant", blocks.length ? blocks : [{ type: "text", text: "" }]);
    }
  }
  const body: Record<string, any> = { model: cfg.model_name, max_tokens: cap, messages: out };
  if (system) body.system = system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.thinking) body.thinking = opts.thinking;
  if (opts.output_config) body.output_config = opts.output_config;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
    body.tool_choice = { type: "auto" };
  }
  if (stream) body.stream = true;
  return {
    url: anthropicUrl(base),
    headers: { "x-api-key": cfg.api_key || "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body,
  };
}

/** Gemini accepts a subset of JSON Schema. */
function geminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    if (k === "format" && v !== "enum" && v !== "date-time") continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as any).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else if (k === "items") out[k] = geminiSchema(v);
    else out[k] = v;
  }
  return out;
}

function buildGemini(cfg: ModelConfig, base: string, messages: ChatMessage[], opts: CallOptions, cap: number, tools: any[] | null, stream: boolean): Built {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content || "").join("\n\n");
  const names = new Map<string, string>();
  const contents: { role: string; parts: any[] }[] = [];
  const push = (role: string, parts: any[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") push("user", [{ text: m.content || "" }]);
    else if (m.role === "tool") {
      push("user", [{ functionResponse: { name: names.get(m.tool_call_id || "") || "tool", response: { content: m.content || "" } } }]);
    } else {
      for (const c of m.tool_calls || []) names.set(c.id, c.function.name);
      if (m.provider_content?.gemini) push("model", m.provider_content.gemini);
      else {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        // Calls the server made on the model's behalf (a confirmed action) have no thought signature;
        // Google documents this placeholder for such injected calls.
        for (const c of m.tool_calls || []) parts.push({ functionCall: { name: c.function.name, args: parseArgs(c.function.arguments) }, thoughtSignature: "skip_thought_signature_validator" });
        push("model", parts.length ? parts : [{ text: "" }]);
      }
    }
  }
  const generationConfig: Record<string, any> = { maxOutputTokens: cap };
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
  if (opts.thinkingConfig) generationConfig.thinkingConfig = opts.thinkingConfig;
  const body: Record<string, any> = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools && tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => {
          const params = t.function.parameters;
          const decl: Record<string, any> = { name: t.function.name, description: t.function.description };
          if (params && Object.keys(params.properties || {}).length) decl.parameters = geminiSchema(params);
          return decl;
        }),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  return {
    url: geminiUrl(base, cfg.model_name, stream),
    headers: { "x-goog-api-key": cfg.api_key || "", "Content-Type": "application/json" },
    body,
  };
}

async function send(cfg: ModelConfig, built: Built, cancel?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(cfg.timeout_seconds * 1000);
  let resp: Response;
  try {
    resp = await fetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
    });
  } catch (exc) {
    throw networkError(cfg, exc);
  }
  if (!resp.ok) throw await httpError(cfg, resp);
  return resp;
}

/** POST the call; if the model rejects our reasoning setting, retry with a milder one, then none. */
async function sendWithRelax(
  cfg: ModelConfig,
  messages: ChatMessage[],
  opts: CallOptions,
  cap: number,
  tools: any[] | null,
  stream: boolean,
  cancel?: AbortSignal,
): Promise<Response> {
  let current: CallOptions = opts;
  for (;;) {
    try {
      return await send(cfg, buildRequest(cfg, messages, current, cap, tools, stream), cancel);
    } catch (exc) {
      const retry = rejectsThinking(exc) ? relaxed(current) : null;
      if (retry === null) throw exc;
      console.log(`${cfg.model_name} rejected the reasoning setting; retrying with a milder one`);
      current = retry;
    }
  }
}

// ----------------------------------------------------------------------------- parsing
interface Parsed {
  text: string;
  input: number;
  output: number;
  calls: ToolCall[];
  providerContent?: ProviderContent;
}

function parseResponse(cfg: ModelConfig, data: any): Parsed {
  try {
    if (cfg.provider === "anthropic") {
      const blocks: any[] = data.content || [];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b, i) => ({ id: b.id || `call_${i}`, name: b.name, arguments: b.input && typeof b.input === "object" ? b.input : {}, raw_arguments: JSON.stringify(b.input ?? {}) }));
      return { text, input: Number(data.usage?.input_tokens || 0), output: Number(data.usage?.output_tokens || 0), calls, providerContent: { anthropic: blocks } };
    }
    if (cfg.provider === "gemini") {
      const parts: any[] = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
      const calls = parts
        .filter((p) => p.functionCall?.name)
        .map((p, i) => ({ id: p.functionCall.id || `call_${i}`, name: p.functionCall.name, arguments: p.functionCall.args || {}, raw_arguments: JSON.stringify(p.functionCall.args || {}) }));
      const u = data.usageMetadata || {};
      return { text, input: Number(u.promptTokenCount || 0), output: Number(u.candidatesTokenCount || 0) + Number(u.thoughtsTokenCount || 0), calls, providerContent: { gemini: parts } };
    }
    const message = data.choices[0].message;
    const calls: ToolCall[] = [];
    (message.tool_calls || []).forEach((call: any, i: number) => {
      const name = call?.function?.name;
      if (!name) return;
      const raw = call.function.arguments ?? "{}";
      let args: any;
      try {
        args = typeof raw === "string" ? JSON.parse(raw) : { ...raw };
      } catch {
        args = { _invalid_arguments: String(raw).slice(0, 200) }; // rejected by validation, reported to the model
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) args = { _invalid_arguments: String(raw).slice(0, 200) };
      calls.push({ id: call.id || `call_${i}`, name, arguments: args, raw_arguments: typeof raw === "string" ? raw : JSON.stringify(raw) });
    });
    return {
      text: typeof message.content === "string" ? message.content : "",
      input: Number(data.usage?.prompt_tokens || 0),
      output: Number(data.usage?.completion_tokens || 0),
      calls,
    };
  } catch {
    throw new LLMError("The model returned an unexpected response.");
  }
}

function result(cfg: ModelConfig, text: string, input: number, output: number, ms: number): LLMResult {
  return {
    text: text.trim(),
    input_tokens: input,
    output_tokens: output,
    response_ms: ms,
    cost: estimateCost(cfg, input, output),
    model_id: cfg.model_id,
    model_name: cfg.display_name || cfg.model_name,
  };
}

// ----------------------------------------------------------------------------- public API
/** Call the model and return text + usage. Throws LLMError on any failure. */
export async function complete(cfg: ModelConfig, messages: ChatMessage[], maxTokens?: number | null): Promise<LLMResult> {
  const [opts, cap] = requestOptions(cfg, maxTokens);
  const started = Date.now();
  let data: any;
  try {
    const resp = await sendWithRelax(cfg, messages, opts, cap, null, false);
    data = await resp.json();
  } catch (exc) {
    if (exc instanceof LLMError) throw exc;
    throw new LLMError(friendlyError(exc));
  }
  const parsed = parseResponse(cfg, data);
  return result(cfg, parsed.text, parsed.input, parsed.output, Date.now() - started);
}

/**
 * Like complete(), but the model may answer with tool calls instead of text.
 *
 * With no ``tools`` it is a plain completion over a conversation that may contain earlier
 * tool calls and results. Throws ToolsUnsupported when the model can't use tools.
 */
export async function completeWithTools(cfg: ModelConfig, messages: ChatMessage[], tools: any[] | null, maxTokens?: number | null): Promise<ToolResult> {
  const [opts, cap] = requestOptions(cfg, maxTokens, false);
  const started = Date.now();
  let data: any;
  try {
    const resp = await sendWithRelax(cfg, messages, opts, cap, tools, false);
    data = await resp.json();
  } catch (exc) {
    if (exc instanceof LLMError) throw exc;
    const name = exc instanceof ProviderError ? exc.kind : "";
    if (tools && tools.length && (name.includes("UnsupportedParams") || (name.includes("BadRequest") && /\b(tool|function)/i.test(String((exc as Error).message))))) {
      throw new ToolsUnsupported(`${cfg.display_name || cfg.model_name} does not support tool calling (${friendlyError(exc)})`);
    }
    throw new LLMError(friendlyError(exc));
  }
  const parsed = parseResponse(cfg, data);
  return {
    ...result(cfg, parsed.text, parsed.input, parsed.output, Date.now() - started),
    tool_calls: tools && tools.length ? parsed.calls : [],
    provider_content: parsed.providerContent,
  };
}

async function* sseEvents(resp: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = "";
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
  if (data.length) yield { event, data: data.join("\n") };
}

/**
 * Like complete(), but yields the reply's text pieces as the model writes them, then one final
 * LLMResult (full text, usage, cost). Throws LLMError on failure.
 */
/** ``cancel`` stops the request (and the reading of its stream), e.g. when another model answered first. */
export async function* streamComplete(
  cfg: ModelConfig,
  messages: ChatMessage[],
  maxTokens?: number | null,
  cancel?: AbortSignal,
): AsyncGenerator<string | LLMResult> {
  const [opts, cap] = requestOptions(cfg, maxTokens);
  const started = Date.now();
  let text = "";
  let input = 0;
  let output = 0;
  try {
    const resp = await sendWithRelax(cfg, messages, opts, cap, null, true, cancel);
    for await (const ev of sseEvents(resp)) {
      if (ev.data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      let piece = "";
      if (cfg.provider === "anthropic") {
        if (chunk.type === "message_start") input = Number(chunk.message?.usage?.input_tokens || 0);
        else if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") piece = chunk.delta.text || "";
        else if (chunk.type === "message_delta") output = Number(chunk.usage?.output_tokens || output);
        else if (chunk.type === "error") throw new ProviderError("APIError", `litellm.APIError: AnthropicException - ${JSON.stringify(chunk.error)}`);
      } else if (cfg.provider === "gemini") {
        const parts: any[] = chunk.candidates?.[0]?.content?.parts || [];
        piece = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
        const u = chunk.usageMetadata;
        if (u) {
          input = Number(u.promptTokenCount || input);
          output = Number(u.candidatesTokenCount || 0) + Number(u.thoughtsTokenCount || 0) || output;
        }
      } else {
        if (chunk.error) throw new ProviderError("APIError", `litellm.APIError: ${EXCEPTION_LABEL[cfg.provider] ?? "OpenAI"}Exception - ${JSON.stringify(chunk.error)}`);
        piece = chunk.choices?.[0]?.delta?.content || "";
        if (chunk.usage) {
          input = Number(chunk.usage.prompt_tokens || input);
          output = Number(chunk.usage.completion_tokens || output);
        }
      }
      if (piece) {
        text += piece;
        yield piece;
      }
    }
  } catch (exc) {
    if (exc instanceof LLMError) throw exc;
    throw new LLMError(friendlyError(exc));
  }
  yield result(cfg, text, input, output, Date.now() - started);
}

/** Send a tiny prompt to verify URL, model name and API key. */
export function testConnection(cfg: ModelConfig): Promise<LLMResult> {
  return complete(
    cfg,
    [
      { role: "system", content: "You are a connection test. Reply with one short sentence." },
      { role: "user", content: "Say hello and state which model you are." },
    ],
    60,
  );
}

// ----------------------------------------------------------------------------- model lists
const MODEL_LIST_TTL = 600_000; // model lists rarely change, and the form refetches on every key edit
const modelListCache = new Map<string, [number, string[]]>();

/** Ask the provider which chat models this API key can use (each provider's ``/models`` endpoint). */
export async function listAvailableModels(providerKey: string, baseUrlIn: string | null, apiKey: string | null, timeout = 15, useCache = true): Promise<string[]> {
  const provider = getProvider(providerKey);
  const base = (baseUrlIn || provider.default_base_url || "").trim().replace(/\/+$/, "");
  if (!base) throw new LLMError("Enter the base URL first.");
  if (provider.needs_api_key && !apiKey) throw new LLMError("Enter the API key first.");
  guardPrivate(base);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${providerKey}\n${base}\n${apiKey || ""}`));
  const cacheKey = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cached = modelListCache.get(cacheKey);
  if (useCache && cached && Date.now() - cached[0] < MODEL_LIST_TTL) return cached[1];
  const names = await fetchModelList(providerKey, base, apiKey, timeout);
  modelListCache.set(cacheKey, [Date.now(), names]);
  return names;
}

async function getJsonWithRetry(url: string, headers: Record<string, string>, timeout: number): Promise<Response> {
  // Retries cover brief connection failures, like the shared HTTP client's transport retries before.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, { headers, signal: AbortSignal.timeout(timeout * 1000) });
    } catch (exc) {
      lastError = exc;
      if ((exc as Error)?.name === "TimeoutError") break;
    }
  }
  throw lastError;
}

async function fetchModelList(providerKey: string, base: string, apiKey: string | null, timeout: number): Promise<string[]> {
  let resp: Response;
  try {
    if (providerKey === "anthropic") {
      const url = base.endsWith("/v1") ? base : `${base}/v1`;
      resp = await getJsonWithRetry(`${url}/models?limit=1000`, { "x-api-key": apiKey || "", "anthropic-version": "2023-06-01" }, timeout);
    } else if (providerKey === "gemini") {
      const url = base.endsWith("/v1") || base.endsWith("/v1beta") ? base : `${base}/v1beta`;
      resp = await getJsonWithRetry(`${url}/models?pageSize=1000`, { "x-goog-api-key": apiKey || "" }, timeout);
    } else {
      resp = await getJsonWithRetry(`${base}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeout);
    }
  } catch (exc) {
    const err = exc as Error;
    throw new LLMError(
      "Could not connect: check the base URL and that the server is running " +
        `(inside Docker use host.docker.internal instead of localhost). (${err?.name === "TimeoutError" ? "ReadTimeout" : "ConnectError"}: ${String(err?.message ?? exc).slice(0, 200)})`,
    );
  }
  if (!resp.ok) {
    const code = resp.status;
    if (code === 401 || code === 403) throw new LLMError(`Authentication failed: check the API key. (HTTP ${code})`);
    if (code === 404) throw new LLMError("This server has no model list at that URL: check the base URL, or type the model name manually.");
    throw new LLMError(`The provider returned HTTP ${code}.`);
  }
  let names: string[];
  try {
    const data: any = await resp.json();
    if (providerKey === "anthropic") {
      names = (data.data || []).map((m: any) => m.id);
    } else if (providerKey === "gemini") {
      names = (data.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent") && !GEMINI_NON_CHAT_RE.test(m.name))
        .map((m: any) => String(m.name).replace(/^models\//, ""));
    } else {
      let items: any[] = data.data || [];
      // Some providers (e.g. DeepInfra) tag each model; keep only chat models when they do.
      const tags = (m: any) => (m?.metadata?.tags as string[] | undefined) || [];
      if (items.some((m) => tags(m).includes("chat"))) items = items.filter((m) => tags(m).includes("chat"));
      names = items.map((m) => m.id);
    }
    if (names.some((n) => typeof n !== "string")) throw new TypeError("bad name");
  } catch {
    throw new LLMError("The provider returned an unexpected model list.");
  }
  return [...new Set(names)].sort();
}
