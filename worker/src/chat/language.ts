/**
 * Lightweight language detection for analytics (Stats → Languages).
 *
 * Non-Latin scripts are identified by their Unicode block (reliable even for one word).
 * Latin-script text uses a small statistical detector (tinyld) when long enough, otherwise
 * the client's default. The model itself is told to reply in the visitor's language; this
 * is for statistics only.
 */

import { detectAll } from "tinyld/light";
import { pySplit } from "../util/pyurl";

const SCRIPT_RANGES: [number, number, string][] = [
  [0x0d00, 0x0d7f, "ml"], // Malayalam
  [0x0b80, 0x0bff, "ta"], // Tamil
  [0x0c80, 0x0cff, "kn"], // Kannada
  [0x0c00, 0x0c7f, "te"], // Telugu
  [0x0900, 0x097f, "hi"], // Devanagari (Hindi/Marathi/...)
  [0x0980, 0x09ff, "bn"], // Bengali
  [0x0a80, 0x0aff, "gu"], // Gujarati
  [0x0a00, 0x0a7f, "pa"], // Gurmukhi
  [0x0600, 0x06ff, "ar"], // Arabic (also Urdu/Persian)
  [0x0590, 0x05ff, "he"],
  [0x0e00, 0x0e7f, "th"],
  [0x0400, 0x04ff, "ru"], // Cyrillic
  [0x0370, 0x03ff, "el"],
  [0x3040, 0x30ff, "ja"], // Hiragana/Katakana
  [0xac00, 0xd7af, "ko"],
  [0x4e00, 0x9fff, "zh"],
];

export function detectLanguage(text: string, defaultLang = "en"): string {
  const counts: Record<string, number> = {};
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x0250 && /\p{L}/u.test(ch)) {
      latin++;
      continue;
    }
    for (const [start, end, lang] of SCRIPT_RANGES) {
      if (code >= start && code <= end) {
        counts[lang] = (counts[lang] || 0) + 1;
        break;
      }
    }
  }
  const langs = Object.keys(counts);
  if (langs.length) {
    const best = langs.reduce((a, b) => (counts[b] > counts[a] ? b : a));
    if (counts[best] >= latin) return best === "zh" && "ja" in counts ? "ja" : best;
  }
  if (pySplit(text).length >= 4 && latin >= 15) {
    try {
      const guesses = detectAll(text);
      if (guesses.length && guesses[0].accuracy >= 0.8) return guesses[0].lang;
    } catch {
      /* odd input */
    }
  }
  return defaultLang || "en";
}
