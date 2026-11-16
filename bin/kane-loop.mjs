#!/usr/bin/env node
// kane-loop: close the loop between a coding agent and Kane CLI.
//   kane-loop verify                 run every Kane flow once (exit 0 = all green)
//   kane-loop fix                    verify -> agent reads Kane's failure -> patch -> re-verify, until green
//   kane-loop task "<change>" [--flow "<Kane objective>"]
//                                    agent implements a change, then the fix loop proves it (plus the new flow) with Kane
//   kane-loop watch [--fix]          re-verify on every save of an app file (and auto-fix with --fix)
// Options: --config <file> (default kane-loop.config.json), --max <n> iterations, --no-agent (fallback only)
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { runKane, readEvidence } from "../lib/kane.mjs";
import { askAgent, applyPatch, failureReport, snapshotGreen, rollbackToGreen } from "../lib/agent.mjs";

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(name);
const cmd = argv[0] ?? "help";
const root = process.cwd();
const cfgPath = path.resolve(opt("--config", "kane-loop.config.json"));
const c = (code, s) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), dim = (s) => c(2, s), bold = (s) => c(1, s), cyan = (s) => c(36, s), yellow = (s) => c(33, s);
const log = (...a) => console.log(...a);

if (cmd === "help" || cmd === "--help") {
  log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const stateDir = path.join(root, ".kane-loop");
const canFix = cmd === "fix" || cmd === "task" || (cmd === "watch" && flag("--fix"));
const maxIter = canFix ? Number(opt("--max", cfg.maxIterations ?? 4)) : 1;
let runDir, history;

async function ensureApp() {
  const ok = async () => { try { const r = await fetch(cfg.app.url); return r.ok; } catch { return false; } };
  if (await ok()) return null;
  if (!cfg.app.start) throw new Error(`app not reachable at ${cfg.app.url} and no app.start command configured`);
  log(dim(`starting app: ${cfg.app.start}`));
  const [bin, ...rest] = cfg.app.start.split(" ");
  const child = spawn(bin, rest, { cwd: root, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { if (await ok()) return child; await new Promise((r) => setTimeout(r, 250)); }
  child.kill();
  throw new Error(`app did not come up at ${cfg.app.url}`);
}

function printEvent(flowName, ev) {
  if (ev.type === undefined && ev.status === "done" && ev.remark) log(dim(`   [${flowName}] step ${ev.step}: ${ev.remark}`));
  if (ev.type === undefined && ev.status === "failed") log(red(`   [${flowName}] step ${ev.step} FAILED: ${ev.remark}`));
  if (ev.type === "error") log(red(`   [${flowName}] kane error: ${ev.message ?? JSON.stringify(ev)}`));
}

async function verifyAll(iterDir, flows = cfg.flows) {
  const results = [];
  for (const flow of flows) {
    log(cyan(` > kane-cli run "${flow.name}"`) + dim(`  (${flow.objective.slice(0, 90)}${flow.objective.length > 90 ? "..." : ""})`));
    const r = await runKane(flow, cfg, iterDir, { onEvent: (ev) => printEvent(flow.name, ev) });
    const credits = r.credits ? ` ${r.credits.toFixed(1)} credits` : "";
    if (r.passed) log(green(`   PASS ${flow.name}`) + dim(` ${r.duration ?? "?"}s${credits}`));
    else log(red(`   FAIL ${flow.name} [${r.status}, exit ${r.exitCode}]`) + ` ${r.oneLiner ?? r.reason ?? ""}` + dim(`${credits}`));
    if (r.testUrl) log(dim(`   Test Manager: ${r.testUrl.split("?")[0]}`));
    results.push(r);
  }
  return results;
}

function diffFiles(before, iterDir) {
  const chunks = [];
  for (const f of cfg.app.files) {
    const a = before.get(f), b = fs.readFileSync(path.join(root, f), "utf8");
    if (a === b) continue;
    const tmpA = path.join(iterDir, "before-" + path.basename(f));
    fs.writeFileSync(tmpA, a);
    try { execFileSync("diff", ["-u", "--label", `a/${f}`, "--label", `b/${f}`, tmpA, path.join(root, f)], { encoding: "utf8" }); }
    catch (e) { chunks.push(e.stdout); }
    fs.rmSync(tmpA);
  }
  const text = chunks.join("\n");
  fs.writeFileSync(path.join(iterDir, "patch.diff"), text);
  return text;
}

const readAll = () => new Map(cfg.app.files.map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]));

async function agentStep({ mode, instruction, failures, iterDir }) {
  const before = readAll();
  let fixer = "none", diagnosis = null, usage = null, error = null;
  if (!flag("--no-agent")) {
    try {
      log(yellow(mode === "task" ? ` agent: implementing "${instruction}"` : ` agent: reading Kane failure, asking ${process.env.KANE_LOOP_MODEL ?? "MiniMax-M2.7"} for a patch...`));
      const res = await askAgent({ mode, cfg, root, instruction, failures });
      fs.writeFileSync(path.join(iterDir, "agent-reply.json"), JSON.stringify(res.patch, null, 2));
      applyPatch(res.patch, cfg, root);
      fixer = "minimax"; diagnosis = res.patch.diagnosis; usage = res.usage;
      log(yellow(`   diagnosis: ${diagnosis}`));
    } catch (e) { error = e.message; log(red(`   agent unavailable or patch rejected: ${e.message}`)); }
  }
  if (fixer === "none" && mode === "fix") {
    const changed = rollbackToGreen(cfg, root, stateDir);
    if (changed.length) { fixer = "rollback-to-last-green"; diagnosis = `deterministic fallback restored ${changed.join(", ")} from the last Kane-verified snapshot`; log(yellow(`   fallback: ${diagnosis}`)); }
  }
  const diff = diffFiles(before, iterDir);
  if (diff) log(dim(diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).map((l) => "   " + l).join("\n")));
  return { fixer, diagnosis, usage, error, changed: !!diff };
}

