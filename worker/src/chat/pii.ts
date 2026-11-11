/**
 * Mask personal data (email addresses, phone numbers) in visitor messages.
 *
 * Applied before a message is searched, sent to the model or saved, so visitor
 * contact details never leave the request in clear text.
 */

export const EMAIL_MASK = "[email]";
export const PHONE_MASK = "[phone]";

// Python's \w (Unicode) is letters, digits and underscore; \d is any decimal digit.
const W = "\\p{L}\\p{N}_";
const EMAIL_SRC = `[${W}.+-]+@[${W}-]+(?:\\.[${W}-]+)+`;
// Digits with optional +, spaces, dots, dashes, parentheses between them.
const PHONE_SRC = `(?<![${W}+])\\+?\\(?\\p{Nd}[\\p{Nd}\\s().\\-/]{5,}\\p{Nd}(?![${W}])`;
const DATE_RE = /^\p{Nd}{4}[-/.]\p{Nd}{1,2}[-/.]\p{Nd}{1,2}$|^\p{Nd}{1,2}[-/.]\p{Nd}{1,2}[-/.]\p{Nd}{2,4}$/u;
const TIME_RANGE_RE = /^\p{Nd}{1,2}[.:]\p{Nd}{2}\s*-\s*\p{Nd}{1,2}[.:]\p{Nd}{2}$/u;

function emailRe(): RegExp {
  return new RegExp(EMAIL_SRC, "gu");
}

function phoneRe(): RegExp {
  return new RegExp(PHONE_SRC, "gu");
}

function maskPhone(candidate: string): string {
  const digits = [...candidate].filter((ch) => /\p{Nd}/u.test(ch)).length;
  const stripped = candidate.trim();
  if (digits < 7 || digits > 15 || DATE_RE.test(stripped) || TIME_RANGE_RE.test(stripped)) return candidate;
  return PHONE_MASK;
}

/** Replace email addresses and phone numbers with placeholders. */
export function maskPii(text: string): string {
  text = text.replace(emailRe(), EMAIL_MASK);
  return text.replace(phoneRe(), (m) => maskPhone(m));
}

/**
 * Like maskPii, but with numbered placeholders (``[phone_1]``) whose real values go in ``vault``.
 *
 * Used for API actions: the model only sees placeholders, and the real values are put
 * back server-side, only in the request to the client's own API. The same value keeps
 * its placeholder across a conversation.
 */
export function tokenizePii(text: string, vault: Record<string, string>): string {
  const byValue = new Map(Object.entries(vault).map(([k, v]) => [v, k]));
  const token = (kind: string, value: string): string => {
    const known = byValue.get(value);
    if (known) return known;
    const n = Object.keys(vault).filter((k) => k.startsWith(`[${kind}_`)).length + 1;
    const key = `[${kind}_${n}]`;
    vault[key] = value;
    byValue.set(value, key);
    return key;
  };
  text = text.replace(emailRe(), (m) => token("email", m));
  return text.replace(phoneRe(), (m) => (maskPhone(m) === PHONE_MASK ? token("phone", m.trim()) : m));
}
