/** Build the LLM messages: system prompt (with retrieved context), recent history, question. */

import type { ChatMessage } from "../llm/client";
import type { SearchHit } from "../search/hybrid";
import { formatLongDate, formatLongDateTime, type ZonedTime } from "../util/time";

export const NO_ANSWER_TAG = "[[NO_ANSWER]]";
const NO_ANSWER_RE_SRC = "\\[\\[\\s*NO[_ ]ANSWER\\s*\\]\\]";
const MAX_CONTEXT_CHARS = 12_000;
const MANY_HITS = 7; // with more hits than this (list questions), each is cut to its first lines
const MANY_HITS_CHARS = 650;

function rsplitSpace(s: string): string {
  const i = s.lastIndexOf(" ");
  return i >= 0 ? s.slice(0, i) : s;
}

/**
 * Numbered context blocks with their source, trimmed to a safe total size.
 * ``keyFacts`` (the client's always-included key information) comes first, as block [0].
 */
export function formatContext(hits: SearchHit[], keyFacts = "", clientName = "", directory = ""): string {
  const blocks: string[] = [];
  if (keyFacts.trim()) blocks.push(`[0] Key information about ${clientName || "us"} (always applies)\n${keyFacts.trim()}`);
  if (directory) blocks.push(`[D] Directory: the names of all our pages (shops, services, …)\n${directory}`);
  if (!hits.length) return blocks.length ? blocks[0] : "(no relevant information found)";
  let used = blocks.reduce((n, b) => n + b.length, 0);
  const many = hits.length > MANY_HITS;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const label = hit.source_type === "web" ? hit.source : `document: ${hit.source}`;
    let content = hit.content.trim();
    if (many && content.length > MANY_HITS_CHARS) content = rsplitSpace(content.slice(0, MANY_HITS_CHARS)) + " …"; // list questions: the opening lines say what each page is
    const block = `[${i + 1}] ${hit.title || "Untitled"} (${label})\n${content}`;
    if (used + block.length > MAX_CONTEXT_CHARS && blocks.length) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join("\n\n");
}

/** Fill the known placeholders. Plain replacement so other braces in a custom prompt are harmless. */
export function renderSystemPrompt(template: string, botName: string, clientName: string, context: string, today: { year: number; month: number; day: number; weekday: number }): string {
  const values: [string, string][] = [
    ["{bot_name}", botName],
    ["{client_name}", clientName],
    ["{today}", formatLongDate(today)],
  ];
  let prompt = template;
  for (const [key, value] of values) prompt = prompt.split(key).join(value);
  if (prompt.includes("{context}")) return prompt.split("{context}").join(context);
  return `${prompt}\n\nCONTEXT:\n${context}`;
}

// Which documents may be used is chosen per document (the Use checkbox): every enabled document
// may answer questions on its subject, even one unrelated to the business.
export const DOCUMENTS_RULE =
  "ADDITIONAL RULE: Besides {client_name}'s own information, the CONTEXT may include uploaded documents (sources marked " +
  "\"document:\") on other subjects, for example another product's manual or a letter. Answer any question these documents " +
  "cover, even if the subject is unrelated to {client_name}, including partial information (for example what a product or " +
  "system does), instead of saying you have no information. For such subjects, explain neutrally instead of speaking as " +
  "{client_name}, and don't call the subject another company. Answer directly: don't begin with a disclaimer such as " +
  "\"I don't have information about this\" or \"this isn't related to us\". This includes documents about a part of the " +
  "subject: for example, if the visitor asks \"what is X?\" and a document describes X's API, wrapper or manual, answer with " +
  "what it says about X. State the information as plain facts, as if you simply know it: never mention documents, " +
  "documentation, files, sources or \"the information I have\" (no \"the documents describe…\", \"based on the " +
  "documentation…\", \"according to…\"). Never add facts that are not in the CONTEXT.";
export const DETAILS_RULE =
  "DETAILS RULE: When you give a number, email, address, time or code, say what it is (for example \"phone 0484 123 4567\", " +
  "\"shop number\", \"price\", \"booking ID\"), going by what the CONTEXT shows: a label such as \"Phone:\" or \"Email:\", " +
  "or the words around it. If the CONTEXT doesn't make clear what a number is, don't call it a phone number or anything " +
  "else; just give it as written. Reply like a friendly, helpful person at our front desk: natural, warm sentences, " +
  "not a robotic list of fields.";
export const LIST_RULE =
  "LIST RULE: The visitor wants a list (for example \"which shops sell shoes?\"). Include every match: the pages in the " +
  "CONTEXT and the names in the Directory [D]. A shop's page often doesn't say what it sells, so for well-known brands " +
  "use common knowledge of what they are known for (for example Skechers, Nike and Adidas sell footwear). Only name " +
  "shops, services or brands that appear in the CONTEXT or the Directory; never add others.";
export const SUBJECT_RULE =
  "SUBJECT RULE: When the visitor doesn't say which shop, product or service they mean and it isn't clear from the " +
  "conversation, they mean {client_name} itself: for example \"is it open?\" asks about {client_name}'s own opening hours, " +
  "not a shop's. Only give details of an individual shop, product or service when the visitor asks about it.";

/** ``history`` is a list of [question, answer] pairs, oldest first. */
export function buildMessages(
  template: string,
  botName: string,
  clientName: string,
  hits: SearchHit[],
  history: [string, string][],
  question: string,
  keyFacts: string,
  now: ZonedTime,
  directory = "",
): ChatMessage[] {
  const context = formatContext(hits, keyFacts, clientName, directory);
  let system = renderSystemPrompt(template, botName, clientName, context, now);
  const rules = [SUBJECT_RULE, DETAILS_RULE, DOCUMENTS_RULE, ...(directory ? [LIST_RULE] : [])];
  system += "\n\n" + rules.map((r) => r.split("{client_name}").join(clientName)).join("\n\n");
  // Lets the assistant answer "is it open now?"
  system += `\n\nCurrent local time: ${formatLongDateTime(now)} (${now.tzName || "local"}).`;
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const [q, a] of history) {
    messages.push({ role: "user", content: q });
    messages.push({ role: "assistant", content: a });
  }
  messages.push({ role: "user", content: question });
  return messages;
}

// Secondary signal for models that forget the tag: common "I don't know" phrasings.
const NO_INFO_RE =
  /\b(?:do(?:es)? not|don't|doesn't|cannot|can't|couldn't|unable to)\s+(?:have|find|provide|see|locate)\b[^.?!]{0,40}\b(?:information|details|info|answer)\b|\bno (?:information|details) (?:about|on|regarding)\b|\bnot (?:mentioned|available|provided) in the (?:context|information)\b/i;

const NO_INFO_MAX_CHARS = 300;

/** [clean answer, model said no answer]. */
export function parseAnswer(raw: string): [string, boolean] {
  let clean = raw.replace(new RegExp(NO_ANSWER_RE_SRC, "gi"), "").trim();
  // Some models wrap their reply in thinking tags; never show those.
  clean = clean.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // The "I don't have information" phrasing only counts for short replies: a long reply that opens
  // with a caveat and then answers from the content is an answer.
  const flagged = new RegExp(NO_ANSWER_RE_SRC, "i").test(raw) || (NO_INFO_RE.test(clean) && clean.length < NO_INFO_MAX_CHARS);
  return [clean, flagged];
}

export { NO_ANSWER_RE_SRC };
