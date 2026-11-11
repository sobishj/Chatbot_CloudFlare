// Pure helpers: the cases of tests/test_units.py (PII, language, text helpers, chunker, prompt,
// origins, security, scheduler, LLM options) plus the Cloudflare-specific pieces.
import { describe, expect, it } from "vitest";
import { detectLanguage } from "../src/chat/language";
import { maskPii, tokenizePii } from "../src/chat/pii";
import { buildMessages, NO_ANSWER_TAG, parseAnswer, renderSystemPrompt } from "../src/chat/prompt";
import { normalizeQuestion } from "../src/chat/service";
import { chunkText, ChunkBuilder } from "../src/indexer/chunker";
import { countTokens } from "../src/embeddings/embedder";
import { claudeOptions, fastThinking, modelConfig } from "../src/llm/client";
import { isLoopbackUrl, PROVIDERS } from "../src/llm/providers";
import { isListQuestion, keywordQuery, rrfMerge, words, type SearchHit } from "../src/search/hybrid";
import { decryptSecret, encryptSecret, maskSecret } from "../src/security/crypto";
import { hashPassword, passwordProblem, verifyPassword } from "../src/security/passwords";
import { ClientError, normalizeDomain, normalizeDomains, originAllowed, validateSlug } from "../src/services/clients";
import { isPrivateHost, urlTargetsPrivateNetwork } from "../src/util/netguard";
import { zonedNow } from "../src/util/time";
import { crawlDue } from "../src/worker/scheduler";

const SECRET = "unit-test-secret-key-0123456789abcdef";

function hit(id: number, sourceType: string, source: string, title: string, content: string, extra: Partial<SearchHit> = {}): SearchHit {
  return { chunk_id: id, source_type: sourceType, source, title, content, similarity: null, text_rank: null, score: 0, ...extra };
}

const noon = zonedNow("UTC", new Date(Date.UTC(2026, 9, 10, 12, 0)));

describe("PII", () => {
  it.each([
    ["my email is john.doe+x@example.co.in thanks", "my email is [email] thanks"],
    ["call me on +91 98470 12345", "call me on [phone]"],
    ["phone: (0484) 271-2345", "phone: [phone]"],
    ["9847012345", "[phone]"],
  ])("masks %s", (text, expected) => expect(maskPii(text)).toBe(expected));

  it.each(["Is it open on 2024-10-08?", "Timings 10:00 - 22:00", "Shop no 12 on floor 2", "Price is 1,500 rupees", "Open 09.00 - 23.00"])(
    "keeps non-personal numbers: %s",
    (text) => expect(maskPii(text)).toBe(text),
  );

  it("tokenizes with stable placeholders", () => {
    const vault: Record<string, string> = {};
    expect(tokenizePii("call +91 98470 12345 or mail a@b.co", vault)).toBe("call [phone_1] or mail [email_1]");
    expect(tokenizePii("again +91 98470 12345", vault)).toBe("again [phone_1]");
    expect(vault).toEqual({ "[email_1]": "a@b.co", "[phone_1]": "+91 98470 12345" });
  });
});

describe("language", () => {
  it.each([
    ["ASICS സ്റ്റോർ എവിടെയാണ്?", "ml"],
    ["मूवी कब है?", "hi"],
    ["أين المتجر؟", "ar"],
    ["Where is the ASICS store located in this mall?", "en"],
    ["hi", "en"],
  ])("%s → %s", (text, expected) => expect(detectLanguage(text, "en")).toBe(expected));

  it("short latin uses the default", () => expect(detectLanguage("ok", "ml")).toBe("ml"));
});

describe("text helpers", () => {
  it("words keep Malayalam combining marks", () => expect(words("ലുലു മാളിൽ ASICS?")).toEqual(["ലുലു", "മാളിൽ", "asics"]));
  it("normalize_question groups variants", () => expect(normalizeQuestion("Where is ASICS?")).toBe(normalizeQuestion("  where is   asics ")));
  it("keyword query drops stop words and quotes terms", () => {
    expect(keywordQuery("Where is the ASICS store?")).toBe('"asics" OR "store"');
    expect(keywordQuery("what is the")).toBeNull();
    expect(keywordQuery('say "hi" OR NOT x*')).toBe('"say" OR "hi"'); // FTS operators in user input stay plain words
  });
  it("rrf rewards agreement", () => {
    const a = [hit(1, "web", "u1", "", "x", { similarity: 0.9 }), hit(2, "web", "u2", "", "y", { similarity: 0.8 })];
    const b = [hit(2, "web", "u2", "", "y", { text_rank: 0.5 }), hit(3, "web", "u3", "", "z", { text_rank: 0.4 })];
    const merged = rrfMerge([a, b], 60, 3);
    expect(merged[0].chunk_id).toBe(2);
    expect(merged[0].similarity).toBe(0.8);
    expect(merged[0].text_rank).toBe(0.5);
  });
  it("list questions get more results", () => {
    expect(isListQuestion("which footwear shops are there?") && isListQuestion("List all restaurants")).toBe(true);
    expect(isListQuestion("what brands do you have for shoes") && isListQuestion("any shoe stores here?")).toBe(true);
    expect(isListQuestion("is it open now?") || isListQuestion("where is skechers?")).toBe(false);
  });
});

