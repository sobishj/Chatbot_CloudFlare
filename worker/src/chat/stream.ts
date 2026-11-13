/**
 * Streamed answers: the visitor sees the reply as the model writes it.
 *
 * The first words usually arrive within about a second, instead of after the whole answer
 * (2-3 s). Clients with API actions get the whole answer as one event, because a confirmation
 * has to be decided before anything is shown.
 */

import type { Env } from "../env";
import type { Client } from "../models";
import { LLMError, streamComplete, type ChatMessage, type LLMResult, type ModelConfig } from "../llm/client";
import { NO_ANSWER_RE_SRC, NO_ANSWER_TAG } from "./prompt";
import { actionsHook, defaultDeps, isAnswerFailure, prepareAnswer, type ChatDeps, type ChatResponse } from "./service";

export type StreamLLM = (cfg: ModelConfig, messages: ChatMessage[], cancel?: AbortSignal) => AsyncGenerator<string | LLMResult>;

const TAG_LETTERS = NO_ANSWER_TAG.toUpperCase().replace(/[\s_]/g, ""); // "[[NOANSWER]]"

/** Cut a trailing piece that could be the start of [[NO_ANSWER]] (it may still be completed). */
function holdBackTag(text: string): string {
  for (let start = Math.max(0, text.length - NO_ANSWER_TAG.length - 4); start < text.length; start++) {
    if (text[start] === "[" && TAG_LETTERS.startsWith(text.slice(start).toUpperCase().replace(/[\s_]/g, ""))) return text.slice(0, start);
  }
  return text;
}

/**
 * Turns the model's raw output into text that is safe to show while it is still being written:
 * hidden reasoning (<think>…</think>) and the [[NO_ANSWER]] tag never reach the visitor, even half-written.
 */
export class VisibleText {
  raw = "";
  sent = 0;

  private visible(): string {
    let text = this.raw.replace(/<think>[\s\S]*?<\/think>/g, "");
    if (text.includes("<think>")) {
      text = text.slice(0, text.indexOf("<think>")); // hidden reasoning still being written
    } else if (text.trim() && "<think>".startsWith(text.trim())) {
      return ""; // might be the start of "<think>"
    }
    text = text.replace(new RegExp(NO_ANSWER_RE_SRC, "gi"), "");
    return holdBackTag(text).replace(/^\s+/, "");
  }

  /** Add model output; return the new text to show (may be empty). */
  feed(piece: string): string {
    this.raw += piece;
    const visible = this.visible();
    if (visible.length <= this.sent) return "";
    const fresh = visible.slice(this.sent);
    this.sent = visible.length;
    return fresh;
  }
}

/**
 * If the model hasn't started its answer after this long, the next model in the chain starts
 * too and whichever writes first answers. Providers sometimes stall for 10-30 s before the first
 * word; without this the visitor waited it out (the fallback only stepped in on errors).
 */
export const HEAD_START_MS = 3000;

interface Racer {
  index: number;
  started: number;
  abort: AbortController;
  gen: AsyncGenerator<string | LLMResult>;
  first: Promise<IteratorResult<string | LLMResult>>;
}

type Outcome = { racer: Racer; res: IteratorResult<string | LLMResult> } | { racer: Racer; err: unknown } | { headStartOver: true };

/**
 * Stream from the models in priority order, yielding [item, whether a lower-priority model answers].
 *
 * A model that fails before writing hands over to the next; one that hasn't written anything
 * after ``headStartMs`` gets the next model racing it, and the loser is cancelled.
 */
export async function* modelStream(
  streamLlm: StreamLLM,
  chain: ModelConfig[],
  messages: ChatMessage[],
  headStartMs = HEAD_START_MS,
): AsyncGenerator<[string | LLMResult, boolean]> {
  const active: Racer[] = [];
  let next = 0;
  let lastError: unknown = null;
  const start = () => {
    const abort = new AbortController();
    const gen = streamLlm(chain[next], messages, abort.signal);
    const racer: Racer = { index: next++, started: Date.now(), abort, gen, first: gen.next() };
    racer.first.catch(() => {}); // a cancelled loser's failure is expected
    active.push(racer);
  };
  const cancelAll = (except?: Racer) => active.forEach((r) => r !== except && r.abort.abort());

  let winner: Racer | null = null;
  let res: IteratorResult<string | LLMResult> | null = null;
  while (!winner) {
    if (!active.length) {
      if (next >= chain.length) throw lastError ?? new LLMError("No AI model is configured. Add one in Settings → AI Models.");
      start();
    }
    const contenders: Promise<Outcome>[] = active.map((racer) => racer.first.then((r) => ({ racer, res: r }), (err) => ({ racer, err })));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (active.length === 1 && next < chain.length) {
      const wait = Math.max(0, headStartMs - (Date.now() - active[0].started));
      contenders.push(new Promise((resolve) => (timer = setTimeout(() => resolve({ headStartOver: true }), wait))));
    }
    const outcome = await Promise.race(contenders);
    clearTimeout(timer);
    if ("headStartOver" in outcome) {
      console.log(`Model ${chain[active[0].index].display_name} hasn't answered after ${headStartMs} ms; starting ${chain[next].display_name} too`);
      start();
    } else if ("err" in outcome) {
      active.splice(active.indexOf(outcome.racer), 1);
      if (!(outcome.err instanceof LLMError)) {
        cancelAll();
        throw outcome.err;
      }
      console.warn(`Model ${chain[outcome.racer.index].display_name} failed (${outcome.err.message})`);
      lastError = outcome.err;
    } else {
      winner = outcome.racer;
      res = outcome.res;
    }
  }
  cancelAll(winner);
  const fromFallback = winner.index > 0;
  while (!res!.done) {
    yield [res!.value, fromFallback];
    res = await winner.gen.next(); // a failure after the answer started is final
  }
}

export type StreamEvent = ["delta", string] | ["done", ChatResponse];

/** Yield ["delta", text] while the answer is written, then ["done", ChatResponse]. */
export async function* streamAnswer(
  env: Env,
  client: Client,
  sessionId: string,
  message: string,
  channel = "widget",
  confirm: boolean | null = null,
  deps: ChatDeps = defaultDeps,
  streamLlm: StreamLLM = (cfg, m, cancel) => streamComplete(cfg, m, null, cancel),
): AsyncGenerator<StreamEvent> {
  if (client.api_actions_enabled && actionsHook.answer) {
    const answered = await actionsHook.answer(env, client, sessionId, message, channel, confirm, deps);
    if (answered) {
      yield ["done", answered];
      return;
    }
  }
  const prepared = await prepareAnswer(env, client, sessionId, message, channel);
  const visible = new VisibleText();
  try {
    const [chain, messages] = await prepared.modelInputs(deps);
    let final: LLMResult | null = null;
    let usedFallback = false;
    for await (const [item, fromFallback] of modelStream(streamLlm, chain, messages)) {
      usedFallback = fromFallback;
      if (typeof item !== "string") final = item;
      else {
        const piece = visible.feed(item);
        if (piece) yield ["delta", piece];
      }
    }
    if (final === null) throw new LLMError("The model returned no answer.");
    prepared.apply(final, usedFallback);
  } catch (exc) {
    if (!isAnswerFailure(exc)) throw exc;
    prepared.fail(exc);
  }
  yield ["done", await prepared.finish()];
}
