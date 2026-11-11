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

export type StreamLLM = (cfg: ModelConfig, messages: ChatMessage[]) => AsyncGenerator<string | LLMResult>;

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

/** Stream from the models in priority order; one that fails before writing anything hands over to the next. */
async function* modelStream(streamLlm: StreamLLM, chain: ModelConfig[], messages: ChatMessage[]): AsyncGenerator<[string | LLMResult, boolean]> {
  for (let i = 0; i < chain.length; i++) {
    let wrote = false;
    try {
      for await (const item of streamLlm(chain[i], messages)) {
        wrote = wrote || typeof item === "string";
        yield [item, i > 0];
      }
      return;
    } catch (exc) {
      if (!(exc instanceof LLMError) || wrote || i + 1 === chain.length) throw exc;
      console.warn(`Model ${chain[i].display_name} failed (${exc.message}); trying ${chain[i + 1].display_name}`);
    }
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
  streamLlm: StreamLLM = (cfg, m) => streamComplete(cfg, m),
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
