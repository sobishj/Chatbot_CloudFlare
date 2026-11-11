// API actions (tests/test_actions.py and test_actions_openapi.py): tool loop, confirmations, validation,
// SSRF, rate limits, audit, placeholders, OpenAPI import; plus the fetch-based tool-calling adapters.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../src/actions/flow";
import { ActionError, checkTarget, validateParams } from "../src/actions/executor";
import { endpoints, parseText, suggestName } from "../src/actions/openapi";
import { answerQuestion, type ChatDeps } from "../src/chat/service";
import { completeWithTools, LLMError, modelConfig, ToolsUnsupported, type ChatMessage, type LLMResult, type ModelConfig, type ToolResult } from "../src/llm/client";
import type { Client, ClientAction } from "../src/models";
import { addTemplate, ActionConfigError, updateSettings } from "../src/services/actions";
import { saveModel } from "../src/services/ai_models";
import { createClient, getById } from "../src/services/clients";
import { setSetting, updateSettingDict } from "../src/services/settings";
import { all, first, run } from "../src/util/db";
import { newWorkersAIEmbedder } from "../src/embeddings/embedder";
import { resetDb, routeFetch, testEnv } from "./fakes";

const API_KEY = "sk-live-secret-1234";
const BASE = "https://booking.test/api";
const PHONE = "9876543210";
const BOOKING_ARGS = { doctor_id: 3, date: "2026-10-10", time: "09:30", patient_name: "Sobish", phone: "[phone_1]" };

type Step = string | [string, Record<string, any>][];

class FakeLLM {
  calls: [string, ChatMessage[]][] = [];
  constructor(public reply = "Fake answer.", public failModels = new Set<string>()) {}
  fn = async (cfg: ModelConfig, messages: ChatMessage[]): Promise<LLMResult> => {
    this.calls.push([cfg.model_name, messages]);
    if (this.failModels.has(cfg.model_name)) throw new LLMError(`${cfg.model_name} is unreachable`);
    return { text: this.reply, input_tokens: 100, output_tokens: 20, response_ms: 5, cost: 0.001, model_id: cfg.model_id, model_name: cfg.display_name || cfg.model_name };
  };
}

class FakeToolLLM {
  calls: { model: string; messages: ChatMessage[]; tools: any[] | null }[] = [];
  constructor(public script: Step[] = [], public unsupported = false, public failModels = new Set<string>()) {}
  fn = async (cfg: ModelConfig, messages: ChatMessage[], tools: any[] | null): Promise<ToolResult> => {
    this.calls.push({ model: cfg.model_name, messages: JSON.parse(JSON.stringify(messages)), tools });
    if (this.failModels.has(cfg.model_name)) throw new LLMError(`${cfg.model_name} is unreachable`);
    if (this.unsupported && tools && tools.length) throw new ToolsUnsupported(`${cfg.model_name} does not support tool calling`);
    const step = this.script.length ? this.script.shift()! : "Done.";
    let text = typeof step === "string" ? step : "";
    let toolCalls: ToolResult["tool_calls"] = [];
    if (typeof step !== "string") {
      if (tools && tools.length) toolCalls = step.map(([name, args], i) => ({ id: `call_${this.calls.length}_${i}`, name, arguments: args, raw_arguments: JSON.stringify(args) }));
      else text = "I couldn't finish that."; // no tools offered in the final round
    }
    return { text, input_tokens: 50, output_tokens: 10, response_ms: 3, cost: 0.0005, model_id: cfg.model_id, model_name: cfg.display_name || cfg.model_name, tool_calls: toolCalls };
  };
}

