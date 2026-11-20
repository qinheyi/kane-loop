// Terminal styling for kane-loop: colors on a TTY unless NO_COLOR is set; FORCE_COLOR=1 forces them (e.g. when piping to a log).
const on = () => (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") || (!process.env.NO_COLOR && !!process.stdout.isTTY);
const sgr = (open, close = 0) => (s) => (on() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const bold = sgr(1, 22), dim = sgr(2, 22), red = sgr(31, 39), green = sgr(32, 39), yellow = sgr(33, 39),
  blue = sgr(34, 39), magenta = sgr(35, 39), cyan = sgr(36, 39), gray = sgr(90, 39);
export const badge = (text, kind) => {
  const colors = { pass: "30;42", fail: "97;41", info: "30;46", agent: "30;45", warn: "30;43" };
  return on() ? `\x1b[${colors[kind] ?? "7"}m ${text} \x1b[0m` : `[${text}]`;
};
export const sym = { ok: "✔", fail: "✖", arrow: "▸", dot: "·", bar: "│", agent: "◆", warn: "▲" };
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
export const width = () => Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 100, 110);
export const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);
export function rule(title) {
  const t = ` ${title} `;
  return dim("──") + bold(t) + dim("─".repeat(Math.max(4, width() - strip(t).length - 2)));
}
export function box(lines, color = (s) => s) {
  const w = Math.min(width(), Math.max(...lines.map((l) => strip(l).length)) + 4);
  const pad = (l) => l + " ".repeat(Math.max(0, w - 4 - strip(l).length));
  return [color("╭" + "─".repeat(w - 2) + "╮"), ...lines.map((l) => color("│ ") + pad(l) + color(" │")), color("╰" + "─".repeat(w - 2) + "╯")].join("\n");
}
export const fmtSecs = (s) => (s == null ? "?" : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Number(s).toFixed(1)}s`);
export const visibleLength = (s) => strip(s).length;
