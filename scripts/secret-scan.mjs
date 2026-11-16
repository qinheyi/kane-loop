// Pre-push guard: fail if the value of any secret env var appears in a file that git would publish.
// Compares values in memory and never prints them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const names = ["LT_USERNAME", "LT_ACCESS_KEY", "MINIMAX_API_KEY", "CLOCKED_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "VERCEL_TOKEN"];
const values = names.map((n) => [n, process.env[n]]).filter(([, v]) => v && v.length >= 6);
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
let hits = 0;
for (const f of files) {
  let text; try { text = fs.readFileSync(f, "latin1"); } catch { continue; }
  for (const [n, v] of values) if (text.includes(v)) { console.log(`LEAK: value of ${n} found in ${f}`); hits++; }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/.test(text)) { console.log(`SUSPICIOUS token-like string in ${f}`); hits++; }
}
console.log(`secret-scan: ${files.length} files, ${values.length} secret values checked, ${hits} finding(s)`);
process.exit(hits ? 1 : 0);
