// The repair/feature agent. Live mode: MiniMax (OpenAI-compatible chat API).
// Fallback mode (no key, API error, or unusable patch): deterministic rollback of the
// editable files to the last snapshot that Kane verified green.
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1";
const MODEL = process.env.KANE_LOOP_MODEL ?? "MiniMax-M2.7";

const SYSTEM = `You are the coding agent inside kane-loop. You edit a small web app.
A real browser test runner (Kane CLI) checks the app with plain-English flows.
Reply with ONLY a JSON object, no prose, no markdown fences:
{"diagnosis": "<one or two sentences>", "edits": [{"file": "<path>", "find": "<exact text that occurs once in the file>", "replace": "<new text>"}]}
Rules: use the smallest edits that make every flow pass; "find" must be copied exactly from the file
and must be unique; only edit the files you were given; never weaken or remove the behaviour a flow checks.`;

function filesBlock(cfg, root) {
  return cfg.app.files.map((f) => `--- FILE: ${f}\n${fs.readFileSync(path.join(root, f), "utf8")}`).join("\n\n");
}

export function failureReport(results, evidence) {
  return results.filter((r) => !r.passed).map((r) => ({
    flow: r.flow,
    objective: r.objective,
    kane_status: r.status,
    exit_code: r.exitCode,
    reason: r.reason,
    reason_code: r.reasonCode,
    summary: r.summary,
    final_state: r.finalState,
    failed_assertions: Object.values(r.assertions ?? {}).filter((a) => a && a.expected_value !== a.extracted_value)
      .map((a) => ({ condition: a.condition, expected: a.expected_value, observed: a.extracted_value, reasoning: a.reasoning })),
    failed_steps: r.failedSteps.map((s) => s.remark),
    last_steps: r.steps.slice(-6).map((s) => `${s.status}: ${s.remark}`),
    browser_console: (evidence[r.flow]?.console ?? []).slice(-15),
    failure_record: evidence[r.flow]?.failure ?? null,
  }));
}

async function chat(messages, { maxTokens = 4000 } = {}) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0.2 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.base_resp?.status_code) throw new Error(`MiniMax HTTP ${res.status} ${body?.base_resp?.status_msg ?? ""}`.trim());
    const text = body.choices?.[0]?.message?.content ?? "";
    return { text, usage: body.usage ?? null };
  } finally { clearTimeout(timer); }
}

export function parsePatch(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in agent reply");
  const obj = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(obj.edits) || !obj.edits.length) throw new Error("agent reply has no edits");
  return obj;
}

/** Validate every edit before touching disk: allowed file, exact unique match. */
export function applyPatch(patch, cfg, root, { dryRun = false } = {}) {
  const staged = new Map();
  for (const e of patch.edits) {
    if (!cfg.app.files.includes(e.file)) throw new Error(`edit targets non-editable file ${e.file}`);
    const cur = staged.get(e.file) ?? fs.readFileSync(path.join(root, e.file), "utf8");
    const count = cur.split(e.find).length - 1;
    if (!e.find || count !== 1) throw new Error(`"find" text matched ${count} times in ${e.file}`);
    staged.set(e.file, cur.replace(e.find, () => e.replace));
  }
  if (!dryRun) for (const [f, text] of staged) fs.writeFileSync(path.join(root, f), text);
  return [...staged.keys()];
}

export async function askAgent({ mode, cfg, root, instruction, failures }) {
  const user = mode === "task"
    ? `Implement this change request in the app:\n${instruction}\n\nThe app must keep passing these Kane flows:\n${cfg.flows.map((f) => `- ${f.name}: ${f.objective}`).join("\n")}\n\n${filesBlock(cfg, root)}`
    : `Kane CLI ran the app in a real browser and these flows FAILED. Structured results from Kane's NDJSON stream and evidence pack:\n${JSON.stringify(failures, null, 2)}\n\nAll flows that must pass:\n${cfg.flows.map((f) => `- ${f.name}: ${f.objective}`).join("\n")}\n\nCurrent source:\n${filesBlock(cfg, root)}\n\nFind the bug in the source and fix it.`;
  const { text, usage } = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: user }]);
  return { patch: parsePatch(text), usage, raw: text };
}

// ---- deterministic fallback: last-green snapshots ----
export function snapshotGreen(cfg, root, stateDir) {
  const dir = path.join(stateDir, "last-green");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of cfg.app.files) {
    const target = path.join(dir, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, f), target);
  }
}

export function rollbackToGreen(cfg, root, stateDir) {
  const dir = path.join(stateDir, "last-green");
  const changed = [];
  for (const f of cfg.app.files) {
    const snap = path.join(dir, f);
    if (!fs.existsSync(snap)) continue;
    const a = fs.readFileSync(snap, "utf8");
    if (a !== fs.readFileSync(path.join(root, f), "utf8")) { fs.writeFileSync(path.join(root, f), a); changed.push(f); }
  }
  return changed;
}