/** The client's booking API (like httpx.MockTransport in the Python tests). */
class BookingAPI {
  requests: { method: string; url: URL; headers: Headers; body: string }[] = [];
  nextId = 1001;
  route = async (url: URL, init: RequestInit) => {
    if (url.host !== "booking.test") return undefined;
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    this.requests.push({ method: init.method || "GET", url, headers, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (headers.get("X-API-Key") !== API_KEY) return json(401, { detail: "bad key" });
    const path = url.pathname.replace(/^\/api/, "");
    if (init.method === "GET" && path === "/slots") return json(200, { doctor_id: Number(url.searchParams.get("doctor_id")), date: url.searchParams.get("date"), free: ["09:30", "11:00"] });
    if (init.method === "POST" && path === "/appointments") return json(201, { booking_id: `B-${this.nextId++}`, patient_name: JSON.parse(body).patient_name });
    if (init.method === "DELETE" && path.startsWith("/appointments/")) return json(200, { cancelled: path.split("/").pop() });
    return json(404, { detail: "not found" });
  };
  made(method: string) {
    return this.requests.filter((r) => r.method === method);
  }
}

let env: ReturnType<typeof testEnv>;
let clinic: Client;
let api: BookingAPI;
let restore = () => {};

async function ask(message: string, tool: FakeToolLLM, llm = new FakeLLM(), session = "visitor-session-1", confirm: boolean | null = null) {
  const deps: ChatDeps = { llm: llm.fn, toolLlm: tool.fn, embedder: newWorkersAIEmbedder(env.AI as any, "@cf/baai/bge-m3") };
  clinic = (await getById(env.DB, clinic.id))!;
  return answerQuestion(env, clinic, session, message, "widget", confirm, deps);
}

describe("API actions", () => {
  beforeEach(async () => {
    await resetDb();
    env = testEnv();
    api = new BookingAPI();
    restore = routeFetch(api.route).restore;
    await saveModel(env.DB, env.SECRET_KEY, { name: "Main", provider: "openai_compatible", base_url: "https://llm.test/v1", model_name: "main-model" });
    clinic = await createClient(env.DB, "clinic", "City Clinic", "https://www.clinic.test", ["clinic.test"]);
    await updateSettings(env.DB, env.SECRET_KEY, clinic, { enabled: true, base_url: BASE, auth_type: "header", auth_name: "X-API-Key", api_key: API_KEY }, false);
    await addTemplate(env.DB, clinic);
  });
  afterEach(() => restore());

  it("with the feature off, answers exactly as before", async () => {
    await run(env.DB, "UPDATE clients SET api_actions_enabled = 0 WHERE id = ?", clinic.id);
    const tool = new FakeToolLLM();
    const llm = new FakeLLM("We open at 9.");
    const result = await ask("When do you open? Call me on 9876543210", tool, llm);
    expect(result.answer).toBe("We open at 9.");
    expect(tool.calls.length).toBe(0);
    expect(llm.calls.length).toBe(1);
    expect(result.confirmation).toBeNull();
    expect(llm.calls[0][1][0].content).not.toContain("LIVE ACTIONS");
    expect(llm.calls[0][1].at(-1)!.content).toContain("[phone]"); // unchanged masking
    expect(api.requests.length).toBe(0);
  });

  it("a GET action runs and the answer uses its result", async () => {
    const tool = new FakeToolLLM([[["get_slots", { doctor_id: 3, date: "2026-10-10" }]], "Dr. Anil is free at 09:30 and 11:00."]);
    const result = await ask("Is Dr. Anil free on 10 October?", tool);
    expect(result.answer).toBe("Dr. Anil is free at 09:30 and 11:00.");
    expect(result.answered).toBe(true);
    expect(result.actions_used).toEqual(["get_slots"]);
    const sent = api.made("GET")[0];
    expect(sent.headers.get("X-API-Key")).toBe(API_KEY);
    expect(sent.url.searchParams.get("date")).toBe("2026-10-10");
    const toolMessage = tool.calls[1].messages.at(-1)!;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.content).toContain("UNTRUSTED TOOL OUTPUT");
    expect(toolMessage.content).toContain("09:30");
    expect(tool.calls[0].messages[0].content).toContain("LIVE ACTIONS");
    const q = (await first<{ actions_used: string; input_tokens: number }>(env.DB, "SELECT actions_used, input_tokens FROM questions"))!;
    expect(JSON.parse(q.actions_used)).toEqual(["get_slots"]);
    expect(q.input_tokens).toBe(100); // both rounds counted
  });

  it("a booking needs confirmation, then runs on yes", async () => {
    const tool = new FakeToolLLM([[["book_appointment", BOOKING_ARGS]]]);
    const first1 = await ask(`Book Dr. Anil on 2026-10-10 at 09:30 for Sobish, phone ${PHONE}`, tool);
    expect(first1.confirmation?.action).toBe("book_appointment");
    expect(first1.answer).toContain("Please confirm");
    expect(first1.answer).toContain("98xxxxxx10");
    expect(first1.answer).not.toContain(PHONE);
    expect(api.made("POST").length).toBe(0); // nothing booked yet
    expect(JSON.stringify(tool.calls[0].messages)).not.toContain(PHONE);
    tool.script = ["Booked! Your booking ID is B-1001."];
    const second = await ask("Yes", tool);
    const posted = api.made("POST");
    expect(posted.length).toBe(1);
    expect(JSON.parse(posted[0].body).phone).toBe(PHONE); // real value only to the client's API
    expect(second.answer).toContain("B-1001");
    expect(tool.calls.at(-1)!.messages.at(-1)!.content).toContain("B-1001");
    tool.script = ["Is there anything else?"];
    await ask("yes", tool);
    expect(api.made("POST").length).toBe(1); // the pending action was used up
  });

  it("confirm buttons, cancel, other messages and Malayalam yes", async () => {
    const tool = new FakeToolLLM([[["book_appointment", BOOKING_ARGS]]]);
    await ask(`Book it, my number is ${PHONE}`, tool);
    expect((await ask("No", tool)).answer).toBe("Okay, I've cancelled that. Is there anything else I can help you with?");
    tool.script = [[["book_appointment", BOOKING_ARGS]]];
    await ask(`Book it, my number is ${PHONE}`, tool);
    expect((await ask("Cancel", tool, new FakeLLM(), undefined, false)).answer).toContain("cancelled");
    tool.script = [[["book_appointment", BOOKING_ARGS]], "Which doctor would you like instead?"];
    await ask(`Book it, ${PHONE}`, tool);
    await ask("Actually, a different doctor please", tool);
    tool.script = ["Okay."];
    await ask("yes", tool);
    expect(api.made("POST").length).toBe(0);
    tool.script = [[["book_appointment", BOOKING_ARGS]], "ബുക്ക് ചെയ്തു: B-1001"];
    await ask(`Book it, ${PHONE}`, tool);
    await ask("അതെ", tool);
    expect(api.made("POST").length).toBe(1);
  });

  it("a pending confirmation expires and is encrypted at rest", async () => {
    const tool = new FakeToolLLM([[["book_appointment", BOOKING_ARGS]]]);
    await ask(`Book it, ${PHONE}`, tool);
    const state = (await first<{ pending_encrypted: string }>(env.DB, "SELECT pending_encrypted FROM action_sessions"))!;
    expect(state.pending_encrypted).not.toContain(PHONE);
    await run(env.DB, "UPDATE action_sessions SET pending_expires_at = ?", new Date(Date.now() - 1000).toISOString());
    expect((await ask("Confirm", tool, new FakeLLM(), undefined, true)).answer).toBe("That request has expired. Please tell me again what you'd like to do.");
    expect(api.made("POST").length).toBe(0);
  });

  const action = (params: Record<string, any>): ClientAction =>
    ({ name: "a", method: "POST", path: "/x", parameters: Object.entries(params).map(([k, v]) => ({ name: k, ...v })) }) as any;

  it.each([
    [{ type: "date" }, "10/10/2026", "ISO date"],
    [{ type: "phone" }, "call me", "phone number"],
    [{ type: "email" }, "not-an-email", "email"],
    [{ type: "integer" }, "3.5", "whole number"],
    [{ type: "string", enum: ["cardiology", "ent"] }, "dentistry", "one of"],
    [{ type: "string" }, "x".repeat(501), "too long"],
    [{ type: "boolean" }, "maybe", "true or false"],
  ])("rejects bad parameter %j", (spec, value, message) => {
    expect(() => validateParams(action({ v: { location: "body", ...spec } }), { v: value })).toThrow(message);
  });

  it("required, unknown and cleaned parameters", () => {
    const a = action({ phone: { type: "phone", required: true, location: "body" }, day: { type: "date", location: "body" } });
    expect(() => validateParams(a, {})).toThrow("Missing required");
    expect(() => validateParams(a, { phone: PHONE, admin: true })).toThrow("Unknown parameter");
    expect(validateParams(a, { phone: "+91 98765-43210", day: "2026-10-10" })).toEqual({ phone: "+919876543210", day: "2026-10-10" });
  });

  it("invalid booking arguments are not made pending", async () => {
    const tool = new FakeToolLLM([[["book_appointment", { ...BOOKING_ARGS, date: "tomorrow" }]], "Which date exactly?"]);
    const result = await ask(`Book tomorrow, ${PHONE}`, tool);
    expect(result.confirmation).toBeNull();
    expect(result.answer).toBe("Which date exactly?");
    expect(tool.calls[1].messages.at(-1)!.content).toContain("Not run");
  });

  it.each(["https://10.0.0.5/v1", "https://172.16.3.4/v1", "https://192.168.1.1/v1", "https://127.0.0.1/v1", "https://169.254.169.254/", "https://[::1]/", "https://[fd00::1]/", "https://[::ffff:10.0.0.1]/", "https://localhost/", "https://db.internal/", "https://printer.local/"])(
    "SSRF: %s is blocked in cloud mode",
    (url) => {
      expect(() => checkTarget(url, false)).toThrow(/private or internal/);
      expect(() => checkTarget(url, true)).not.toThrow(); // on-premise may call internal APIs
    },
  );

  it("SSRF rules on save and https only", async () => {
    await expect(updateSettings(env.DB, env.SECRET_KEY, clinic, { base_url: "http://booking.test" }, false)).rejects.toThrow("https");
    await expect(updateSettings(env.DB, env.SECRET_KEY, clinic, { base_url: "https://10.1.2.3" }, false)).rejects.toThrow(ActionConfigError);
    expect(() => checkTarget("https://user:pw@api.test/", false)).toThrow("user name or password");
    expect(() => checkTarget("ftp://api.test/", true)).toThrow(ActionError);
  });

  it("redirects are not followed", async () => {
    restore();
    restore = routeFetch((url, init) => {
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } });
    }).restore;
    const result = await ask("Slots?", new FakeToolLLM([[["get_slots", { doctor_id: 3, date: "2026-10-10" }]], "Sorry."]));
    expect(result.action_results[0].error).toContain("redirect");
  });

  it("the tool loop stops after four rounds", async () => {
    const tool = new FakeToolLLM(Array.from({ length: 10 }, () => [["get_slots", { doctor_id: 3, date: "2026-10-10" }]] as Step));
    const result = await ask("Slots?", tool);
    expect(api.made("GET").length).toBe(4);
    expect(tool.calls.length).toBe(5);
    expect(tool.calls.at(-1)!.tools).toEqual([]);
    expect(result.answer).toBe("I couldn't finish that.");
  });

  it("a model without tool support falls back to a normal answer", async () => {
    const llm = new FakeLLM("Please call the clinic to book.");
    const result = await ask("Book an appointment", new FakeToolLLM([], true), llm);
    expect(result.answer).toBe("Please call the clinic to book.");
    expect(llm.calls[0][1][0].content).not.toContain("LIVE ACTIONS");
    expect(api.requests.length).toBe(0);
  });

  it("the fallback model is used when the primary fails", async () => {
    const backup = await saveModel(env.DB, env.SECRET_KEY, { name: "Backup", provider: "openai_compatible", base_url: "https://llm2.test/v1", model_name: "backup-model" });
    await setSetting(env.DB, "fallback_model_id", backup.id);
    const result = await ask("Hi", new FakeToolLLM(["Hello from the backup."], false, new Set(["main-model"])));
    expect(result.answer).toBe("Hello from the backup.");
    expect(result.used_fallback).toBe(true);
  });

  it("rate limits calls and confirmed changes", async () => {
    await updateSettingDict(env.DB, "rate_limits", { action_calls_per_session_per_hour: 2, confirmed_actions_per_session_per_day: 1 });
    const slots: [string, Record<string, any>] = ["get_slots", { doctor_id: 3, date: "2026-10-10" }];
    const result = await ask("Slots?", new FakeToolLLM([[slots, slots, slots], "Here you go."]), new FakeLLM(), "limits-session-1");
    expect(result.action_results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(result.action_results[2].error).toContain("Rate limit");
    const tool = new FakeToolLLM([[["book_appointment", BOOKING_ARGS]], "Booked B-1001.", [["book_appointment", BOOKING_ARGS]]]);
    await ask(`Book, ${PHONE}`, tool, new FakeLLM(), "limits-session-2");
    await ask("yes", tool, new FakeLLM(), "limits-session-2");
    await ask(`Book another, ${PHONE}`, tool, new FakeLLM(), "limits-session-2");
    expect((await ask("yes", tool, new FakeLLM(), "limits-session-2")).answer).toBe("Sorry, I can't make more changes in this conversation right now. Please contact us directly.");
    expect(api.made("POST").length).toBe(1);
  });

  it("calls are logged with masked personal data", async () => {
    const tool = new FakeToolLLM([[["book_appointment", { ...BOOKING_ARGS, patient_name: "Sobish sobish@example.com" }]], "Booked B-1001."]);
    await ask(`Book, ${PHONE}`, tool);
    await ask("yes", tool);
    const call = (await first<{ ok: number; status_code: number; action_name: string; question_id: number | null; request_summary: string }>(env.DB, "SELECT * FROM action_calls"))!;
    expect(call.ok).toBe(1);
    expect(call.status_code).toBe(201);
    expect(call.question_id).not.toBeNull();
    expect(call.request_summary).not.toContain(PHONE);
    expect(call.request_summary).not.toContain("sobish@example.com");
    expect(JSON.parse(call.request_summary).params.phone).toBe("[phone]");
    const texts = (await all<{ question: string }>(env.DB, "SELECT question FROM questions")).map((q) => q.question).join(" ");
    expect(texts).not.toContain(PHONE);
  });

  it("replies show placeholders partly hidden", async () => {
    const tool = new FakeToolLLM(["We'll call you on [phone_1] and email [email_1]."]);
    const result = await ask(`Call me on ${PHONE} or mail sobish@example.com`, tool);
    expect(result.answer).toBe("We'll call you on 98xxxxxx10 and email s***@example.com.");
    expect(tool.calls[0].messages.at(-1)!.content).toContain("[phone_1]");
  });
});