async function loop({ instruction } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  runDir = path.join(stateDir, "runs", `${stamp}-${cmd}`);
  history = { command: cmd, started: new Date().toISOString(), cli: "kane-loop", iterations: [] };
  fs.mkdirSync(runDir, { recursive: true });
  const app = await ensureApp();
  let ok = false;
  try {
    if (instruction) {
      const iterDir = path.join(runDir, "iter-0-task");
      fs.mkdirSync(iterDir, { recursive: true });
      log(bold(`\n== task: ${instruction}`));
      const step = await agentStep({ mode: "task", instruction, iterDir });
      history.iterations.push({ iteration: 0, kind: "task", ...step });
      if (!step.changed) log(red("   agent made no change"));
    }
    for (let i = 1; i <= maxIter; i++) {
      const iterDir = path.join(runDir, `iter-${i}`);
      log(bold(`\n== iteration ${i}/${maxIter}: Kane CLI verifies ${cfg.flows.length} flow(s) on ${cfg.app.url}`));
      const results = await verifyAll(iterDir);
      const evidence = Object.fromEntries(results.map((r) => [r.flow, readEvidence(r.evidencePack, path.join(iterDir, r.flow))]));
      const entry = { iteration: i, kind: "verify", results: results.map(({ events, failedSteps, ...rest }) => rest) };
      history.iterations.push(entry);
      fs.writeFileSync(path.join(iterDir, "results.json"), JSON.stringify(entry, null, 2));
      if (results.some((r) => r.exitCode === 2)) { log(red("\nKane CLI did not start (sign-in, Chrome or config). Not a test failure; fix setup and rerun.")); break; }
      if (results.every((r) => r.passed)) {
        snapshotGreen(cfg, root, stateDir);
        ok = true;
        log(green(bold(`\nGREEN after ${i} Kane run(s). Snapshot saved as last-green.`)));
        break;
      }
      if (!canFix || i === maxIter) break;
      const failures = failureReport(results, evidence);
      fs.writeFileSync(path.join(iterDir, "failure-report.json"), JSON.stringify(failures, null, 2));
      const step = await agentStep({ mode: "fix", failures, iterDir });
      history.iterations.push({ iteration: i, kind: "fix", ...step });
      if (!step.changed) { log(red("   no fix could be applied; stopping")); break; }
    }
  } finally {
    app?.kill();
  }
  history.finished = new Date().toISOString();
  history.green = ok;
  history.creditsUsed = history.iterations.flatMap((it) => it.results ?? []).reduce((s, r) => s + (r.credits || 0), 0);
  fs.writeFileSync(path.join(runDir, "loop.json"), JSON.stringify(history, null, 2));
  writeReport();
  log(dim(`\nrun log: ${path.relative(root, runDir)}/ (loop.json, REPORT.md, raw Kane NDJSON per flow)`));
  return ok;
}

function writeReport() {
  const lines = [`# kane-loop ${history.command} — ${history.started}`, "", `Result: **${history.green ? "GREEN" : "NOT GREEN"}** · Kane credits used: ${history.creditsUsed.toFixed(1)}`, ""];
  for (const it of history.iterations) {
    if (it.kind === "verify") {
      lines.push(`## Iteration ${it.iteration}: Kane CLI`, "", "| flow | verdict | exit | Kane summary |", "|---|---|---|---|");
      for (const r of it.results) lines.push(`| ${r.flow} | ${r.passed ? "PASS" : "FAIL"} (${r.status}) | ${r.exitCode} | ${(r.oneLiner ?? r.reason ?? "").replace(/\|/g, "/")} |`);
      lines.push("");
    } else {
      lines.push(`### ${it.kind === "task" ? "Agent task" : "Agent fix"} (${it.fixer})`, "", it.diagnosis ? `> ${it.diagnosis}` : `> ${it.error ?? "no change"}`, "");
    }
  }
  fs.writeFileSync(path.join(runDir, "REPORT.md"), lines.join("\n"));
}

async function watch() {
  log(bold(`watching ${cfg.app.files.join(", ")} — every save triggers Kane CLI${flag("--fix") ? " and the auto-fix loop" : ""}. Ctrl+C to stop.`));
  let timer = null, busy = false, last = readAll();
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const now = readAll();
      if (busy || [...now].every(([f, t]) => last.get(f) === t)) return;
      busy = true;
      log(bold(`\n[watch] change detected at ${new Date().toLocaleTimeString()}`));
      try { await loop(); } catch (e) { log(red(e.message)); }
      last = readAll(); busy = false;
    }, 1500);
  };
  for (const f of cfg.app.files) fs.watch(path.join(root, f), trigger);
}

try {
  if (cmd === "verify" || cmd === "fix") process.exit((await loop()) ? 0 : 1);
  else if (cmd === "task") {
    const instruction = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(arr[i - 1] ?? "").startsWith("--")).join(" ");
    if (!instruction) throw new Error('usage: kane-loop task "<change request>"');
    const extra = opt("--flow");
    if (extra) cfg.flows.push({ name: "task-flow", objective: extra });
    process.exit((await loop({ instruction })) ? 0 : 1);
  } else if (cmd === "watch") { if (!flag("--fix")) argv.push("--max", "1"); await watch(); }
  else { log(`unknown command ${cmd}; try kane-loop help`); process.exit(2); }
} catch (e) { console.error(red(e.message)); process.exit(2); }
