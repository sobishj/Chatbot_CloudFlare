// Recovery: set a user's password (and sign them out everywhere) directly in D1.
//   node scripts/reset-admin-password.mjs you@example.com "new password here" [--local]
// Without --local it changes the deployed database (wrangler d1 execute --remote).
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ITERATIONS = 40_000; // keep in step with src/security/passwords.ts
const [email, password, ...flags] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/reset-admin-password.mjs you@example.com "new password" [--local]');
  process.exit(1);
}
if ([...password].length < 10 || /^\d+$/.test(password)) {
  console.error("Password must be at least 10 characters and not only digits.");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
const b64 = (b) => b.toString("base64url");
const stored = `pbkdf2_sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
const address = email.trim().toLowerCase().replace(/'/g, "''");
const sql = `UPDATE users SET password_hash = '${stored}', session_version = session_version + 1, active = 1 WHERE email = '${address}' RETURNING email;`;
const target = flags.includes("--local") ? "--local" : "--remote";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// The SQL goes in a file: on Windows, a command line would split it into separate arguments.
const dir = mkdtempSync(join(tmpdir(), "wa-reset-"));
const file = join(dir, "reset.sql");
writeFileSync(file, sql);
let out;
try {
  out = execFileSync(npx, ["wrangler", "d1", "execute", "website-assistant", target, "--json", "--yes", "--file", file], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const result = JSON.parse(out);
const changes = (Array.isArray(result) ? result : [result]).reduce((n, r) => n + (r?.results?.length ?? 0), 0);
console.log(changes ? `Password changed for ${email}.` : `No user with the email ${email}.`);
