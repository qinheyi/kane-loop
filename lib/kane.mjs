// Run Kane CLI in agent mode and turn its NDJSON stream into a structured verdict.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Build kane-cli args. Credentials are never put on argv here: kane-cli uses the
 *  saved profile (`kane-cli login`), or LT_USERNAME / LT_ACCESS_KEY when KANE_LOOP_CI_AUTH=1. */
export function kaneArgs(flow, cfg) {
  const args = ["run", flow.objective, "--agent", "--timeout", String(cfg.kane?.timeout ?? 300)];
  if (cfg.kane?.headless !== false) args.push("--headless");
  if (cfg.app?.url && !/https?:\/\//.test(flow.objective)) args.push("--url", cfg.app.url);
  if (cfg.kane?.maxSteps) args.push("--max-steps", String(cfg.kane.maxSteps));
  return args;
}

export function runKane(flow, cfg, outDir, { onEvent } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const ndjsonPath = path.join(outDir, `${flow.name}.ndjson`);
  const stderrPath = path.join(outDir, `${flow.name}.stderr.log`);
  const args = kaneArgs(flow, cfg);
  const env = { ...process.env, KANE_CLI_USER_AGENT: "kane-loop" };
  if (process.env.KANE_LOOP_CI_AUTH === "1" && env.LT_USERNAME && env.LT_ACCESS_KEY) {
    // CI mode: per-run basic auth (see Kane CLI CI docs). Values come from env, never from files.
    args.push("--username", env.LT_USERNAME, "--access-key", env.LT_ACCESS_KEY);
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cfg.kane?.bin ?? "kane-cli", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(ndjsonPath);
    const err = fs.createWriteStream(stderrPath);
    let buf = "";
    const events = [];
    child.stdout.on("data", (chunk) => {
      out.write(chunk);
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { const ev = JSON.parse(line); events.push(ev); onEvent?.(ev); } catch { /* ignore non-JSON */ }
      }
    });
    child.stderr.on("data", (c) => err.write(c));
    child.on("error", (e) => {
      out.end(); err.end();
      resolve({ flow: flow.name, exitCode: 2, status: "did_not_start", reason: `could not launch kane-cli: ${e.message}`, events: [], ndjsonPath, stderrPath, seconds: 0 });
    });
    child.on("close", (code) => {
      if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch {} }
      out.end(); err.end();
      resolve(summarize(flow, code ?? 2, events, { ndjsonPath, stderrPath, seconds: (Date.now() - started) / 1000 }));
    });
  });
}

const EXIT_MEANING = { 0: "passed", 1: "failed", 2: "did_not_start", 3: "timeout_or_cancelled" };

export function summarize(flow, exitCode, events, extra = {}) {
  const end = [...events].reverse().find((e) => e.type === "run_end");
  const steps = events.filter((e) => e.type === undefined && typeof e.step === "number" && e.status !== "running");
  const failedSteps = steps.filter((s) => s.status === "failed");
  const errors = events.filter((e) => e.type === "error" || e.type === "warning").map((e) => ({ type: e.type, code: e.code, message: e.message ?? e.error ?? e.reason }));
  const coverage = events.find((e) => e.type === "coverage");
  return {
    flow: flow.name,
    objective: flow.objective,
    exitCode,
    status: end?.status ?? EXIT_MEANING[exitCode] ?? "unknown",
    passed: exitCode === 0 && end?.status === "passed",
    summary: end?.summary ?? null,
    oneLiner: end?.one_liner ?? null,
    reason: end?.reason ?? null,
    reasonCode: end?.reason_code ?? null,
    finalState: end?.final_state ?? null,
    assertions: end?.context?.memory ?? null,
    credits: end?.credits_consumed ?? 0,
    duration: end?.duration ?? null,
    testUrl: end?.test_url ?? null,
    sessionDir: end?.session_dir ?? null,
    evidencePack: coverage?.pack ?? null,
    steps: steps.map((s) => ({ step: s.step, status: s.status, remark: s.remark })),
    failedSteps,
    errors,
    ...extra,
  };
}

/** Pull the pieces an agent needs from the sealed .evidence pack (a zip):
 *  failure.yaml, browser console log, and the last screenshot. Best effort. */
export function readEvidence(packPath, outDir) {
  const res = { failure: null, console: [], lastScreenshot: null };
  if (!packPath || !fs.existsSync(packPath)) return res;
  let list = [];
  try { list = execFileSync("unzip", ["-Z1", packPath], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return res; }
  const read = (name) => { try { return execFileSync("unzip", ["-p", packPath, name], { encoding: "utf8", maxBuffer: 8e6 }); } catch { return null; } };
  if (list.includes("failure.yaml")) res.failure = read("failure.yaml");
  for (const name of list.filter((n) => n.endsWith("-console.ndjson"))) {
    for (const line of (read(name) || "").split("\n")) {
      if (!line.trim()) continue;
      try { res.console.push(JSON.parse(line)); } catch { res.console.push({ raw: line }); }
    }
  }
  const shots = list.filter((n) => n.endsWith("screenshot.jpg"))
    .sort((a, b) => parseInt(a.split("/steps/")[1]) - parseInt(b.split("/steps/")[1]));
  if (shots.length && outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, "last-screenshot.jpg");
    try { fs.writeFileSync(target, execFileSync("unzip", ["-p", packPath, shots.at(-1)], { maxBuffer: 2e7 })); res.lastScreenshot = target; } catch {}
  }
  return res;
}
