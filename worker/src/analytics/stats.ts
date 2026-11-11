/** Analytics over the ``questions`` table: stats, conversations, CSV export. */

import { toQuestion, type Question } from "../models";
import { all, first, inList } from "../util/db";

const VISITOR_CHANNELS = ["widget"]; // Test chat and CLI questions are excluded from statistics

interface Scope {
  sql: string;
  params: unknown[];
}

function scope(clientIds: number[] | null, since: string, includeTest: boolean): Scope {
  let sql = "created_at >= ?";
  const params: unknown[] = [since];
  if (clientIds !== null) {
    const l = inList(clientIds.length ? clientIds : [-1]);
    sql += ` AND client_id IN ${l.sql}`;
    params.push(...l.params);
  }
  if (!includeTest) {
    const l = inList(VISITOR_CHANNELS);
    sql += ` AND channel IN ${l.sql}`;
    params.push(...l.params);
  }
  return { sql, params };
}

function dayStartUtc(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Everything the Stats tab shows, for one or more clients. */
export async function questionStats(db: D1Database, clientIds: number[] | null, days = 30, includeTest = false): Promise<Record<string, any>> {
  const since = dayStartUtc(Date.now() - (days - 1) * 86400_000);
  const s = scope(clientIds, since.toISOString(), includeTest);
  const [totals, perDay, top, unanswered, langs, models] = await db.batch<Record<string, any>>([
    db.prepare(
      `SELECT count(id) AS total, coalesce(sum(answered = 0), 0) AS unanswered, coalesce(sum(input_tokens), 0) AS tin, ` +
        `coalesce(sum(output_tokens), 0) AS tout, coalesce(sum(cost), 0.0) AS cost, coalesce(avg(response_ms), 0) AS avg_ms FROM questions WHERE ${s.sql}`,
    ).bind(...s.params),
    db.prepare(`SELECT substr(created_at, 1, 10) AS day, count(id) AS total, coalesce(sum(answered = 0), 0) AS unanswered FROM questions WHERE ${s.sql} GROUP BY day`).bind(...s.params),
    db.prepare(
      `SELECT question_normalized AS normalized, count(id) AS n, min(question) AS question, coalesce(sum(answered = 0), 0) AS unanswered ` +
        `FROM questions WHERE ${s.sql} AND question_normalized <> '' GROUP BY question_normalized ORDER BY count(id) DESC LIMIT 20`,
    ).bind(...s.params),
    db.prepare(`SELECT id, question, created_at, top_score FROM questions WHERE ${s.sql} AND answered = 0 ORDER BY created_at DESC LIMIT 50`).bind(...s.params),
    db.prepare(`SELECT language, count(id) AS n FROM questions WHERE ${s.sql} GROUP BY language ORDER BY count(id) DESC`).bind(...s.params),
    db.prepare(
      `SELECT model_name, count(id) AS n, coalesce(sum(input_tokens), 0) AS tin, coalesce(sum(output_tokens), 0) AS tout, ` +
        `coalesce(sum(cost), 0.0) AS cost, coalesce(sum(used_fallback = 1), 0) AS fallbacks FROM questions WHERE ${s.sql} GROUP BY model_name`,
    ).bind(...s.params),
  ]);
  const t = totals.results![0];
  const total = Number(t.total);
  const unansweredCount = Number(t.unanswered);
  const byDay = new Map((perDay.results ?? []).map((r) => [r.day as string, [Number(r.total), Number(r.unanswered)]]));
  const per_day = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
    const [tt, uu] = byDay.get(d) ?? [0, 0];
    per_day.push({ date: d, total: tt, unanswered: uu });
  }
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    days,
    total,
    answered: total - unansweredCount,
    unanswered: unansweredCount,
    unanswered_rate: total ? unansweredCount / total : 0.0,
    avg_response_ms: Math.trunc(Number(t.avg_ms) || 0),
    tokens: { input: Number(t.tin), output: Number(t.tout), cost: round6(Number(t.cost)) },
    per_day,
    top_questions: (top.results ?? []).map((r) => ({ question: r.question, normalized: r.normalized, count: r.n, unanswered: r.unanswered })),
    unanswered_questions: (unanswered.results ?? []).map((r) => ({ id: r.id, question: r.question, created_at: r.created_at, top_score: r.top_score })),
    languages: (langs.results ?? []).map((r) => ({ language: r.language || "unknown", count: r.n })),
    models: (models.results ?? []).map((r) => ({
      model: r.model_name || "—", count: r.n, input_tokens: Number(r.tin), output_tokens: Number(r.tout), cost: round6(Number(r.cost)), fallbacks: r.fallbacks,
    })),
  };
}

export async function questionsToday(db: D1Database, clientIds: number[] | null): Promise<number> {
  const s = scope(clientIds, dayStartUtc(Date.now()).toISOString(), false);
  return (await first<{ n: number }>(db, `SELECT count(id) AS n FROM questions WHERE ${s.sql}`, ...s.params))?.n ?? 0;
}

