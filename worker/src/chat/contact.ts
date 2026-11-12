/**
 * Contact details for questions the assistant can't answer: the prompt asks the model to give
 * them, and withContact() adds them to the reply when the model left them out.
 */

/** The prompt rule; without configured details the model may still use those in the CONTEXT. */
export function contactRule(contact: string): string {
  const details = contact.trim();
  if (details) {
    return (
      "CONTACT RULE: If you can't answer the question from the CONTEXT, say so briefly and kindly, then give the " +
      `visitor our contact details so they can ask us directly:\n${details}\nNever invent other contact details.`
    );
  }
  return (
    "CONTACT RULE: If you can't answer the question from the CONTEXT, say so briefly and kindly, and if the CONTEXT " +
    "has our contact details (phone, email, WhatsApp, address), give them so the visitor can ask us directly. " +
    "Never invent contact details."
  );
}

const LEAD_IN: Record<string, string> = {
  en: "You can contact us here:",
  ml: "ഞങ്ങളെ ബന്ധപ്പെടാൻ:",
  hi: "आप हमसे यहाँ संपर्क कर सकते हैं:",
  ta: "எங்களைத் தொடர்பு கொள்ள:",
  ar: "يمكنك التواصل معنا هنا:",
};

/** Phone numbers (digits only), emails and links in the contact details. */
function contactTokens(contact: string): { digits: string[]; words: string[] } {
  const digits = (contact.match(/\+?\d[\d\s().-]{4,}\d/g) || []).map((m) => m.replace(/\D/g, "")).filter((d) => d.length >= 6);
  const words = (contact.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/\S+|\bwa\.me\/\S+/gi) || []).map((w) => w.toLowerCase());
  return { digits, words };
}

/** True when the answer already gives (any of) the contact details. */
export function mentionsContact(answer: string, contact: string): boolean {
  const { digits, words } = contactTokens(contact);
  const answerDigits = answer.replace(/\D/g, "");
  const lower = answer.toLowerCase();
  // Last 8 digits: the model may leave out the country or area code (+91 98765 43210 -> 98765 43210).
  if (digits.some((d) => answerDigits.includes(d.slice(-8))) || words.some((w) => lower.includes(w))) return true;
  if (!digits.length && !words.length) return lower.includes(contact.trim().toLowerCase().slice(0, 40));
  return false;
}

/** The answer with the contact details added at the end, unless it already has them. */
export function withContact(answer: string, contact: string | null | undefined, language: string): string {
  const details = (contact || "").trim();
  if (!details || mentionsContact(answer, details)) return answer;
  const lead = LEAD_IN[(language || "en").slice(0, 2)] || LEAD_IN.en;
  return `${answer.trim()}\n\n${lead}\n${details}`;
}
