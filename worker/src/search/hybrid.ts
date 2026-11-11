/**
 * Hybrid retrieval for one client.
 *
 * 1. Vector search: top 20 chunks by cosine similarity (Vectorize, in the client's namespace
 *    "c{clients.id}"). Vectorize returns more candidates than needed, so enough survive the
 *    filters applied in D1 (disabled documents, sources still being re-indexed).
 * 2. Full-text search: top 20 chunks by bm25 on the FTS5 table. Query words are OR-ed (minus
 *    common stop words) so a question like "Where is the ASICS store?" matches chunks containing
 *    "asics" — and, because FTS5 matches whole words only, never "Basics".
 * 3. Reciprocal rank fusion: score = Σ 1 / (k + rank) over both lists; keep the top 6.
 *
 * The confidence score is the best cosine similarity among the returned chunks (RRF
 * scores are rank-based and not comparable across questions). Every query is filtered
 * by client.
 */

import type { Embedder } from "../embeddings/embedder";

export const VECTOR_K = 20;
export const TEXT_K = 20;
export const FINAL_K = 6;
// "Which shops sell shoes?" needs many pages (one per shop), not the best six.
export const LIST_K = 16;
const LIST_RE =
  /\b(?:which|what|list|all|any|how many)\b.*\b(?:shops?|stores?|brands?|outlets?|restaurants?|cafes?|places|options|products|services|doctors|departments|courses|rooms|events|offers)\b|\b(?:shops|stores|brands|outlets|restaurants)\b/i;

export function isListQuestion(question: string): boolean {
  return LIST_RE.test(question);
}

export const RRF_K = 60;
const VECTORIZE_MAX_TOP_K = 100; // without returned values/metadata

// Very common words that carry no meaning for keyword search (English + a few others).
// Other languages simply keep all their words; the vector search handles meaning.
export const STOP_WORDS = new Set(
  `a an the is are was were be been am do does did of to in on at by for with from and or not no
    what where when which who whom whose why how can could would should will shall may might must
    i me my we our you your he she it its they them their this that these those there here
    please tell show give get find know want need any some about have has had
    le la les un une des du de et est que qui où quand comment el los las y es en por para
    der die das und ist wo wie`.split(/\s+/).filter(Boolean),
);

/**
 * Split on whitespace/punctuation/symbols only, so combining marks (e.g. Malayalam
 * vowel signs) stay inside their word.
 */
export function words(text: string): string[] {
  return text.replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, " ").toLowerCase().split(/\s+/).filter(Boolean);
}

export interface SearchHit {
  chunk_id: number;
  source_type: string;
  source: string;
  title: string;
  content: string;
  similarity: number | null; // cosine similarity (vector list only)
  text_rank: number | null;
  score: number; // RRF score
}

export interface SearchResult {
  hits: SearchHit[];
  confidence: number; // best cosine similarity among hits (0..1)
  keyword_match: boolean; // at least one hit came from full-text search
}

function isAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}

