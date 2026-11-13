// modelStream: fallback on errors, and a head start after which the next model races the first.
import { describe, expect, it } from "vitest";
import { modelStream, type StreamLLM } from "../src/chat/stream";
import { LLMError, modelConfig, type LLMResult, type ModelConfig } from "../src/llm/client";

const HEAD_START = 60;

function cfg(name: string): ModelConfig {
  return { ...modelConfig({ provider: "openai", model_name: name }), display_name: name };
}

function result(name: string, text: string): LLMResult {
  return { text, model_id: null, model_name: name, input_tokens: 1, output_tokens: 1, cost: 0, response_ms: 0 } as LLMResult;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new LLMError("cancelled"))));
  });

/** Fake models: name -> how long before the first word, or an error to throw. */
function fakeModels(spec: Record<string, { delay: number; fail?: boolean }>) {
  const started: string[] = [];
  const cancelled: string[] = [];
  const llm: StreamLLM = async function* (c, _messages, cancel) {
    const name = c.model_name;
    started.push(name);
    cancel?.addEventListener("abort", () => cancelled.push(name));
    await sleep(spec[name].delay, cancel);
    if (spec[name].fail) throw new LLMError(`${name} is down`);
    yield `answer from ${name}`;
    yield result(name, `answer from ${name}`);
  };
  return { llm, started, cancelled };
}

async function collect(llm: StreamLLM, names: string[]) {
  const items: [string | LLMResult, boolean][] = [];
  for await (const item of modelStream(llm, names.map(cfg), [], HEAD_START)) items.push(item);
  return { text: items.filter(([i]) => typeof i === "string").map(([i]) => i).join(""), fromFallback: items[0][1] };
}

describe("modelStream", () => {
  it("uses only the first model when it starts within its head start", async () => {
    const m = fakeModels({ a: { delay: 5 }, b: { delay: 5 } });
    expect(await collect(m.llm, ["a", "b"])).toEqual({ text: "answer from a", fromFallback: false });
    expect(m.started).toEqual(["a"]);
  });

  it("starts the next model when the first stalls, and cancels the slower one", async () => {
    const m = fakeModels({ a: { delay: 2000 }, b: { delay: 10 } });
    const t0 = Date.now();
    expect(await collect(m.llm, ["a", "b"])).toEqual({ text: "answer from b", fromFallback: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(m.started).toEqual(["a", "b"]);
    expect(m.cancelled).toEqual(["a"]);
  });

  it("keeps the first model's answer if it starts after the head start but before the next model", async () => {
    const m = fakeModels({ a: { delay: HEAD_START + 20 }, b: { delay: 500 } });
    expect(await collect(m.llm, ["a", "b"])).toEqual({ text: "answer from a", fromFallback: false });
    expect(m.cancelled).toEqual(["b"]);
  });

  it("falls back right away when the first model fails", async () => {
    const m = fakeModels({ a: { delay: 1, fail: true }, b: { delay: 1 } });
    expect(await collect(m.llm, ["a", "b"])).toEqual({ text: "answer from b", fromFallback: true });
  });

  it("throws the last error when every model fails", async () => {
    const m = fakeModels({ a: { delay: 1, fail: true }, b: { delay: 1, fail: true } });
    await expect(collect(m.llm, ["a", "b"])).rejects.toThrow("b is down");
  });

  it("with a single model, waits for it however long it takes", async () => {
    const m = fakeModels({ a: { delay: HEAD_START * 3 } });
    expect(await collect(m.llm, ["a"])).toEqual({ text: "answer from a", fromFallback: false });
  });
});
