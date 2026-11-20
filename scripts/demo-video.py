"""Render kane-loop demo video v2 (new UI) from REAL run artifacts: the colored terminal log of a real
`break` + `kane-loop fix` run, Kane's evidence screenshots, the app and the generated REPORT.html.
Narration: edge-tts (en-US-GuyNeural). Captions burned in. Output: kane-loop-demo-v2.mp4 (+ .srt)
Usage: python build_v2.py <ansi log> <run dir> <screens dir>"""
import json, os, re, subprocess, textwrap, asyncio, shutil, sys
from PIL import Image, ImageDraw, ImageFont

LOG, RUN, SHOTS = sys.argv[1], sys.argv[2], sys.argv[3]
REPO = "/workspace/kane-loop"
OUT = os.path.dirname(os.path.abspath(__file__))
NAME = "kane-loop-demo-v2"
W, H = 1280, 720
CAP_H = 92
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONOB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANSB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
f_term, f_termb = ImageFont.truetype(MONO, 14), ImageFont.truetype(MONOB, 14)
f_cap = ImageFont.truetype(SANS, 24)
f_h1, f_h2 = ImageFont.truetype(SANSB, 50), ImageFont.truetype(SANSB, 30)
f_body, f_code, f_small = ImageFont.truetype(SANS, 23), ImageFont.truetype(MONO, 18), ImageFont.truetype(SANS, 18)
TTS = "/workspace/.venv-tts/bin/edge-tts"
VOICE = "en-US-GuyNeural"
BG = (11, 16, 32)
ACC = (129, 140, 248)
PAL = {30: (60, 60, 60), 31: (241, 76, 76), 32: (35, 209, 139), 33: (229, 192, 123), 34: (59, 142, 234), 35: (214, 112, 214),
       36: (41, 184, 219), 37: (229, 229, 229), 90: (128, 128, 128), 97: (255, 255, 255)}
FG = (212, 212, 212); DIM = (128, 134, 150)

# ---------- ANSI terminal ----------
def parse_ansi(line):
    segs, st = [], {"fg": None, "bg": None, "bold": False, "dim": False}
    for part in re.split(r"(\x1b\[[0-9;]*m)", line):
        m = re.fullmatch(r"\x1b\[([0-9;]*)m", part)
        if not m:
            if part: segs.append((part, dict(st)))
            continue
        codes = [int(c) for c in (m.group(1) or "0").split(";") if c != ""] or [0]
        for c in codes:
            if c == 0: st = {"fg": None, "bg": None, "bold": False, "dim": False}
            elif c == 1: st["bold"] = True
            elif c == 2: st["dim"] = True
            elif c == 22: st["bold"] = st["dim"] = False
            elif c == 39: st["fg"] = None
            elif c == 49: st["bg"] = None
            elif 30 <= c <= 37 or 90 <= c <= 97: st["fg"] = PAL.get(c, FG)
            elif 40 <= c <= 47: st["bg"] = PAL.get(c - 10, FG)
    return segs

def load_log():
    raw = open(LOG, encoding="utf-8").read().replace("\r\n", "\n").split("\n")
    out = []
    for l in raw:
        plain = re.sub(r"\x1b\[[0-9;]*m", "", l)
        if "Warning:" in plain or "trace-warnings" in plain: continue
        out.append(l)
    while out and not out[-1].strip(): out.pop()
    return out

CW = f_term.getlength("M")
def terminal(lines, title="kane-loop fix — bash"):
    img = Image.new("RGB", (W, H), (24, 24, 27)); d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 30], fill=(39, 39, 46))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]): d.ellipse([12 + i * 20, 9, 24 + i * 20, 21], fill=c)
    d.text((90, 7), title, font=f_term, fill=(170, 170, 180))
    lh = 18; maxl = (H - CAP_H - 44) // lh
    y = 40
    for l in lines[-maxl:]:
        x = 16
        for text, st in parse_ansi(l):
            fg = st["fg"] or FG
            if st["dim"]: fg = DIM if st["fg"] is None else tuple(int(v * .7) for v in fg)
            w = CW * len(text)
            if st["bg"]: d.rectangle([x, y - 1, x + w, y + lh - 2], fill=st["bg"])
            d.text((x, y), text, font=f_termb if st["bold"] else f_term, fill=fg); x += w
            if x > W - 10: break
        y += lh
    return img