/** An FTS5 query from meaningful words: each term double-quoted (quotes escaped) and OR-ed. */
export function keywordQuery(question: string): string | null {
  const terms = [...new Set(words(question).filter((w) => !STOP_WORDS.has(w) && ([...w].length > 1 || !isAscii(w))))].slice(0, 20);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// Chunks of documents switched off in the Documents tab are never used for answers, and chunks of a
// source that is still being re-indexed (pending) only count once the whole source is ready.
const ENABLED_ONLY = "AND c.pending = 0 AND (c.document_id IS NULL OR c.document_id NOT IN (SELECT id FROM documents WHERE client_id = ?1 AND enabled = 0)) ";

function hitFrom(r: Record<string, any>, similarity: number | null, textRank: number | null): SearchHit {
  return { chunk_id: r.id, source_type: r.source_type, source: r.source, title: r.title ?? "", content: r.content, similarity, text_rank: textRank, score: 0 };
}

export function namespaceFor(clientId: number): string {
  return `c${clientId}`;
}

/** Reciprocal rank fusion of several ranked lists (deduplicated by chunk id). */
export function rrfMerge(lists: SearchHit[][], k = RRF_K, limit = FINAL_K): SearchHit[] {
  const merged = new Map<number, SearchHit>();
  for (const hits of lists) {
    hits.forEach((hit, i) => {
      const rank = i + 1;
      let current = merged.get(hit.chunk_id);
      if (!current) {
        current = { ...hit, similarity: null, text_rank: null, score: 0 };
        merged.set(hit.chunk_id, current);
      }
      current.score += 1.0 / (k + rank);
      if (hit.similarity !== null) current.similarity = hit.similarity;
      if (hit.text_rank !== null) current.text_rank = hit.text_rank;
    });
  }
  // Stable sort, like Python's sorted(): equal scores keep insertion order.
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export const FOLLOW_UP_MAX_WORDS = 7;

export interface SearchEnv {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
}

/**
 * Hybrid search. A short follow-up ("is it open now?") is also searched together with the
 * previous question, so "it" finds what the visitor was just asking about.
 */
export async function search(
  env: SearchEnv,
  embedder: Embedder,
  clientId: number,
  question: string,
  limit: number | null = null,
  previousQuestion: string | null = null,
): Promise<SearchResult> {
  if (limit === null) limit = isListQuestion(question) ? LIST_K : FINAL_K;
  const candidates = Math.max(VECTOR_K, limit * 2);
  const queries = [question];
  if (previousQuestion && words(question).length <= FOLLOW_UP_MAX_WORDS) queries.push(`${previousQuestion} ${question}`);

  const vectors = await embedder.encodeQueries(queries);
  const topK = Math.min(VECTORIZE_MAX_TOP_K, candidates * 3);
  const matches = await Promise.all(
    vectors.map((v) => env.VECTORIZE.query(v, { topK, namespace: namespaceFor(clientId), returnValues: false, returnMetadata: "none" })),
  );

  // One D1 batch: the vector candidates' rows and the keyword search for every query.
  const statements: D1PreparedStatement[] = [];
  for (const m of matches) {
    const ids = m.matches.map((x) => Number(x.id)).filter((n) => Number.isInteger(n));
    statements.push(
      env.DB.prepare(
        "SELECT c.id, c.source_type, c.source, coalesce(c.title, '') AS title, c.content FROM chunks c " +
          "WHERE c.id IN (SELECT value FROM json_each(?2)) AND c.client_id = ?1 " + ENABLED_ONLY,
      ).bind(clientId, JSON.stringify(ids)),
    );
  }
  const textQueries = queries.map(keywordQuery);
  for (const q of textQueries) {
    if (q === null) continue;
    statements.push(
      env.DB.prepare(
        "SELECT c.id, c.source_type, c.source, coalesce(c.title, '') AS title, c.content, bm25(chunks_fts) AS rank " +
          "FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid " +
          "WHERE chunks_fts MATCH ?2 AND c.client_id = ?1 " + ENABLED_ONLY +
          "ORDER BY rank, c.id LIMIT ?3",
      ).bind(clientId, q, candidates),
    );
  }
  const results = statements.length ? await env.DB.batch<Record<string, any>>(statements) : [];

  const lists: SearchHit[][] = [];
  let r = 0;
  for (let i = 0; i < queries.length; i++) {
    const rows = new Map((results[r++].results ?? []).map((row) => [row.id as number, row]));
    const vectorHits: SearchHit[] = [];
    for (const m of matches[i].matches) {
      const row = rows.get(Number(m.id));
      if (row) vectorHits.push(hitFrom(row, m.score, null));
      if (vectorHits.length >= candidates) break;
    }
    lists.push(vectorHits);
    // bm25() is lower for better matches; the rank kept for display is its positive counterpart.
    lists.push(textQueries[i] === null ? [] : (results[r++].results ?? []).map((row) => hitFrom(row, null, -Number(row.rank))));
  }
  const hits = rrfMerge(lists, RRF_K, limit);
  // Chunks found only by keywords have no similarity yet; the best vector similarity
  // among the final hits is the confidence.
  const sims = hits.map((h) => h.similarity).filter((s): s is number => s !== null);
  return { hits, confidence: sims.length ? Math.max(...sims) : 0.0, keyword_match: hits.some((h) => h.text_rank !== null) };
}
