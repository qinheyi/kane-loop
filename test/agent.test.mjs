import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePatch, applyPatch, failureReport } from "../lib/agent.mjs";
import { summarize } from "../lib/kane.mjs";

const cfg = { app: { files: ["a.js"] }, flows: [] };

test("parsePatch strips think blocks and fences", () => {
  const p = parsePatch('<think>hmm</think>\n```json\n{"diagnosis":"d","edits":[{"file":"a.js","find":"x","replace":"y"}]}\n```');
  assert.equal(p.edits[0].replace, "y");
});

test("applyPatch rejects ambiguous or foreign edits and applies exact ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl-"));
  fs.writeFileSync(path.join(dir, "a.js"), "let a = 1;\nlet b = 1;\n");
  assert.throws(() => applyPatch({ edits: [{ file: "a.js", find: "= 1", replace: "= 2" }] }, cfg, dir), /matched 2 times/);
  assert.throws(() => applyPatch({ edits: [{ file: "b.js", find: "x", replace: "y" }] }, cfg, dir), /non-editable/);
  applyPatch({ edits: [{ file: "a.js", find: "let b = 1;", replace: "let b = 2;" }] }, cfg, dir);
  assert.equal(fs.readFileSync(path.join(dir, "a.js"), "utf8"), "let a = 1;\nlet b = 2;\n");
});

test("summarize reads run_end and failed steps from Kane NDJSON events", () => {
  const events = [
    { type: "stream_start" },
    { step: 2, status: "done", remark: "navigate" },
    { step: 3, status: "failed", remark: "assert: total shown" },
    { type: "run_end", status: "failed", one_liner: "x", reason: "Assertion failed", credits_consumed: 12.5, context: { memory: { c: { condition: "total shown", expected_value: "true", extracted_value: "false" } } } },
  ];
  const r = summarize({ name: "f", objective: "o" }, 1, events);
  assert.equal(r.passed, false);
  assert.equal(r.failedSteps.length, 1);
  const rep = failureReport([r], {});
  assert.equal(rep[0].failed_assertions[0].observed, "false");
});

test("exit 0 without run_end passed is not treated as green", () => {
  assert.equal(summarize({ name: "f", objective: "o" }, 0, []).passed, false);
});
