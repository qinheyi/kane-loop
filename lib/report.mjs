// Self-contained HTML report for one kane-loop run (REPORT.html next to loop.json).
// Reads only files kane-loop already wrote: loop.json, iter-*/patch.diff, failure-report.json and Kane screenshots.
import fs from "node:fs";
import path from "node:path";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const secs = (s) => (s == null ? "–" : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Number(s).toFixed(1)}s`);
const iterDirFor = (runDir, it) => path.join(runDir, it.kind === "task" ? "iter-0-task" : `iter-${it.iteration}`);

function diffHtml(diff) {
  return diff.split("\n").filter((l) => l.length).map((l) => {
    const cls = l.startsWith("+++") || l.startsWith("---") ? "meta" : l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : "";
    return `<span class="${cls}">${esc(l) || " "}</span>`;
  }).join("");
}

function flowCard(r, dir, runDir, failures) {
  const shot = path.join(dir, r.flow, "last-screenshot.jpg");
  const rel = fs.existsSync(shot) ? path.relative(runDir, shot).split(path.sep).join("/") : null;
  const fr = failures?.find((f) => f.flow === r.flow);
  const consoleErrors = [...new Set((fr?.browser_console ?? []).filter((c) => c.level === "error").map((c) => c.text))];
  const failed = (r.steps ?? []).filter((s) => s.status === "failed");
  const steps = (r.steps ?? []).filter((s) => s.remark);
  return `<article class="flow ${r.passed ? "pass" : "fail"}">
  <div class="flow-main">
    <div class="flow-head"><span class="badge ${r.passed ? "pass" : "fail"}">${r.passed ? "PASS" : "FAIL"}</span><h4>${esc(r.flow)}</h4>
      <span class="meta">${secs(r.duration ?? r.seconds)} · ${(r.credits ?? 0).toFixed(1)} credits</span></div>
    <p class="objective">${esc(r.objective)}</p>
    ${r.oneLiner || r.reason ? `<p class="kane"><b>Kane:</b> ${esc(r.oneLiner ?? r.reason)}</p>` : ""}
    ${!r.passed && r.reasonCode ? `<p><code class="code">${esc(r.reasonCode)}</code></p>` : ""}
    ${!r.passed && failed.length ? `<p class="failstep">Failed at step ${failed.map((s) => `${s.step}: ${esc(s.remark)}`).join("; ")}</p>` : ""}
    ${consoleErrors.length ? `<p class="console">Browser console: ${consoleErrors.map((t) => `<code>${esc(t)}</code>`).join(" ")}</p>` : ""}
    ${steps.length ? `<details><summary>${steps.length} Kane steps</summary><ol class="steps">${steps.map((s) => `<li class="${s.status}" value="${s.step}">${esc(s.remark)}</li>`).join("")}</ol></details>` : ""}
    ${r.testUrl ? `<a class="link" href="${esc(r.testUrl)}" target="_blank" rel="noopener">Open run in TestMu Test Manager ↗</a>` : ""}
  </div>
  ${rel ? `<a class="shot" href="${esc(rel)}" target="_blank"><img src="${esc(rel)}" alt="Kane's last screenshot for ${esc(r.flow)}" loading="lazy"></a>` : ""}
