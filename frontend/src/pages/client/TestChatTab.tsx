// Chat exactly as a visitor would, with diagnostics (confidence, model, timing, retrieved chunks).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiStream } from "../../api";
import { Badge, Button, Card, Empty } from "../../components/ui";
import { duration, money } from "../../format";
import type { TabProps } from "./ClientDetail";

interface Answer {
  answer: string;
  sources: { type: "web" | "doc"; title: string; url?: string }[];
  answered: boolean;
  confidence: number;
  threshold: number;
  model_name: string | null;
  used_fallback: boolean;
  response_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  language: string;
  error: string | null;
  chunks: { title: string; source: string; source_type: string; similarity: number | null; keyword: boolean; preview: string }[];
  confirmation: { action: string; summary: string } | null;
  action_results: { action: string; ok: boolean; status_code: number | null; error: string | null; response_ms: number; params: Record<string, unknown>; response: string | null }[];
}

type Turn = { question: string; answer?: Answer; partial?: string; failed?: string; decided?: boolean };

/** **bold** as the widget shows it; everything else stays plain text (no HTML from the model). */
// Same rule as the widget: http(s) URLs become links, without trailing punctuation.
const URL_RE = /(\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;

const withLinks = (text: string, key: string) =>
  text.split(URL_RE).map((part, i) =>
    i % 2 ? <a key={`${key}-${i}`} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part,
  );

const withBold = (text: string) =>
  text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{withLinks(part, String(i))}</strong> : withLinks(part, String(i))));

const newSession = () => "test-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