describe("OpenAPI import", () => {
  const SPEC = {
    openapi: "3.1.0",
    info: { title: "Mock booking API", version: "1.0" },
    paths: {
      "/slots": { get: { operationId: "slots_slots_get", summary: "Slots", parameters: [{ name: "doctor_id", in: "query", required: true, schema: { type: "integer" } }, { name: "date", in: "query", required: true, schema: { type: "string", format: "date" } }] } },
      "/appointments": {
        post: {
          operationId: "book_appointments_post",
          summary: "Book",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/BookingIn" } } } },
        },
      },
      "/appointments/{appointment_id}": { delete: { summary: "Cancel", parameters: [{ name: "appointment_id", in: "path", required: true, schema: { type: "string" } }] } },
    },
    components: {
      schemas: {
        BookingIn: {
          type: "object",
          required: ["doctor_id", "date", "phone"],
          properties: { doctor_id: { type: "integer" }, date: { type: "string", format: "date" }, phone: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
        },
      },
    },
  };

  it("turns the spec into ready-to-use actions", () => {
    const found = endpoints(SPEC);
    const byKey = Object.fromEntries(found.map((e) => [e.key, e]));
    expect(byKey["GET /slots"].action.name).toBe("get_slots");
    expect(byKey["POST /appointments"].action.name).toBe("create_appointments");
    expect(byKey["POST /appointments"].action.requires_confirmation).toBe(true);
    expect(byKey["POST /appointments"].action.parameters.map((p: any) => [p.name, p.type, p.required])).toEqual([["doctor_id", "integer", true], ["date", "date", true], ["phone", "phone", true]]);
    expect(byKey["POST /appointments"].notes.join(" ")).toContain("tags");
    expect(byKey["DELETE /appointments/{appointment_id}"].action.name).toBe("delete_appointments_by_appointment_id");
    expect(byKey["GET /slots"].action.description).toBe("Slots (GET /slots)");
  });

  it("parses YAML and rejects other files", () => {
    expect(parseText("openapi: 3.0.0\ninfo: {title: X}\npaths:\n  /x:\n    get: {summary: X}\n").paths["/x"]).toBeDefined();
    expect(() => parseText("<html>")).toThrow("isn't an OpenAPI");
    expect(() => parseText("")).toThrow("empty");
    expect(suggestName("GET", "/doctors/{doctor_id}/slots", "getDoctorSlots")).toBe("get_doctor_slots");
  });
});

describe("tool-calling adapters", () => {
  let restoreFetch = () => {};
  afterEach(() => restoreFetch());

  it("OpenAI-compatible: parses tool calls, invalid arguments are kept for validation", async () => {
    let sent: any;
    restoreFetch = routeFetch(async (_url, init) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        choices: [{ message: { content: null, tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_slots", arguments: '{"doctor_id": 3, "date": "2026-10-10"}' } },
          { id: "call_2", type: "function", function: { name: "get_slots", arguments: "{not json" } },
        ] } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    }).restore;
    const tools = [{ type: "function", function: { name: "get_slots", parameters: { type: "object", properties: {} } } }];
    const result = await completeWithTools(modelConfig({ provider: "openai", model_name: "gpt-4o-mini", api_key: "sk-test" }), [{ role: "user", content: "slots?" }], tools);
    expect(sent.tools).toEqual(tools);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.temperature).toBe(0.2);
    expect(result.tool_calls[0]).toMatchObject({ id: "call_1", name: "get_slots", arguments: { doctor_id: 3, date: "2026-10-10" } });
    expect(result.tool_calls[1].arguments._invalid_arguments).toBeDefined();
    expect(result.input_tokens).toBe(12);
    expect(result.cost).toBeGreaterThan(0); // bundled price list
  });

  it("detects models without tool support", async () => {
    restoreFetch = routeFetch(() => new Response('{"error": {"message": "tools is not supported for this model"}}', { status: 400 })).restore;
    const tools = [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }];
    await expect(completeWithTools(modelConfig({ provider: "openai", model_name: "gpt-4o-mini", api_key: "k" }), [{ role: "user", content: "hi" }], tools)).rejects.toBeInstanceOf(ToolsUnsupported);
  });

  it("Anthropic: system, tool_use/tool_result conversion and no temperature for current Claude", async () => {
    let sent: any;
    let headers: Headers;
    restoreFetch = routeFetch(async (url, init) => {
      expect(url.href).toBe("https://api.anthropic.com/v1/messages");
      headers = new Headers(init.headers);
      sent = JSON.parse(String(init.body));
      return Response.json({ content: [{ type: "thinking", thinking: "...", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "get_slots", input: { doctor_id: 3 } }], usage: { input_tokens: 20, output_tokens: 5 } });
    }).restore;
    const messages: ChatMessage[] = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "slots?" },
      { role: "assistant", content: null, tool_calls: [{ id: "confirmed_action", type: "function", function: { name: "book", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "confirmed_action", content: "ok" },
    ];
    const tools = [{ type: "function", function: { name: "get_slots", description: "Slots", parameters: { type: "object", properties: { doctor_id: { type: "integer" } } } } }];
    const result = await completeWithTools(modelConfig({ provider: "anthropic", model_name: "claude-haiku-5-5", api_key: "sk-ant" }), messages, tools);
    expect(headers!.get("x-api-key")).toBe("sk-ant");
    expect(sent.system).toBe("Be helpful.");
    expect(sent.temperature).toBeUndefined();
    expect(sent.output_config).toEqual({ effort: "low" });
    expect(sent.thinking).toBeUndefined(); // tool calling keeps thinking
    expect(sent.max_tokens).toBe(600 + 2000);
    expect(sent.messages[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "confirmed_action", name: "book", input: {} }] });
    expect(sent.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "confirmed_action", content: "ok" }] });
    expect(sent.tools[0]).toEqual({ name: "get_slots", description: "Slots", input_schema: tools[0].function.parameters });
    expect(result.tool_calls[0]).toMatchObject({ id: "toolu_1", name: "get_slots", arguments: { doctor_id: 3 } });
    expect(result.provider_content?.anthropic?.[0].type).toBe("thinking"); // sent back unchanged in the next round
  });

  it("Gemini: a rejected reasoning setting steps down minimal → low → none", async () => {
    const levels: unknown[] = [];
    restoreFetch = routeFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      levels.push(body.generationConfig.thinkingConfig ?? null);
      if (body.generationConfig.thinkingConfig) return new Response('{"error": {"code": 400, "message": "Thinking level is not supported for this model."}}', { status: 400 });
      return Response.json({ candidates: [{ content: { parts: [{ text: "Hi" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } });
    }).restore;
    const { complete } = await import("../src/llm/client");
    const result = await complete(modelConfig({ provider: "gemini", model_name: "gemini-3.5-flash", api_key: "k" }), [{ role: "user", content: "hi" }]);
    expect(result.text).toBe("Hi");
    expect(levels).toEqual([{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }, null]);
  });

  it("local model URLs fail fast with the Cloudflare message", async () => {
    const { complete, LOCAL_MODELS_MESSAGE } = await import("../src/llm/client");
    for (const base of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://host.docker.internal:7800/v1", "http://192.168.1.20:1234/v1"]) {
      await expect(complete(modelConfig({ provider: "ollama", model_name: "qwen", base_url: base }), [{ role: "user", content: "hi" }])).rejects.toThrow(LOCAL_MODELS_MESSAGE);
    }
  });
});
