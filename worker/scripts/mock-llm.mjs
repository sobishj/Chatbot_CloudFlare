// Development helper: a tiny OpenAI-compatible model server for end-to-end tests without API keys.
//   node scripts/mock-llm.mjs            (listens on http://127.0.0.1:8799/v1)
// Add it in Settings → AI Models as "Other OpenAI-compatible server" with base URL
// http://127.0.0.1:8799/v1 and model "mock" (needs DEV_ALLOW_PRIVATE_URLS=1 in .dev.vars).
// It answers from the CONTEXT it is given, streams word by word, and calls tools when offered.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8799);

function reply(messages, tools) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  const last = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const toolResults = messages.filter((m) => m.role === "tool");
  if (tools?.length && !toolResults.length) {
    const want = (n) => tools.find((t) => t.function.name === n);
    if (/book/i.test(last) && want("book_appointment")) {
      return { tool: { name: "book_appointment", arguments: { doctor_id: 1, date: "2026-12-01", time: "09:30", patient_name: "Test Patient", phone: "[phone_1]" } } };
    }
    if (/slot|free|available/i.test(last) && want("get_slots")) return { tool: { name: "get_slots", arguments: { doctor_id: 1, date: "2026-12-01" } } };
    if (/department/i.test(last) && want("list_departments")) return { tool: { name: "list_departments", arguments: {} } };
  }
  if (toolResults.length) return { text: `Done. The system said: ${toolResults[toolResults.length - 1].content.slice(0, 300)}` };
  const context = system.split("CONTEXT:")[1] || "";
  const words = last.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const line = context.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w)) && !l.startsWith("["));
  if (line) return { text: `We can help with that. ${line.trim()}` };
  return { text: "Sorry, I don't have that information right now. Please contact us directly. [[NO_ANSWER]]" };
}

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "mock" }, { id: "mock-large" }] }));
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404);
    return res.end("not found");
  }
  const data = JSON.parse(body || "{}");
  const out = reply(data.messages || [], data.tools);
  const usage = { prompt_tokens: Math.round(body.length / 4), completion_tokens: out.text ? out.text.split(" ").length : 10 };
  if (out.tool) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: out.tool.name, arguments: JSON.stringify(out.tool.arguments) } }] } }],
      usage,
    }));
  }
  if (data.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const word of out.text.split(/(?<= )/)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 15));
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out.text } }], usage }));
}).listen(PORT, "127.0.0.1", () => console.log(`Mock model server on http://127.0.0.1:${PORT}/v1`));
