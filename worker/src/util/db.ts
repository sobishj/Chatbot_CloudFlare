/** Small helpers over D1: timestamps, JSON columns, booleans and batched multi-row statements. */

export type Row = Record<string, any>;

/** Current UTC time as stored in every timestamp column (same format as SQLite's strftime default). */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  if (typeof text !== "string") return text as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function boolOrNull(value: unknown): boolean | null {
  return value === null || value === undefined ? null : bool(value);
}

export async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function first<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

/** D1 allows at most 100 bound parameters per statement: split a list so each piece fits. */
export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** "IN (?, ?, ...)" helper that never produces an empty list (matches nothing instead). */
export function inList(values: unknown[]): { sql: string; params: unknown[] } {
  if (!values.length) return { sql: "(NULL)", params: [] };
  return { sql: `(${placeholders(values.length)})`, params: values };
}

/** Run statements as one D1 batch (one query toward the per-invocation limit, all-or-nothing). */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (!statements.length) return [];
  return db.batch(statements);
}
