/**
 * robots.txt handling, ported from Python's urllib.robotparser so the crawler allows and skips
 * exactly the same URLs (first matching rule wins; paths are prefixes; quoting as Python does it).
 * The parsed rules are plain data, so they are kept in the crawl job's cursor between invocations.
 */

import { quote, unquote, urlparse, urlunparse } from "../util/pyurl";

interface RuleLine {
  path: string;
  allowance: boolean;
}

interface Entry {
  useragents: string[];
  rulelines: RuleLine[];
  delay: number | null;
}

export interface Robots {
  entries: Entry[];
  default_entry: Entry | null;
  last_checked: boolean;
}

function ruleLine(path: string, allowance: boolean): RuleLine {
  if (path === "" && !allowance) allowance = true; // an empty Disallow means "allow all"
  path = urlunparse(urlparse(path));
  return { path: quote(path), allowance };
}

function newEntry(): Entry {
  return { useragents: [], rulelines: [], delay: null };
}

function addEntry(robots: Robots, entry: Entry): void {
  if (entry.useragents.includes("*")) {
    // the default entry is considered last
    if (robots.default_entry === null) robots.default_entry = entry;
  } else {
    robots.entries.push(entry);
  }
}

/** RobotFileParser.parse(lines). */
export function parseRobots(lines: string[]): Robots {
  const robots: Robots = { entries: [], default_entry: null, last_checked: true };
  // states: 0 start, 1 saw user-agent, 2 saw an allow or disallow line
  let state = 0;
  let entry = newEntry();
  for (let line of lines) {
    if (!line) {
      if (state === 1) {
        entry = newEntry();
        state = 0;
      } else if (state === 2) {
        addEntry(robots, entry);
        entry = newEntry();
        state = 0;
      }
    }
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = unquote(line.slice(colon + 1).trim());
    if (key === "user-agent") {
      if (state === 2) {
        addEntry(robots, entry);
        entry = newEntry();
      }
      entry.useragents.push(value);
      state = 1;
    } else if (key === "disallow") {
      if (state !== 0) {
        entry.rulelines.push(ruleLine(value, false));
        state = 2;
      }
    } else if (key === "allow") {
      if (state !== 0) {
        entry.rulelines.push(ruleLine(value, true));
        state = 2;
      }
    } else if (key === "crawl-delay") {
      if (state !== 0) {
        // before trying to convert to int we need to make sure that robots.txt has valid syntax
        if (/^\d+$/.test(value.trim())) entry.delay = Number(value);
        state = 2;
      }
    } else if (key === "request-rate") {
      if (state !== 0) state = 2;
    }
  }
  if (state === 2) addEntry(robots, entry);
  return robots;
}

function appliesTo(entry: Entry, useragent: string): boolean {
  // split the name token and make it lower case
  const ua = useragent.split("/")[0].toLowerCase();
  for (const agent of entry.useragents) {
    if (agent === "*") return true;
    if (ua.includes(agent.toLowerCase())) return true;
  }
  return false;
}

function allowance(entry: Entry, filename: string): boolean {
  for (const line of entry.rulelines) {
    if (line.path === "*" || filename.startsWith(line.path)) return line.allowance;
  }
  return true;
}

/** RobotFileParser.can_fetch(useragent, url). */
export function canFetch(robots: Robots, useragent: string, url: string): boolean {
  if (!robots.last_checked) return false;
  // search for given user agent matches; the first match counts
  const parsed = urlparse(unquote(url));
  let path = urlunparse({ scheme: "", netloc: "", path: parsed.path, params: parsed.params, query: parsed.query, fragment: parsed.fragment });
  path = quote(path);
  if (!path) path = "/";
  for (const entry of robots.entries) {
    if (appliesTo(entry, useragent)) return allowance(entry, path);
  }
  if (robots.default_entry) return allowance(robots.default_entry, path);
  return true; // agent not found ==> access granted
}

/** RobotFileParser.crawl_delay(useragent). */
export function crawlDelay(robots: Robots, useragent: string): number | null {
  for (const entry of robots.entries) {
    if (appliesTo(entry, useragent)) return entry.delay;
  }
  return robots.default_entry ? robots.default_entry.delay : null;
}
