/** Wall-clock time in an IANA time zone (via Intl), plus Python-style date formatting. */

export interface ZonedTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Monday (Python's datetime.weekday())
  tzName: string; // short name, e.g. "UTC", "GMT+5:30", "CET"
  offsetMinutes: number; // local - UTC
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      timeZoneName: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The current local time in ``tz``; falls back to UTC for unknown zones (like Python's ZoneInfo fallback). */
export function zonedNow(tz: string | null | undefined, at: Date = new Date()): ZonedTime {
  let f: Intl.DateTimeFormat;
  try {
    f = formatter(tz || "UTC");
  } catch {
    f = formatter("UTC");
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(at)) parts[p.type] = p.value;
  const z: ZonedTime = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS_SHORT.indexOf(parts.weekday),
    tzName: parts.timeZoneName || "UTC",
    offsetMinutes: 0,
  };
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  z.offsetMinutes = Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  return z;
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** strftime("%A, %d %B %Y"). */
export function formatLongDate(z: { year: number; month: number; day: number; weekday: number }): string {
  return `${DAY_NAMES[z.weekday]}, ${pad(z.day)} ${MONTH_NAMES[z.month - 1]} ${z.year}`;
}

/** strftime("%A, %d %B %Y, %H:%M"). */
export function formatLongDateTime(z: ZonedTime): string {
  return `${formatLongDate(z)}, ${pad(z.hour)}:${pad(z.minute)}`;
}

/** Today's UTC date, for prompts that used the server's local date (UTC on servers). */
export function utcToday(): { year: number; month: number; day: number; weekday: number } {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: (d.getUTCDay() + 6) % 7 };
}

/** datetime.isoformat() of a zoned time, e.g. "2026-11-11T09:30:05.123000+05:30". */
export function zonedIso(z: ZonedTime, ms = 0): string {
  const sign = z.offsetMinutes >= 0 ? "+" : "-";
  const off = Math.abs(z.offsetMinutes);
  return `${z.year}-${pad(z.month)}-${pad(z.day)}T${pad(z.hour)}:${pad(z.minute)}:${pad(z.second)}.${String(ms).padStart(3, "0")}000${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}
