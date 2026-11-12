import { describe, expect, it } from "vitest";
import { contactRule, mentionsContact, withContact } from "../src/chat/contact";
import { buildMessages } from "../src/chat/prompt";
import { zonedNow } from "../src/util/time";

const CONTACT = "Phone: +91 98765 43210\nEmail: info@taxlead.in";

describe("contact details when the assistant can't answer", () => {
  it("adds the details to an answer without them", () => {
    const out = withContact("I don't have that information right now.", CONTACT, "en");
    expect(out).toBe("I don't have that information right now.\n\nYou can contact us here:\n" + CONTACT);
  });

  it("doesn't repeat details the model already gave, however it wrote the number", () => {
    expect(mentionsContact("Please call us on 98765-43210.", CONTACT)).toBe(true);
    expect(mentionsContact("Write to INFO@taxlead.in", CONTACT)).toBe(true);
    expect(withContact("Call +91 9876543210 for help.", CONTACT, "en")).toBe("Call +91 9876543210 for help.");
  });

  it("does nothing without configured details, and uses the visitor's language", () => {
    expect(withContact("Sorry.", "", "en")).toBe("Sorry.");
    expect(withContact("Sorry.", "   ", "en")).toBe("Sorry.");
    expect(withContact("ക്ഷമിക്കണം.", CONTACT, "ml")).toContain("ഞങ്ങളെ ബന്ധപ്പെടാൻ:");
  });

  it("puts the contact rule in the prompt", () => {
    const now = zonedNow("UTC", new Date(Date.UTC(2026, 9, 10, 12, 0)));
    const withDetails = buildMessages("{context}", "Bot", "Acme", [], [], "hi", "", now, "", CONTACT)[0].content!;
    expect(withDetails).toContain("CONTACT RULE");
    expect(withDetails).toContain("info@taxlead.in");
    expect(buildMessages("{context}", "Bot", "Acme", [], [], "hi", "", now)[0].content).toContain("if the CONTEXT has our contact details");
    expect(contactRule("")).toContain("Never invent contact details");
  });
});
