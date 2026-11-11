// Build the admin UI into ../frontend/dist and add the files the Worker serves as static assets:
// widget.js (unchanged, from app/widget/) and _headers (security headers for the UI, CORS for the widget).
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const frontend = join(root, "frontend");
const dist = join(frontend, "dist");

if (!process.argv.includes("--skip-ui")) {
  if (!existsSync(join(frontend, "node_modules"))) execSync("npm ci", { cwd: frontend, stdio: "inherit" });
  execSync("npm run build", { cwd: frontend, stdio: "inherit" });
}

copyFileSync(join(root, "app", "widget", "widget.js"), join(dist, "widget.js"));

// Same headers the self-hosted admin server sent with the UI (CSP etc.), and the widget's own.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
writeFileSync(
  join(dist, "_headers"),
  `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: same-origin
  Content-Security-Policy: ${CSP}

/
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/widget.js
  ! X-Frame-Options
  ! Content-Security-Policy
  ! Referrer-Policy
  Cache-Control: public, max-age=300
  Access-Control-Allow-Origin: *
  Content-Type: application/javascript; charset=utf-8
`,
);
console.log("Assets ready in", dist);