// ----------------------------------------------------------------------------- conversations
export interface ConversationFilters {
  search?: string;
  answered?: string;
  channel?: string;
  days?: number | null;
}

function conversationsWhere(clientId: number, f: ConversationFilters): Scope {
  let sql = "client_id = ?";
  const params: unknown[] = [clientId];
  const search = (f.search ?? "").trim();
  if (search) {
    const like = `%${search}%`;
    sql += " AND (question LIKE ? OR answer LIKE ?)";
    params.push(like, like);
  }
  if (f.answered === "yes") sql += " AND answered = 1";
  else if (f.answered === "no") sql += " AND answered = 0";
  if (f.channel && f.channel !== "all") {
    sql += " AND channel = ?";
    params.push(f.channel);
  }
  if (f.days) {
    sql += " AND created_at >= ?";
    params.push(new Date(Date.now() - f.days * 86400_000).toISOString());
  }
  return { sql, params };
}

export function questionToDict(q: Question): Record<string, any> {
  return {
    id: q.id,
    session_id: q.session_id,
    channel: q.channel,
    question: q.question,
    answer: q.answer,
    sources: q.sources,
    answered: q.answered,
    top_score: q.top_score,
    language: q.language,
    model_name: q.model_name,
    used_fallback: q.used_fallback,
    input_tokens: q.input_tokens,
    output_tokens: q.output_tokens,
    cost: q.cost,
    response_ms: q.response_ms,
    error: q.error,
    created_at: q.created_at,
  };
}

export async function listConversations(db: D1Database, clientId: number, page = 1, perPage = 50, filters: ConversationFilters = {}): Promise<Record<string, any>> {
  const w = conversationsWhere(clientId, filters);
  const total = (await first<{ n: number }>(db, `SELECT count(*) AS n FROM questions WHERE ${w.sql}`, ...w.params))?.n ?? 0;
  const rows = await all(db, `SELECT * FROM questions WHERE ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...w.params, perPage, (page - 1) * perPage);
  return { total, page, per_page: perPage, items: rows.map((r) => questionToDict(toQuestion(r))) };
}

const CSV_COLUMNS = ["created_at", "session_id", "channel", "language", "question", "answer", "answered", "top_score", "model_name", "used_fallback", "input_tokens", "output_tokens", "cost", "response_ms", "sources"];

/** Prevent CSV/formula injection when the file is opened in Excel. */
function csvSafe(value: unknown): unknown {
  if (typeof value === "string" && ["=", "+", "-", "@", "\t", "\r"].includes(value.slice(0, 1))) return "'" + value;
  return value;
}

/** str() of a value as Python's csv writer prints it. */
function pyCell(value: unknown, column: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (column === "created_at" && typeof value === "string") {
    // datetime → "2026-11-11 10:00:00.123000+00:00"
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
    if (m) return `${m[1]} ${m[2]}${m[3] ? "." + m[3].padEnd(6, "0") : ""}+00:00`;
  }
  if (typeof value === "number" && Number.isInteger(value) && ["top_score", "cost"].includes(column)) return value.toFixed(1);
  return String(value);
}

function csvRow(cells: string[]): string {
  return cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",") + "\r\n";
}

/** The CSV export, streamed 500 rows at a time. */
export function exportCsv(db: D1Database, clientId: number, filters: ConversationFilters): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const w = conversationsWhere(clientId, filters);
  let offset = 0;
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode("﻿" + csvRow(CSV_COLUMNS))); // BOM so Excel opens UTF-8 (e.g. Malayalam) correctly
        return;
      }
      const rows = await all(db, `SELECT * FROM questions WHERE ${w.sql} ORDER BY created_at DESC, id DESC LIMIT 500 OFFSET ?`, ...w.params, offset);
      offset += rows.length;
      if (!rows.length) {
        controller.close();
        return;
      }
      let out = "";
      for (const r of rows) {
        const q = toQuestion(r);
        const data: Record<string, any> = questionToDict(q);
        data.sources = (q.sources || []).map((s: any) => s.url || s.title || "").join("; ");
        out += csvRow(CSV_COLUMNS.map((c) => pyCell(csvSafe(data[c]), c)));
      }
      controller.enqueue(encoder.encode(out));
    },
  });
}

export async function clientsWithActivity(db: D1Database, clientIds: number[] | null, days = 30): Promise<Record<string, any>[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const channels = inList(VISITOR_CHANNELS);
  let where = "";
  const params: unknown[] = [since, ...channels.params];
  if (clientIds !== null) {
    const l = inList(clientIds.length ? clientIds : [-1]);
    where = ` WHERE c.id IN ${l.sql}`;
    params.push(...l.params);
  }
  const rows = await all(
    db,
    `SELECT c.client_id, c.name, count(q.id) AS n FROM clients c LEFT JOIN questions q ON q.client_id = c.id AND q.created_at >= ? AND q.channel IN ${channels.sql}` +
      `${where} GROUP BY c.id ORDER BY count(q.id) DESC`,
    ...params,
  );
  return rows.map((r) => ({ client_id: r.client_id, name: r.name, questions: r.n }));
}
