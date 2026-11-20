#!/usr/bin/env node
// kane-loop: close the loop between a coding agent and Kane CLI.
//   kane-loop verify                 run every Kane flow once (exit 0 = all green)
//   kane-loop fix                    verify -> agent reads Kane's failure -> patch -> re-verify, until green
//   kane-loop task "<change>" [--flow "<Kane objective>"]
//                                    agent implements a change, then the fix loop proves it (plus the new flow) with Kane
//   kane-loop watch [--fix]          re-verify on every save of an app file (and auto-fix with --fix)
//   kane-loop report [<run dir>]     rebuild REPORT.html for a run (default: the latest run)
// Options: --config <file> (default kane-loop.config.json), --max <n> iterations, --no-agent (fallback only)
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { runKane, readEvidence } from "../lib/kane.mjs";
import { askAgent, applyPatch, failureReport, snapshotGreen, rollbackToGreen } from "../lib/agent.mjs";
import { bold, dim, red, green, yellow, cyan, magenta, gray, badge, sym, rule, box, clip, width, fmtSecs } from "../lib/ui.mjs";
import { writeHtmlReport } from "../lib/report.mjs";

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(name);
const cmd = argv[0] ?? "help";
const root = process.cwd();
const cfgPath = path.resolve(opt("--config", "kane-loop.config.json"));
const log = (...a) => console.log(...a);