describe("chunker", () => {
  const byWords = (t: string) => t.split(/\s+/).filter(Boolean).length;
  it("respects size and overlap", () => {
    const text = Array.from({ length: 100 }, (_, i) => `Line ${i} ` + "word ".repeat(20)).join("\n");
    const chunks = chunkText(text, byWords, 100, 25);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(byWords(c)).toBeLessThanOrEqual(100);
    expect(chunks[1].split("\n")[0]).toBe(chunks[0].split("\n").at(-1));
  });
  it("splits very long lines", () => {
    const chunks = chunkText("word ".repeat(1200), byWords, 500, 50);
    expect(chunks.every((c) => byWords(c) <= 500)).toBe(true);
    expect(chunks.reduce((n, c) => n + byWords(c), 0)).toBeGreaterThanOrEqual(1200);
  });
  it("empty", () => expect(chunkText("   \n\n", byWords)).toEqual([]));
  it("chunking slice by slice gives the same chunks as all at once", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ` + "Some words here and there. ".repeat((i % 7) + 1)).join("\n");
    const whole = chunkText(text, countTokens);
    const builder = new ChunkBuilder(countTokens);
    const lines = text.split("\n");
    const pieces: string[] = [];
    for (let i = 0; i < lines.length; i += 37) pieces.push(...builder.addText(lines.slice(i, i + 37).join("\n")));
    pieces.push(...builder.finish());
    expect(pieces).toEqual(whole);
  });
  it("token estimate is conservative for Indic text", () => {
    expect(countTokens("hello world")).toBeGreaterThanOrEqual(2);
    expect(countTokens("ഞങ്ങളുടെ കട രാവിലെ 10 മണിക്ക് തുറക്കും")).toBeGreaterThan(10);
  });
});

describe("prompt", () => {
  it("placeholders, and other braces are safe", () => {
    expect(renderSystemPrompt("Hi {bot_name} for {client_name}. JSON {x: 1}. {context}", "Bot", "Acme", "CTX", noon)).toBe("Hi Bot for Acme. JSON {x: 1}. CTX");
    expect(renderSystemPrompt("No context placeholder", "B", "C", "CTX", noon).endsWith("CONTEXT:\nCTX")).toBe(true);
  });
  it("history and context", () => {
    const msgs = buildMessages("{context}", "Bot", "Acme", [hit(1, "web", "https://x/asics", "ASICS", "Second Floor")], [["q1", "a1"]], "q2", "", noon);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[0].content).toContain("Second Floor");
    expect(msgs[0].content).toContain("https://x/asics");
  });
  it("detects and strips the tag", () => {
    const [text, flagged] = parseAnswer(`Sorry, I don't have that information. ${NO_ANSWER_TAG}`);
    expect(flagged).toBe(true);
    expect(text).not.toContain(NO_ANSWER_TAG);
    expect(parseAnswer("<think>hmm</think>It is on the second floor.")).toEqual(["It is on the second floor.", false]);
  });
  it.each([
    ["I'm sorry, but I don't have that information. Please contact the mall.", true],
    ["I don't have information about helicopter pads at the mall.", true],
    ["Sorry, I couldn't find any details on that.", true],
    ["ASICS is on the Second Floor, open 10 AM to 10 PM.", false],
    ["We have information desks on every floor.", false],
  ])("untagged no-answer: %s", (reply, flagged) => expect(parseAnswer(reply as string)[1]).toBe(flagged));
  it("long answer with a caveat still counts", () => {
    const caveat = "I don't have information about KonfiPay itself. However, the documentation describes the KonfiPay Wrapper API: ";
    expect(parseAnswer(caveat + "it handles authentication, payments, bank accounts and file handling. ".repeat(4))[1]).toBe(false);
    expect(parseAnswer("Sorry, I don't have information about the weather.")[1]).toBe(true);
    expect(parseAnswer("Long answer ".repeat(50) + NO_ANSWER_TAG)[1]).toBe(true);
  });
  it("documents rule", () => {
    const system = buildMessages("{context}", "Bot", "Acme", [hit(1, "doc", "letter.pdf", "Letter", "The road will be repaired.")], [], "When?", "", noon)[0].content!;
    expect(system).toContain("ADDITIONAL RULE");
    expect(system).toContain("even if the subject is unrelated to Acme");
  });
  it("key facts first, subject rule and local time", () => {
    const shop = [hit(1, "web", "https://x/pizza", "Pizza Hut", "Shop timings 10 AM to 9 PM")];
    const now = zonedNow("Asia/Kolkata", new Date(Date.UTC(2026, 9, 10, 8, 35)));
    const system = buildMessages("{context}", "Bot", "Lulu Mall", shop, [], "is it open now?", "Open daily 9 AM to 11 PM.", now)[0].content!;
    expect(system.indexOf("[0] Key information about Lulu Mall")).toBeLessThan(system.indexOf("[1] Pizza Hut"));
    expect(system).toContain("SUBJECT RULE");
    expect(system).toContain("Lulu Mall's own opening hours");
    expect(system).toContain("Current local time: Saturday, 10 October 2026, 14:05 (IST)");
    expect(buildMessages("{context}", "Bot", "Acme", [], [], "hi", "Open 9-5", noon)[0].content).toContain("Key information");
    expect(buildMessages("{context}", "Bot", "Acme", shop, [], "hi", "", noon)[0].content).not.toContain("Key information");
  });
});

