// DEMO ONLY: simulates a plausible bad edit by a coding agent ("simplify input parsing").
// It drops parseFloat on the bill field, so the bill stays a string and the total turns
// into string concatenation. Kane CLI should catch it; kane-loop should repair it.
import fs from "node:fs";
const file = new URL("../app/app.js", import.meta.url);
const src = fs.readFileSync(file, "utf8");
const good = 'const bill = parseFloat(document.getElementById("bill").value);';
const bad = 'const bill = document.getElementById("bill").value;';
if (!src.includes(good)) { console.log("app/app.js is not in the expected state; nothing changed"); process.exit(1); }
fs.writeFileSync(file, src.replace(good, bad));
console.log("Injected regression into app/app.js:\n- " + good + "\n+ " + bad);