</article>`;
}

export function renderHtmlReport(runDir) {
  const h = readJson(path.join(runDir, "loop.json"));
  if (!h) throw new Error(`no loop.json in ${runDir}`);
  const verifies = h.iterations.filter((i) => i.kind === "verify");
  const flows = verifies.at(-1)?.results ?? [];
  const elapsed = h.finished ? (new Date(h.finished) - new Date(h.started)) / 1000 : null;
  const fixes = h.iterations.filter((i) => i.kind !== "verify" && i.changed);
  const blocks = [];
  for (const it of h.iterations) {
    const dir = iterDirFor(runDir, it);
    if (it.kind === "verify") {
      const failures = readJson(path.join(dir, "failure-report.json"));
      const allPass = it.results.every((r) => r.passed);
      blocks.push(`<section class="step">
  <div class="node ${allPass ? "pass" : "fail"}">${allPass ? "✓" : "✕"}</div>
  <div class="body"><h3>Round ${it.iteration} · Kane CLI <span class="pill ${allPass ? "pass" : "fail"}">${it.results.filter((r) => r.passed).length}/${it.results.length} flows passed</span></h3>
  ${it.results.map((r) => flowCard(r, dir, runDir, failures)).join("\n")}</div></section>`);
    } else {
      const diff = read(path.join(dir, "patch.diff"));
      const who = it.fixer === "minimax" ? "MiniMax-M2.7" : it.fixer === "rollback-to-last-green" ? "Deterministic rollback" : "No fixer";
      const tokens = it.usage?.total_tokens ? ` · ${it.usage.total_tokens.toLocaleString("en-US")} tokens` : "";
      blocks.push(`<section class="step">
  <div class="node agent">${it.kind === "task" ? "✎" : "↻"}</div>
  <div class="body"><h3>${it.kind === "task" ? "Agent implements the task" : "Agent repairs the failure"} <span class="pill agent">${esc(who)}${tokens}</span></h3>
  <div class="agent-card">
    ${it.diagnosis ? `<p class="diag">${esc(it.diagnosis)}</p>` : `<p class="diag muted">${esc(it.error ?? "no change")}</p>`}
    ${diff && diff.trim() ? `<pre class="diff">${diffHtml(diff)}</pre>` : ""}
  </div></div></section>`);
    }
  }
  const title = `kane-loop ${h.command} — ${h.green ? "GREEN" : "NOT GREEN"}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7fb;--card:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--soft:#f1f5f9;--accent:#4f46e5;--ok:#059669;--ok-bg:#ecfdf5;--bad:#dc2626;--bad-bg:#fef2f2;--ag:#7c3aed;--ag-bg:#f5f3ff;--code:#0b1020}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#111729;--text:#e5e7eb;--muted:#94a3b8;--line:#243049;--soft:#0d1324;--accent:#818cf8;--ok:#34d399;--ok-bg:rgba(16,185,129,.12);--bad:#f87171;--bad-bg:rgba(239,68,68,.12);--ag:#a78bfa;--ag-bg:rgba(139,92,246,.14);--code:#060a16}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:32px 20px 60px}