describe("clients / origins", () => {
  it.each([
    ["https://www.Example.com/path", "www.example.com"],
    ["example.com", "example.com"],
    ["*.example.com", "*.example.com"],
    ["localhost:5500", "localhost:5500"],
  ])("normalize_domain(%s)", (raw, expected) => expect(normalizeDomain(raw)).toBe(expected));
  it("rejects garbage", () => expect(() => normalizeDomain("not a domain!")).toThrow(ClientError));
  it.each([
    ["https://www.kochi.lulumall.in", ["kochi.lulumall.in"], true],
    ["https://kochi.lulumall.in", ["www.kochi.lulumall.in"], true],
    ["https://evil.com", ["kochi.lulumall.in"], false],
    ["https://kochi.lulumall.in.evil.com", ["kochi.lulumall.in"], false],
    ["https://shop.example.com", ["*.example.com"], true],
    ["https://example.com", ["*.example.com"], true],
    ["http://localhost:5500", ["localhost:5500"], true],
    ["http://localhost:8080", ["localhost:5500"], false],
    [null, ["example.com"], false],
    ["null", ["example.com"], false],
  ])("origin_allowed(%s)", (origin, allowed, ok) => expect(originAllowed(origin as string | null, allowed as string[])).toBe(ok));
  it("slug validation", () => {
    expect(validateSlug(" Lulu-Kochi ")).toBe("lulu-kochi");
    for (const bad of ["-x", "a b", "x".repeat(70), "ä"]) expect(() => validateSlug(bad)).toThrow(ClientError);
  });
  it("dedupes domains", () => expect(normalizeDomains(["a.com", "https://a.com/", ""])).toEqual(["a.com"]));
});

describe("security", () => {
  it("passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(passwordProblem("short") && passwordProblem("1234567890") && passwordProblem("long enough pass") === null).toBe(true);
  });
  it("secret encryption roundtrip", async () => {
    const token = await encryptSecret(SECRET, "sk-abcdef123456");
    expect(token).not.toContain("sk-abcdef");
    expect(await decryptSecret(SECRET, token)).toBe("sk-abcdef123456");
    expect(await decryptSecret(SECRET, "garbage")).toBeNull();
    expect(await decryptSecret("another-secret-key-0123456789abcdef", token)).toBeNull();
    expect(maskSecret("sk-abcdef123456")).toBe("••••3456");
  });
  it("loopback detection and provider presets", () => {
    expect(isLoopbackUrl("http://localhost:11434/v1") && isLoopbackUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isLoopbackUrl("http://host.docker.internal:7800/v1")).toBe(false);
    for (const k of ["openai", "anthropic", "gemini", "moonshot", "deepseek", "mistral", "groq", "openrouter", "deepinfra", "bionic", "ollama", "vllm", "lmstudio", "openai_compatible"]) expect(PROVIDERS[k]).toBeDefined();
    expect(["bionic", "ollama", "vllm", "lmstudio"].every((k) => !PROVIDERS[k].cloud)).toBe(true);
  });
  it("private network detection (SSRF guard and local models)", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "host.docker.internal", "printer.local", "db.internal", "100.64.0.1", "0.0.0.0"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ["api.openai.com", "8.8.8.8", "172.32.0.1", "example.com"]) expect(isPrivateHost(h)).toBe(false);
    expect(urlTargetsPrivateNetwork("http://2130706433/")).toBe(true); // 127.0.0.1 in decimal
    expect(urlTargetsPrivateNetwork("http://0x7f.0.0.1/")).toBe(true);
    expect(urlTargetsPrivateNetwork("https://api.deepinfra.com/v1/openai")).toBe(false);
  });
});

