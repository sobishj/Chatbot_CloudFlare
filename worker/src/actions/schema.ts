/** Turn ``client_actions`` rows into OpenAI-style tool definitions (JSON Schema). */

import type { ClientAction } from "../models";

const JSON_TYPES: Record<string, Record<string, string>> = {
  string: { type: "string" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date" },
  phone: { type: "string" },
  email: { type: "string", format: "email" },
};
const TYPE_HINTS: Record<string, string> = {
  date: "ISO date, YYYY-MM-DD.",
  phone: "Phone number. Pass the visitor's placeholder (e.g. [phone_1]) unchanged.",
  email: "Email address. Pass the visitor's placeholder (e.g. [email_1]) unchanged.",
};

export function toolDefinition(action: ClientAction): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const p of action.parameters || []) {
    const kind = p.type || "string";
    const prop: Record<string, any> = { ...(JSON_TYPES[kind] ?? { type: "string" }) };
    const description = [p.description || "", TYPE_HINTS[kind] || ""].filter(Boolean).join(" ").trim();
    if (description) prop.description = description;
    if (p.enum && p.enum.length) prop.enum = [...p.enum];
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }
  let description = action.description || action.name.replace(/_/g, " ");
  if (action.response_hint) description += ` Response: ${action.response_hint}`;
  if (action.requires_confirmation) description += " The visitor is asked to confirm before this runs.";
  return {
    type: "function",
    function: {
      name: action.name,
      description: description.slice(0, 1000),
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

export function toolsFor(actions: ClientAction[]): Record<string, any>[] {
  return actions.filter((a) => a.enabled).map(toolDefinition);
}