header.top{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;margin-bottom:22px}
.brand{display:flex;align-items:center;gap:12px}.logo{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:grid;place-items:center;color:#fff;font-weight:800}
h1{margin:0;font-size:1.45rem;letter-spacing:-.02em}.sub{margin:0;color:var(--muted);font-size:.9rem}
.verdict{font-weight:800;letter-spacing:.04em;padding:10px 18px;border-radius:999px;font-size:.95rem}.verdict.pass{background:var(--ok-bg);color:var(--ok)}.verdict.fail{background:var(--bad-bg);color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}.stat b{display:block;font-size:1.5rem;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:.82rem}
.step{display:grid;grid-template-columns:36px 1fr;gap:14px;position:relative}.step:not(:last-child)::before{content:"";position:absolute;left:17px;top:38px;bottom:-6px;width:2px;background:var(--line)}
.node{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;z-index:1}.node.pass{background:var(--ok)}.node.fail{background:var(--bad)}.node.agent{background:var(--ag)}
.body{padding-bottom:22px;min-width:0}.body h3{margin:6px 0 12px;font-size:1.05rem;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.pill{font-size:.75rem;font-weight:700;padding:3px 10px;border-radius:999px}.pill.pass{background:var(--ok-bg);color:var(--ok)}.pill.fail{background:var(--bad-bg);color:var(--bad)}.pill.agent{background:var(--ag-bg);color:var(--ag)}
.flow{display:grid;grid-template-columns:1fr 220px;gap:16px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:14px;padding:14px 16px;margin-bottom:10px}
.flow.fail{border-left-color:var(--bad)}.flow-main{min-width:0}
.flow-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.flow-head h4{margin:0;font-size:1rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.flow-head .meta{margin-left:auto;color:var(--muted);font-size:.82rem;font-variant-numeric:tabular-nums}
.badge{font-size:.7rem;font-weight:800;letter-spacing:.06em;padding:3px 8px;border-radius:6px;color:#fff}.badge.pass{background:var(--ok)}.badge.fail{background:var(--bad)}
.objective{margin:8px 0 6px;color:var(--muted);font-size:.88rem}.kane{margin:6px 0}.failstep{margin:6px 0;color:var(--bad);font-size:.88rem}.console{margin:6px 0;font-size:.88rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.84em;background:var(--soft);border:1px solid var(--line);padding:1px 6px;border-radius:6px}code.code{color:var(--bad)}
details{margin:6px 0;font-size:.85rem}summary{cursor:pointer;color:var(--muted)}.steps{margin:6px 0 0;padding-left:28px;color:var(--muted)}.steps li.failed{color:var(--bad);font-weight:600}
.link{display:inline-block;margin-top:6px;color:var(--accent);font-size:.85rem;text-decoration:none;font-weight:600}.link:hover{text-decoration:underline}
.shot img{width:100%;border-radius:10px;border:1px solid var(--line);display:block}
.agent-card{background:var(--ag-bg);border:1px solid color-mix(in srgb,var(--ag) 30%,transparent);border-radius:14px;padding:14px 16px}.diag{margin:0 0 10px}.diag.muted{color:var(--muted)}
pre.diff{margin:0;background:var(--code);color:#cbd5e1;border-radius:10px;padding:12px 14px;overflow:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
pre.diff span{display:block;white-space:pre}pre.diff .add{color:#4ade80;background:rgba(74,222,128,.08)}pre.diff .del{color:#f87171;background:rgba(248,113,113,.08)}pre.diff .hunk{color:#93c5fd}pre.diff .meta{color:#94a3b8}
footer{margin-top:20px;color:var(--muted);font-size:.82rem}footer a{color:var(--accent)}
@media (max-width:720px){.flow{grid-template-columns:1fr}.shot{max-width:320px}}
</style></head><body><div class="wrap">
<header class="top"><div class="brand"><div class="logo">K</div><div><h1>kane-loop ${esc(h.command)}</h1><p class="sub">Started ${esc(new Date(h.started).toISOString().replace("T", " ").slice(0, 19))} UTC · verified by Kane CLI in real headless Chrome</p></div></div>
<div class="verdict ${h.green ? "pass" : "fail"}">${h.green ? "✓ GREEN" : "✕ NOT GREEN"}</div></header>
<div class="stats">
  <div class="stat"><b>${flows.filter((r) => r.passed).length}/${flows.length}</b><span>flows green in the final round</span></div>
  <div class="stat"><b>${verifies.length}</b><span>Kane round${verifies.length === 1 ? "" : "s"}</span></div>
  <div class="stat"><b>${fixes.length}</b><span>agent patch${fixes.length === 1 ? "" : "es"} applied</span></div>
  <div class="stat"><b>${(h.creditsUsed ?? 0).toFixed(1)}</b><span>Kane credits used</span></div>
  <div class="stat"><b>${secs(elapsed)}</b><span>wall time</span></div>
</div>
${blocks.join("\n")}
<footer>Generated by <a href="https://github.com/qinheyi/kane-loop">kane-loop</a> from <code>loop.json</code>. Raw Kane NDJSON for every flow sits next to this file.</footer>
</div></body></html>`;
}

export function writeHtmlReport(runDir) {
  const out = path.join(runDir, "REPORT.html");
  fs.writeFileSync(out, renderHtmlReport(runDir));
  return out;
}
