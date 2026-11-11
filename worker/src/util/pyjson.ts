/** json.dumps(value, ensure_ascii=False): Python's default separators (", " and ": "). */
export function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
  if (typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`).join(", ") + "}";
  }
  return JSON.stringify(String(value));
}
