// Serve the demo page:  node demo/serve.mjs   →  http://localhost:5500/?client=CLIENT_ID&api=http://localhost:8787
// Add localhost:5500 to the client's Allowed domains first.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5500);

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path !== "/" && path !== "/index.html") {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(await readFile(join(here, "index.html")));
}).listen(PORT, () => console.log(`Demo page on http://localhost:${PORT}/?client=CLIENT_ID&api=http://localhost:8787`));