if (cmd === "help" || cmd === "--help") {
  log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

if (cmd === "report") {
  const runs = path.join(root, ".kane-loop", "runs");
  const dir = argv[1] && !argv[1].startsWith("--") ? path.resolve(argv[1])
    : fs.existsSync(runs) ? path.join(runs, fs.readdirSync(runs).sort().at(-1) ?? "") : null;
  if (!dir || !fs.existsSync(path.join(dir, "loop.json"))) { console.error(red(`no loop.json found${dir ? " in " + dir : ""}`)); process.exit(2); }
  const html = writeHtmlReport(dir);
  printSummary(JSON.parse(fs.readFileSync(path.join(dir, "loop.json"), "utf8")), dir, html);
  process.exit(0);
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
// KANE_LOOP_URL points every flow at another deployment (e.g. the live Vercel URL) without editing the config.
if (process.env.KANE_LOOP_URL) {
  const target = process.env.KANE_LOOP_URL.replace(/\/$/, "");
  for (const f of cfg.flows) f.objective = f.objective.split(cfg.app.url).join(target);
  cfg.app = { ...cfg.app, url: target, start: null };
}
const stateDir = path.join(root, ".kane-loop");
const canFix = cmd === "fix" || cmd === "task" || (cmd === "watch" && flag("--fix"));
const maxIter = canFix ? Number(opt("--max", cfg.maxIterations ?? 4)) : 1;
let runDir, history;

async function ensureApp() {
  const ok = async () => { try { const r = await fetch(cfg.app.url); return r.ok; } catch { return false; } };
  if (await ok()) return null;
  if (!cfg.app.start) throw new Error(`app not reachable at ${cfg.app.url} and no app.start command configured`);
  log(dim(`  starting app: ${cfg.app.start}`));
  const [bin, ...rest] = cfg.app.start.split(" ");
  const child = spawn(bin, rest, { cwd: root, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { if (await ok()) return child; await new Promise((r) => setTimeout(r, 250)); }
  child.kill();
  throw new Error(`app did not come up at ${cfg.app.url}`);
}

// One Kane step per line:  "  │  4  type     Type "120" into "Bill amount""
function printEvent(flowName, ev) {
  const fmt = (remark) => {
    const m = /^(\w+):\s*(.*)$/.exec(remark ?? "") ?? [null, "", remark ?? ""];
    return { action: m[1].padEnd(8), text: clip(m[2], width() - 20) };
  };
  if (ev.type === undefined && ev.status === "done" && ev.remark) {
    const { action, text } = fmt(ev.remark);
    log(`   ${gray(sym.bar)} ${gray(String(ev.step).padStart(2))}  ${cyan(action)} ${dim(text)}`);
  }
  if (ev.type === undefined && ev.status === "failed") {
    const { action, text } = fmt(ev.remark);
    log(`   ${red(sym.fail)} ${red(String(ev.step).padStart(2))}  ${red(bold(action))} ${red(text)}`);
  }
  if (ev.type === "error") log(`   ${red(sym.fail)} ${red(`kane error: ${ev.message ?? JSON.stringify(ev)}`)}`);
}

async function verifyAll(iterDir, flows = cfg.flows) {
  const results = [];
  for (const flow of flows) {
    log(`\n ${bold(cyan(sym.arrow + " " + flow.name))}  ${dim(clip(flow.objective, width() - flow.name.length - 6))}`);
    const r = await runKane(flow, cfg, iterDir, { onEvent: (ev) => printEvent(flow.name, ev) });
    const meta = dim(` ${fmtSecs(r.duration ?? r.seconds)}${r.credits ? ` ${sym.dot} ${r.credits.toFixed(1)} credits` : ""}`);
    if (r.passed) log(`   ${badge("PASS", "pass")} ${green(flow.name)}${meta}`);
    else {
      log(`   ${badge("FAIL", "fail")} ${red(bold(flow.name))} ${dim(`(${r.status}, exit ${r.exitCode})`)}${meta}`);
      if (r.reasonCode) log(`     ${dim("reason")}  ${yellow(r.reasonCode)}`);
      if (r.oneLiner ?? r.reason) log(`     ${dim("kane  ")}  ${r.oneLiner ?? r.reason}`);
    }
    if (r.testUrl) log(`     ${dim("replay")}  ${gray(clip(r.testUrl.split("?")[0], width() - 14))}`);
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
      const model = process.env.KANE_LOOP_MODEL ?? "MiniMax-M2.7";
      log(`\n ${badge("AGENT", "agent")} ${magenta(mode === "task" ? `${model} implementing "${instruction}"` : `${model} reads Kane's failure report and proposes a patch…`)}`);
      const res = await askAgent({ mode, cfg, root, instruction, failures });
      fs.writeFileSync(path.join(iterDir, "agent-reply.json"), JSON.stringify(res.patch, null, 2));
      applyPatch(res.patch, cfg, root);
      fixer = "minimax"; diagnosis = res.patch.diagnosis; usage = res.usage;
      log(`   ${magenta(sym.agent)} ${dim("diagnosis")}  ${diagnosis}`);
    } catch (e) { error = e.message; log(`   ${yellow(sym.warn)} ${yellow(`agent unavailable or patch rejected: ${e.message}`)}`); }
  }
  if (fixer === "none" && mode === "fix") {
    const changed = rollbackToGreen(cfg, root, stateDir);
    if (changed.length) { fixer = "rollback-to-last-green"; diagnosis = `deterministic fallback restored ${changed.join(", ")} from the last Kane-verified snapshot`; log(`\n ${badge("FALLBACK", "warn")} ${yellow(diagnosis)}`); }
  }
  const diff = diffFiles(before, iterDir);
  if (diff) {
    const lines = diff.split("\n");
    const files = lines.filter((l) => l.startsWith("+++ ")).map((l) => l.slice(6));
    const add = lines.filter((l) => /^\+(?!\+\+)/.test(l)).length, del = lines.filter((l) => /^-(?!--)/.test(l)).length;
    log(`   ${magenta(sym.agent)} ${dim("patch    ")}  ${files.join(", ")} ${green("+" + add)} ${red("-" + del)}`);
    for (const l of lines.filter((l) => /^[+-](?![+-]{2})/.test(l))) log("     " + (l[0] === "+" ? green(clip(l, width() - 6)) : red(clip(l, width() - 6))));
  }
  return { fixer, diagnosis, usage, error, changed: !!diff };
}

async function loop({ instruction } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  runDir = path.join(stateDir, "runs", `${stamp}-${cmd}`);
  history = { command: cmd, started: new Date().toISOString(), cli: "kane-loop", iterations: [] };
  fs.mkdirSync(runDir, { recursive: true });
  const agentName = flag("--no-agent") ? "rollback-to-last-green (--no-agent)" : process.env.MINIMAX_API_KEY ? (process.env.KANE_LOOP_MODEL ?? "MiniMax-M2.7") : "rollback-to-last-green (no MINIMAX_API_KEY)";
  log(box([
    `${bold("kane-loop")} ${cyan(cmd)}  ${dim("an agent that can't ship until Kane CLI says green")}`,
    `${dim("app   ")} ${cfg.app.url}`,
    `${dim("flows ")} ${cfg.flows.map((f) => f.name).join(", ")}`,
    canFix ? `${dim("fixer ")} ${magenta(agentName)} ${dim(`${sym.dot} max ${maxIter} rounds`)}` : `${dim("mode  ")} verify only`,
  ], cyan));
  const app = await ensureApp();
  let ok = false;
  try {
    if (instruction) {
      const iterDir = path.join(runDir, "iter-0-task");
      fs.mkdirSync(iterDir, { recursive: true });
      log("\n" + rule(`task ${sym.dot} ${instruction}`));
      const step = await agentStep({ mode: "task", instruction, iterDir });
      history.iterations.push({ iteration: 0, kind: "task", ...step });
      if (!step.changed) log(`   ${red(sym.fail)} ${red("agent made no change")}`);
    }
    for (let i = 1; i <= maxIter; i++) {
      const iterDir = path.join(runDir, `iter-${i}`);
      log("\n" + rule(`round ${i}/${maxIter} ${sym.dot} Kane CLI verifies ${cfg.flows.length} flow${cfg.flows.length === 1 ? "" : "s"} on ${cfg.app.url}`));
      const results = await verifyAll(iterDir);
      const evidence = Object.fromEntries(results.map((r) => [r.flow, readEvidence(r.evidencePack, path.join(iterDir, r.flow))]));
      const entry = { iteration: i, kind: "verify", results: results.map(({ events, failedSteps, ...rest }) => rest) };
      history.iterations.push(entry);
      fs.writeFileSync(path.join(iterDir, "results.json"), JSON.stringify(entry, null, 2));
      if (results.some((r) => r.exitCode === 2)) { log(`\n ${badge("SETUP", "warn")} ${yellow("Kane CLI did not start (sign-in, Chrome or config). Not a test failure; fix setup and rerun.")}`); break; }
      if (results.every((r) => r.passed)) {
        snapshotGreen(cfg, root, stateDir);
        ok = true;
        break;
      }
      if (!canFix || i === maxIter) break;
      const failures = failureReport(results, evidence);
      fs.writeFileSync(path.join(iterDir, "failure-report.json"), JSON.stringify(failures, null, 2));
      const step = await agentStep({ mode: "fix", failures, iterDir });
      history.iterations.push({ iteration: i, kind: "fix", ...step });
      if (!step.changed) { log(`   ${red(sym.fail)} ${red("no fix could be applied; stopping")}`); break; }
    }
  } finally {
    app?.kill();
  }
  history.finished = new Date().toISOString();
  history.green = ok;
  history.creditsUsed = history.iterations.flatMap((it) => it.results ?? []).reduce((s, r) => s + (r.credits || 0), 0);
  fs.writeFileSync(path.join(runDir, "loop.json"), JSON.stringify(history, null, 2));
  writeReport();
  const html = writeHtmlReport(runDir);
  printSummary(history, runDir, html);
  return ok;
}

// Final scoreboard: one row per Kane round and agent step, then the verdict.
function printSummary(history, runDir, htmlPath) {
  const rows = [];
  for (const it of history.iterations) {
    if (it.kind === "verify") {
      const marks = it.results.map((r) => (r.passed ? green(sym.ok + " " + r.flow) : red(sym.fail + " " + r.flow))).join("  ");
      rows.push(`${dim(("round " + it.iteration).padEnd(9))} ${marks}`);
    } else {
      const who = it.fixer === "minimax" ? `${process.env.KANE_LOOP_MODEL ?? "MiniMax-M2.7"} patch` : it.fixer === "rollback-to-last-green" ? "rollback to last green" : "no fixer";
      rows.push(`${dim((it.kind === "task" ? "task" : "agent").padEnd(9))} ${magenta(sym.agent + " " + who)}${it.changed ? "" : dim(" (no change)")}`);
    }
  }
  const secs = (new Date(history.finished) - new Date(history.started)) / 1000;
  const verdict = history.green ? badge("GREEN", "pass") + " " + green(bold("every Kane flow passed — snapshot saved as last-green"))
    : badge("NOT GREEN", "fail") + " " + red(bold("Kane still reports a failure"));
  rows.push("", verdict, dim(`${history.creditsUsed.toFixed(1)} Kane credits ${sym.dot} ${fmtSecs(secs)} ${sym.dot} ${history.iterations.filter((i) => i.kind === "verify").length} round(s)`));
  log("\n" + box([bold(`kane-loop ${history.command}`), "", ...rows], history.green ? green : red));
  log(dim(`  report  ${path.relative(root, htmlPath)}`));
  log(dim(`  raw     ${path.relative(root, runDir)}/ (loop.json, REPORT.md, Kane NDJSON per flow)`));
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
  log(box([bold("kane-loop watch") + (flag("--fix") ? " " + badge("AUTO-FIX", "agent") : ""), dim(`watching ${cfg.app.files.join(", ")}`), dim(`every save triggers Kane CLI${flag("--fix") ? " and the auto-fix loop" : ""} ${sym.dot} Ctrl+C to stop`)], cyan));
  let timer = null, busy = false, last = readAll();
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const now = readAll();
      if (busy || [...now].every(([f, t]) => last.get(f) === t)) return;
      busy = true;
      log("\n" + badge("WATCH", "info") + " " + bold(`change detected at ${new Date().toLocaleTimeString()}`));
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