export function TestChatTab({ client }: TabProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(newSession);
  const [selected, setSelected] = useState<number | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const send = async (e?: FormEvent, button?: { text: string; confirm: boolean }) => {
    e?.preventDefault();
    const q = button ? button.text : input.trim();
    if (!q || busy) return;
    if (!button) setInput("");
    setBusy(true);
    const index = turns.length;
    // Any new message settles an open confirmation (the server drops it too).
    setTurns((t) => [...t.map((x) => (x.answer?.confirmation ? { ...x, decided: true } : x)), { question: q }]);
    let received = false;
    const ask = () => apiStream(`/api/admin/clients/${client.client_id}/test-chat/stream`, { session_id: session, message: q, confirm: button?.confirm ?? null }, (ev) => {
      received = true;
        if (ev.t === "delta") {
          setTurns((t) => t.map((x, i) => (i === index ? { ...x, partial: (x.partial ?? "") + ev.text } : x)));
        } else if (ev.t === "done") {
          const { t: _kind, ...answer } = ev;
          setTurns((t) => t.map((x, i) => (i === index ? { ...x, answer: answer as Answer, partial: undefined } : x)));
          setSelected(index);
        }
      });
    try {
      // Streamed like the widget: the answer appears word by word, diagnostics come with the last event.
      try {
        await ask();
      } catch (err) {
        // Couldn't reach the server (e.g. it was restarting): try once more before showing an error.
        if (!(err instanceof ApiError && err.status === 0) || received) throw err;
        await new Promise((r) => setTimeout(r, 1500));
        await ask();
      }
    } catch (err) {
      setTurns((t) => t.map((x, i) => (i === index ? { ...x, failed: (err as Error).message } : x)));
    } finally {
      setBusy(false);
    }
  };

  const current = selected !== null ? turns[selected]?.answer : undefined;

  return (
    <div className="grid split-chat">
      <Card title="Test chat" subtitle="Same pipeline as the widget. Logged as “test” and excluded from statistics." actions={<Button size="sm" onClick={() => { setTurns([]); setSession(newSession()); setSelected(null); }}>New conversation</Button>} bodyless>
        <div className="chat">
          <div className="chat-log" ref={log} aria-live="polite">
            {client.branding.greeting && <div className="bubble bot">{client.branding.greeting}</div>}
            {turns.map((t, i) => (
              <div key={i} style={{ display: "contents" }}>
                <div className="bubble user">{t.question}</div>
                {t.answer && (
                  <div className="bubble bot" style={{ cursor: "pointer", outline: selected === i ? "2px solid var(--accent-soft)" : undefined }} onClick={() => setSelected(i)}>
                    {withBold(t.answer.answer)}
                    {t.answer.confirmation && (
                      <div className="row" style={{ marginTop: 8 }}>
                        <Button size="sm" kind="primary" disabled={t.decided || busy} onClick={(ev) => { ev.stopPropagation(); send(undefined, { text: "Confirm", confirm: true }); }}>Confirm</Button>
                        <Button size="sm" disabled={t.decided || busy} onClick={(ev) => { ev.stopPropagation(); send(undefined, { text: "Cancel", confirm: false }); }}>Cancel</Button>
                      </div>
                    )}
                    <div className="meta">
                      <Badge color={t.answer.answered ? "green" : "amber"}>{t.answer.answered ? "Answered" : "Unanswered"}</Badge>
                      {t.answer.action_results.length > 0 && <Badge color="blue">{t.answer.action_results.length} action{t.answer.action_results.length > 1 ? "s" : ""}</Badge>}
                      <span>confidence {t.answer.confidence.toFixed(2)}</span>
                      <span>{t.answer.model_name ?? "no model"}{t.answer.used_fallback ? " (fallback)" : ""}</span>
                      <span>{duration(t.answer.response_ms)}</span>
                    </div>
                  </div>
                )}
                {t.failed && <div className="bubble bot" style={{ color: "var(--danger)" }}>{t.failed}</div>}
              </div>
            ))}
            {busy && turns[turns.length - 1]?.partial && !turns[turns.length - 1]?.answer && <div className="bubble bot">{withBold(turns[turns.length - 1].partial ?? "")}</div>}
            {busy && !turns[turns.length - 1]?.partial && <div className="bubble bot"><span className="spinner" /></div>}
          </div>
          <form className="chat-input" onSubmit={send}>
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question as a visitor would…" aria-label="Question" maxLength={1000} />
            <Button kind="primary" type="submit" loading={busy}>Send</Button>
          </form>
        </div>
      </Card>

      <Card title="Diagnostics" subtitle="Click an answer to inspect it.">
        {!current ? <Empty title="No answer selected" /> : (
          <div className="stack">
            {current.error && <div className="alert error">{current.error}</div>}
            <dl className="kv">
              <dt>Confidence</dt><dd>{current.confidence.toFixed(3)} <span className="muted">(threshold {current.threshold})</span></dd>
              <dt>Model</dt><dd>{current.model_name ?? "—"}{current.used_fallback && <> <Badge color="amber">fallback used</Badge></>}</dd>
              <dt>Response time</dt><dd>{duration(current.response_ms)}</dd>
              <dt>Tokens</dt><dd>{current.input_tokens} in / {current.output_tokens} out · {money(current.cost)}</dd>
              <dt>Language</dt><dd>{current.language}</dd>
            </dl>
            {current.confirmation && <div className="alert info">Waiting for confirmation: <span className="mono">{current.confirmation.action}</span></div>}
            {current.action_results.length > 0 && (
              <div>
                <h3 style={{ marginBottom: 8 }}>API actions ({current.action_results.length})</h3>
                <div className="stack" style={{ gap: 8 }}>
                  {current.action_results.map((r, i) => (
                    <div className="chunk" key={i}>
                      <div className="row between">
                        <strong className="mono">{r.action}</strong>
                        <span className="row" style={{ gap: 4 }}>
                          <Badge color={r.ok ? "green" : "red"}>{r.status_code ?? (r.ok ? "OK" : "Error")}</Badge>
                          <span className="small muted">{duration(r.response_ms)}</span>
                        </span>
                      </div>
                      <div className="small mono muted" style={{ overflowWrap: "anywhere" }}>{JSON.stringify(r.params)}</div>
                      {r.error && <div className="small" style={{ color: "var(--danger)", marginTop: 4 }}>{r.error}</div>}
                      {r.response && <div className="small mono" style={{ marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.response.slice(0, 600)}{r.response.length > 600 ? "…" : ""}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <h3 style={{ marginBottom: 8 }}>Retrieved content ({current.chunks.length})</h3>
              <div className="stack" style={{ gap: 8 }}>
                {current.chunks.map((c, i) => (
                  <div className="chunk" key={i}>
                    <div className="row between">
                      <strong className="truncate" style={{ maxWidth: "70%" }}>{c.title || c.source}</strong>
                      <span className="row" style={{ gap: 4 }}>
                        {c.similarity !== null && <Badge>sim {c.similarity.toFixed(2)}</Badge>}
                        {c.keyword && <Badge color="blue">keyword</Badge>}
                      </span>
                    </div>
                    <div className="small muted truncate">{c.source}</div>
                    <div className="small" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{c.preview}{c.preview.length >= 300 ? "…" : ""}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
