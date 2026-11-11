/**
 * Split text into ~500-token chunks with ~50 tokens of overlap.
 *
 * Splitting respects structure: paragraphs/lines first, then sentences, then words,
 * so chunks rarely cut a fact in half. The algorithm only looks at one line at a time plus the
 * chunk being built, so long documents are chunked a slice at a time across invocations
 * (ChunkBuilder keeps the state) with exactly the result of chunking them in one go.
 */

import { pySplit, splitlines } from "../util/pyurl";

export const CHUNK_TOKENS = 500;
export const OVERLAP_TOKENS = 50;

/**
 * Token counter. When it also has ``raw`` (an additive count over space-joined words, rounded up
 * by the counter itself), long lines are split word by word in linear time.
 */
export type CountTokens = ((text: string) => number) & { raw?: (text: string) => number };

// Sentence ends for Latin scripts, Devanagari danda, CJK and Arabic punctuation.
const SENTENCE_RE = /(?<=[.!?।॥。！？؟])\s+/u;

/** Split a unit that alone exceeds ``maxTokens``: by sentence, then by words. */
function splitLong(unit: string, countTokens: CountTokens, maxTokens: number): string[] {
  const pieces: string[] = [];
  const parts = unit.split(SENTENCE_RE);
  const sentences = parts.length > 1 ? parts : [unit];
  for (const sentence of sentences) {
    if (countTokens(sentence) <= maxTokens) {
      pieces.push(sentence);
      continue;
    }
    let current: string[] = [];
    const raw = countTokens.raw;
    let running = 0;
    for (const word of pySplit(sentence)) {
      current.push(word);
      const wordRaw = raw ? raw(word) : 0;
      running += wordRaw;
      const over = raw ? Math.ceil(running - 1e-9) > maxTokens : countTokens(current.join(" ")) > maxTokens;
      if (current.length > 1 && over) {
        current.pop();
        pieces.push(current.join(" "));
        current = [word];
        running = wordRaw;
      }
    }
    if (current.length) pieces.push(current.join(" "));
  }
  return pieces;
}

/** Break text into small units (lines/paragraphs), each at most ``maxTokens``. */
export function splitUnits(text: string, countTokens: CountTokens, maxTokens = CHUNK_TOKENS): string[] {
  const units: string[] = [];
  for (let line of splitlines(text)) {
    line = line.trim();
    if (!line) continue;
    if (countTokens(line) > maxTokens) units.push(...splitLong(line, countTokens, maxTokens));
    else units.push(line);
  }
  return units;
}

export interface ChunkState {
  current: [string, number][]; // units of the chunk being built, with their token counts
  tokens: number;
}

/** Feeds units one at a time; emits each finished chunk. */
export class ChunkBuilder {
  state: ChunkState;
  constructor(
    private countTokens: CountTokens,
    state?: ChunkState,
    private maxTokens = CHUNK_TOKENS,
    private overlapTokens = OVERLAP_TOKENS,
  ) {
    this.state = state ?? { current: [], tokens: 0 };
  }

  /** Add the lines of a piece of text; returns the chunks completed by it. */
  addText(text: string): string[] {
    const out: string[] = [];
    for (const unit of splitUnits(text, this.countTokens, this.maxTokens)) {
      const chunk = this.addUnit(unit, this.countTokens(unit));
      if (chunk !== null) out.push(chunk);
    }
    return out;
  }

  private addUnit(unit: string, size: number): string | null {
    const s = this.state;
    let emitted: string | null = null;
    if (s.current.length && s.tokens + size > this.maxTokens) {
      emitted = s.current.map(([u]) => u).join("\n");
      // Start the next chunk with trailing units of this one (the overlap).
      let overlap: [string, number][] = [];
      let overlapSize = 0;
      for (let j = s.current.length - 1; j >= 0; j--) {
        if (overlapSize + s.current[j][1] > this.overlapTokens) break;
        overlap.unshift(s.current[j]);
        overlapSize += s.current[j][1];
      }
      if (overlapSize + size > this.maxTokens) {
        overlap = [];
        overlapSize = 0;
      }
      s.current = overlap;
      s.tokens = overlapSize;
    }
    s.current.push([unit, size]);
    s.tokens += size;
    return emitted;
  }

  /** The last chunk, if any. */
  finish(): string[] {
    const s = this.state;
    const out = s.current.length ? [s.current.map(([u]) => u).join("\n")] : [];
    this.state = { current: [], tokens: 0 };
    return out;
  }
}

/** Chunks of at most ~``maxTokens`` tokens, each starting with ~``overlapTokens`` of the previous one. */
export function chunkText(text: string, countTokens: CountTokens, maxTokens = CHUNK_TOKENS, overlapTokens = OVERLAP_TOKENS): string[] {
  const builder = new ChunkBuilder(countTokens, undefined, maxTokens, overlapTokens);
  return [...builder.addText(text), ...builder.finish()];
}

/**
 * The next slice of ``text`` starting at ``offset``: about ``size`` characters, ending at a line
 * break so no line is split between two slices.
 */
export function nextSlice(text: string, offset: number, size: number): [string, number] {
  if (offset >= text.length) return ["", text.length];
  let end = Math.min(text.length, offset + size);
  if (end < text.length) {
    const nl = text.indexOf("\n", end);
    end = nl < 0 ? text.length : nl + 1;
  }
  return [text.slice(offset, end), end];
}
