// Zero-dependency static server for the SplitBill demo app.
// Usage: node server.js [port]   (default 4173). No caching, so every edit is live on the next request.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");
const port = Number(process.argv[2] || process.env.PORT || 4173);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const file = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(port, () => console.log(`SplitBill running at http://localhost:${port}`));