describe("scheduler", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => zonedNow("UTC", new Date(Date.UTC(y, mo - 1, d, h, mi)));
  const iso = (y: number, mo: number, d: number, h: number, mi: number) => new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString();
  it("daily", () => {
    const schedule = { frequency: "daily", time: "03:00" };
    expect(crawlDue(schedule, at(2026, 10, 8, 3, 5), "UTC", null)).toBe(true);
    expect(crawlDue(schedule, at(2026, 10, 8, 2, 59), "UTC", iso(2026, 10, 7, 3, 1))).toBe(false);
    expect(crawlDue(schedule, at(2026, 10, 8, 4, 0), "UTC", iso(2026, 10, 8, 3, 1))).toBe(false);
    expect(crawlDue(schedule, at(2026, 10, 9, 3, 0), "UTC", iso(2026, 10, 8, 3, 1))).toBe(true);
  });
  it("weekly and off", () => {
    const weekly = { frequency: "weekly", time: "03:00", weekday: 0 }; // Mondays
    const monday = at(2026, 10, 5, 3, 10);
    expect(crawlDue(weekly, monday, "UTC", iso(2026, 9, 28, 3, 1))).toBe(true);
    expect(crawlDue(weekly, at(2026, 10, 7, 12, 0), "UTC", iso(2026, 10, 5, 3, 10))).toBe(false);
    expect(crawlDue({ frequency: "off" }, monday, "UTC", null)).toBe(false);
  });
  it("in a time zone ahead of UTC", () => {
    const kolkata = zonedNow("Asia/Kolkata", new Date(Date.UTC(2026, 9, 7, 21, 35))); // 03:05 on the 8th in Kolkata
    expect(crawlDue({ frequency: "daily", time: "03:00" }, kolkata, "Asia/Kolkata", "2026-10-07T03:01:00+05:30")).toBe(true);
    expect(crawlDue({ frequency: "daily", time: "03:00" }, kolkata, "Asia/Kolkata", "2026-10-08T03:02:00+05:30")).toBe(false);
  });
});

describe("LLM options", () => {
  it.each([
    ["gemini", "gemini-3.5-flash", { thinkingConfig: { thinkingLevel: "minimal" } }],
    ["gemini", "gemini-3.5-flash-lite", { thinkingConfig: { thinkingLevel: "minimal" } }],
    ["gemini", "gemini-3.1-pro-preview", { thinkingConfig: { thinkingLevel: "low" } }],
    ["gemini", "gemini-2.5-flash", { thinkingConfig: { thinkingBudget: 0 } }],
    ["gemini", "gemini-2.0-flash", {}],
    ["gemini", "gemini-flash-latest", {}],
    ["gemini", "gemini-3.8-flash-tts", {}],
    ["openai", "gpt-4o-mini", {}],
  ])("fast thinking %s %s", (provider, model, expected) => expect(fastThinking(modelConfig({ provider, model_name: model }))).toEqual(expected));

  it.each([
    ["claude-haiku-5-5", true, true],
    ["claude-sonnet-5-5", true, true],
    ["claude-opus-5-5", true, true],
    ["claude-fable-5-1", true, true],
    ["claude-opus-4-8", true, true],
    ["claude-opus-4-6", false, true],
    ["claude-sonnet-4-6", false, true],
    ["claude-haiku-4-5", false, false],
    ["claude-haiku-4-5-20251001", false, false],
    ["claude-sonnet-4-20250514", false, false],
  ])("claude options %s", (model, noSampling, effort) => {
    const options = claudeOptions(modelConfig({ provider: "anthropic", model_name: model }));
    expect(Boolean(options._no_sampling)).toBe(noSampling);
    expect("output_config" in options).toBe(effort);
    expect(claudeOptions(modelConfig({ provider: "openai", model_name: model }))).toEqual({});
  });
});