# ---------- cards / screenshots ----------
def caption(img, text):
    d = ImageDraw.Draw(img)
    d.rectangle([0, H - CAP_H, W, H], fill=(0, 0, 0))
    lines = textwrap.wrap(text, 92)[:3]
    y = H - CAP_H + (CAP_H - 29 * len(lines)) // 2
    for l in lines:
        tw = d.textlength(l, font=f_cap); d.text(((W - tw) / 2, y), l, font=f_cap, fill=(255, 255, 255)); y += 29
    return img

def logo(d, x, y, s=56):
    d.rounded_rectangle([x, y, x + s, y + s], s // 4, fill=(99, 102, 241))
    d.rounded_rectangle([x + s * .25, y + s * .33, x + s * .6, y + s * .4], 2, fill=(255, 255, 255))
    d.rounded_rectangle([x + s * .25, y + s * .58, x + s * .75, y + s * .65], 2, fill=(255, 255, 255))

def card(title, body_lines=(), code=None, sub=None, right=None):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    logo(d, 70, 62)
    d.text((145, 60), title, font=f_h1 if len(title) < 30 else f_h2, fill=(255, 255, 255))
    y = 170
    if sub: d.text((145, 122), sub, font=f_small, fill=(148, 163, 184))
    tw = 70 if right is None else 64
    for b in body_lines:
        for w in textwrap.wrap(b, tw):
            d.text((70, y), w, font=f_body, fill=(203, 213, 225)); y += 33
        y += 10
    if code:
        y += 6
        d.rounded_rectangle([60, y, (W - 60) if right is None else 760, y + 25 * len(code) + 24], 12, fill=(17, 24, 39), outline=(36, 48, 73))
        y += 12
        for c in code:
            col = (241, 76, 76) if c.startswith("-") else (35, 209, 139) if c.startswith("+") else (148, 163, 184) if c.startswith("#") else (226, 232, 240)
            d.text((80, y), c[:100], font=f_code, fill=col); y += 25
    if right is not None:
        r = right.copy(); s = min(420 / r.width, (H - CAP_H - 170) / r.height); r = r.resize((int(r.width * s), int(r.height * s)), Image.LANCZOS)
        img.paste(r, (W - r.width - 60, 150))
    return img

def fit(path, label, crop=None, maxh=None):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    s = Image.open(path).convert("RGB")
    if crop: s = s.crop(crop(s.size))
    scale = min((W - 120) / s.width, ((maxh or H - CAP_H - 80)) / s.height)
    s = s.resize((int(s.width * scale), int(s.height * scale)), Image.LANCZOS)
    img.paste(s, ((W - s.width) // 2, 66))
    d.text((60, 20), label, font=f_h2, fill=(255, 255, 255))
    return img

def kane_shot(p, label):  # Kane screenshots are 1920x1080 browser frames; the app card sits in the middle
    return fit(p, label, crop=lambda sz: (int(sz[0] * .3), int(sz[1] * .03), int(sz[0] * .7), int(sz[1] * .97)))

async def tts(text, path):
    for _ in range(3):
        p = await asyncio.create_subprocess_exec(TTS, "--voice", VOICE, "--rate", "+8%", "--text", text, "--write-media", path)
        await p.wait()
        if p.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 1000: return
    raise RuntimeError("tts failed")

def dur(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode())

# ---------- data from the real run ----------
log = load_log()
plain = [re.sub(r"\x1b\[[0-9;]*m", "", l) for l in log]
def idx(pred, start=0): return next(i for i in range(start, len(plain)) if pred(plain[i]))
loop = json.load(open(f"{RUN}/loop.json"))
verifies = [i for i in loop["iterations"] if i["kind"] == "verify"]
fixes = [i for i in loop["iterations"] if i["kind"] == "fix"]
rounds = len(verifies)
first_agent = idx(lambda s: "AGENT" in s)
next_round = idx(lambda s: s.startswith("── round"), first_agent)
patch_last = max(i for i in range(first_agent, next_round) if re.match(r"^\s+\+", plain[i]))
box_start = idx(lambda s: s.startswith("╭"), patch_last)
fail1 = json.load(open(f"{RUN}/iter-1/failure-report.json"))
main_fail = next((f for f in fail1 if "product_bug" in (f.get("reason_code") or "")), fail1[0])
cons = sorted({c["text"] for c in main_fail.get("browser_console", []) if c.get("level") == "error"})
break_lines = ["\x1b[2m$\x1b[22m node scripts/break.mjs", "Injected regression into app/app.js:",
               "\x1b[31m- const bill = parseFloat(document.getElementById(\"bill\").value);\x1b[39m",
               "\x1b[32m+ const bill = document.getElementById(\"bill\").value;\x1b[39m", "", "\x1b[2m$\x1b[22m node bin/kane-loop.mjs fix"]
T = break_lines + log
off = len(break_lines)
r1_fail_end = off + first_agent
patch_end = off + patch_last
green_end = off + box_start - 1
end_all = len(T)
fail_shot = f"{RUN}/iter-1/{main_fail['flow']}/last-screenshot.jpg"
green_shot = f"{RUN}/iter-{rounds}/round-up-share/last-screenshot.jpg"
cfg = json.load(open(f"{REPO}/kane-loop.config.json"))
credits = loop["creditsUsed"]
app_light = Image.open(f"{SHOTS}/app-2-result.png").convert("RGB")
app_dark = Image.open(f"{SHOTS}/app-5-dark.png").convert("RGB")
crop_app = lambda im: im.crop((int(im.width * .31), int(im.height * .05), int(im.width * .69), int(im.height * .95)))
agent_lines = [plain[i] for i in range(first_agent, len(plain)) if "diagnosis" in plain[i]]
first_diag = agent_lines[0].split("diagnosis", 1)[1].strip() if agent_lines else ""

def reveal(a, b, step): return [terminal(T[:k]) for k in range(a, b + 1, step)] or [terminal(T[:b])]

round_word = {2: "two", 3: "three", 4: "four"}.get(rounds, str(rounds))
symptom_story = len(fixes) >= 2
scenes = [
  ([card("kane-loop", ["A coding agent that cannot ship until Kane CLI says green.", "Kane CLI checks the app in real Chrome. kane-loop hands Kane's verdict back to the agent, which patches the code and asks Kane again."],
         sub="Kane CLI Online Hackathon 2026 · Heyi Qin", right=crop_app(app_light))],
   ["This is kane-loop.", "A coding agent breaks a web app, Kane CLI catches it in a real browser, and the agent repairs it from Kane's own output, with no human in the loop."]),
  ([card("SplitBill + plain-English flows", [], code=sum(([f"# {f['name']}"] + textwrap.wrap(f["objective"].replace("Go to http://localhost:4173, ", ""), 58) for f in cfg["flows"]), []), right=crop_app(app_dark))],
   ["The app under test is SplitBill, a bill splitter with light and dark themes.", "What it must do is written as three plain-English Kane flows. No selectors, no test framework."]),
  ([terminal(T[:k]) for k in range(1, len(break_lines) + 1, 2)],
   ["Now we simulate a bad agent edit: the bill input is no longer parsed as a number."]),
  (reveal(len(break_lines) + 1, r1_fail_end, 3),
   ["kane-loop runs kane-cli in agent mode for every flow and streams each browser step.", "Kane fails the bill flows and labels it a confirmed product bug, with the reason, the failing step and a replay link."]),
  ([kane_shot(fail_shot, "Kane evidence: what the browser showed"),
    card("What kane-loop hands the agent", [], code=[
      f"reason_code: {main_fail['reason_code']}", *textwrap.wrap("kane: " + (main_fail.get("reason") or ""), 90)[:3],
      f"failed step: {(main_fail.get('failed_steps') or ['-'])[0]}"[:100], *([f"console: {c}" for c in cons][:2]),
      "+ last steps, final_state, failure.yaml, app source"])],
   ["kane-loop opens Kane's sealed evidence pack, pulls the console log and the last screenshot,", "and builds a structured failure report for the agent."]),
  (reveal(r1_fail_end + 1, patch_end + 1, 1),
   ["MiniMax reads the report and returns a JSON patch.", "kane-loop only accepts exact, unique edits to listed files, then applies it."]),
]
if symptom_story:
    scenes.append((reveal(patch_end + 2, green_end, 4),
      ["Kane runs every flow again in a fresh browser. This time the first patch only hid the crash, and Kane's assertion on the real amount caught it.",
       f"The agent gets the new evidence, fixes the root cause, and after {round_word} rounds every flow is green."]))
else:
    scenes.append((reveal(patch_end + 2, green_end, 4),
      ["Then Kane runs every flow again, in a fresh browser.", f"All green after {round_word} rounds. kane-loop snapshots this state as the last verified good version."]))
scenes += [
  ([terminal(T[:end_all]), kane_shot(green_shot, "Kane evidence: green run")],
   [f"The scoreboard sums it up: {rounds} Kane rounds, {len(fixes)} agent patch{'es' if len(fixes) != 1 else ''}, {credits:.0f} Kane credits.", "And Kane's own screenshot shows the fixed app."]),
  ([fit(f"{SHOTS}/report-top.png", "REPORT.html — written after every run", maxh=H - CAP_H - 70),
    fit(f"{SHOTS}/report-agent.png", "REPORT.html — agent patch and re-verify", maxh=H - CAP_H - 70)],
   ["Every run also writes a self-contained HTML report: each Kane round, the reason codes, the browser errors,", "the agent's diagnosis and diff, and Kane's screenshots."]),
  ([card("Try it", ["github.com/qinheyi/kane-loop", "", "npm run app                   SplitBill on :4173", "node bin/kane-loop.mjs fix    break -> Kane -> agent -> green", "kane-loop task | watch --fix | --no-agent rollback"],
         sub=f"Real run, kane-cli 0.10.4, {loop['started'][:10]} · raw Kane NDJSON in the repo")],
   ["Everything shown is a real run, with the raw Kane logs in the repo.", "kane-loop. Build with any agent, verify with Kane, and let the agent close the loop."]),
]

async def main():
    tmp = os.path.join(OUT, "build-v2"); shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
    segs, audio = [], []
    n = 0
    for si, (frames, sentences) in enumerate(scenes):
        ds = []
        for j, s in enumerate(sentences):
            ap = f"{tmp}/a{si}_{j}.mp3"; await tts(s, ap); ds.append(dur(ap) + 0.3); audio.append((ap, ds[-1]))
        total = sum(ds)
        cuts = sorted(set([0.0] + [total * k / len(frames) for k in range(1, len(frames))] + [sum(ds[:k]) for k in range(1, len(ds))]))
        cuts.append(total)
        for a, b in zip(cuts, cuts[1:]):
            if b - a < 0.01: continue
            fi = min(int(a / total * len(frames) + 1e-6), len(frames) - 1)
            ci = next(k for k in range(len(ds)) if a < sum(ds[: k + 1]) - 1e-6)
            img = caption(frames[fi].copy(), sentences[ci])
            p = f"{tmp}/f{n:04d}.png"; img.save(p); segs.append((p, b - a)); n += 1
    with open(f"{tmp}/frames.txt", "w") as f:
        for p, d in segs: f.write(f"file '{p}'\nduration {d:.3f}\n")
        f.write(f"file '{segs[-1][0]}'\n")
    padded = []
    for i, (p, d) in enumerate(audio):
        q = f"{tmp}/p{i:03d}.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", p, "-af", f"apad=whole_dur={d:.3f}", "-ar", "44100", "-ac", "1", q], check=True); padded.append(q)
    with open(f"{tmp}/alist.txt", "w") as f:
        for q in padded: f.write(f"file '{q}'\n")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", f"{tmp}/alist.txt", f"{tmp}/narration.wav"], check=True)
    out = os.path.join(OUT, f"{NAME}.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", f"{tmp}/frames.txt", "-i", f"{tmp}/narration.wav",
                    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-shortest",
                    "-movflags", "+faststart", out], check=True)
    t = 0.0; srt = []; k = 0; idx_ = 1
    fmt = lambda x: f"{int(x//3600):02d}:{int(x%3600//60):02d}:{int(x%60):02d},{int(x*1000%1000):03d}"
    for frames, sentences in scenes:
        for s in sentences:
            d = audio[k][1]; k += 1
            srt.append(f"{idx_}\n{fmt(t)} --> {fmt(t+d)}\n{s}\n"); idx_ += 1; t += d
    open(os.path.join(OUT, f"{NAME}.srt"), "w").write("\n".join(srt))
    print(out, dur(out))

asyncio.run(main())
