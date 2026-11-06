#!/usr/bin/env python3
"""자연과학개론 문항을 200dpi 로 잘라 work/blind/<연도>/ 에 둔다(현재 글자는 넣지 않음). 법 과목 텍스트 PDF 전 쪽은 OCR 해 work/ocr_law/ 에 둔다."""
import json, re, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import build_json as b

ROOT = Path(__file__).parent
exams = json.loads((ROOT / "work/exams.json").read_text(encoding="utf8"))


def crop(job):
    pdf, col, top, bottom, W, H, out = job
    page, half = int(col[:3]), col[3:]
    x, cw = (0, W) if not half else ((0, W // 2) if half == "L" else (W // 2, W // 2))
    subprocess.run(["pdftoppm", "-r", "200", "-gray", "-png", "-singlefile", "-f", str(page), "-l", str(page), "-x", str(x), "-y", str(round(top * H)),
                    "-W", str(cw), "-H", str(round((bottom - top) * H)), str(pdf), str(out.with_suffix(""))], check=True, capture_output=True)


jobs, manifest = [], {}
for e in exams:
    if e["session"] != 3 or e["kind"] != "ocr":
        continue
    pdf = ROOT / e["path"]
    info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    w, h = map(float, re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", info).groups())
    W, H = round(w / 72 * 200), round(h / 72 * 200)
    lines = b.ocr_lines(e)
    qs = b.segment_ocr(lines, b.START_HINTS.get(e["id"]))
    plan = b.crop_plan(e, qs, sorted({c for c, _, _ in lines}))
    d = ROOT / "work/blind" / str(e["year"])
    d.mkdir(parents=True, exist_ok=True)
    for n, segs in plan.items():
        names = []
        for i, (col, top, bottom) in enumerate(segs):
            if (bottom - top) * H < 60:
                continue
            out = d / f"q{n:02d}_{i + 1}.png"
            jobs.append((pdf, col, top, bottom, W, H, out))
            names.append(str(out))
        manifest[f"{e['id']}-{n:02d}"] = names
    (d / "list.json").write_text(json.dumps({k: v for k, v in manifest.items() if k.startswith(e["id"])}, ensure_ascii=False, indent=0), encoding="utf8")
with ThreadPoolExecutor(6) as ex:
    list(ex.map(crop, jobs))
print("crops", len(jobs))


def ocr(job):
    pdf, p, out = job
    if out.exists():
        return
    with tempfile.TemporaryDirectory() as t:
        png = Path(t) / "p.png"
        subprocess.run(["pdftoppm", "-r", "250", "-gray", "-png", "-singlefile", "-f", str(p), "-l", str(p), str(pdf), str(png.with_suffix(""))], check=True, capture_output=True)
        r = subprocess.run([str(ROOT / "work/ocr"), str(png)], capture_output=True, text=True, check=True)
    out.write_text(r.stdout, encoding="utf8")


jobs = []
for e in exams:
    if e["session"] == 3 or e["kind"] == "hwp":
        continue
    pdf = ROOT / e["path"]
    n = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout)[1])
    d = ROOT / "work/ocr_law" / e["id"]
    d.mkdir(parents=True, exist_ok=True)
    jobs += [(pdf, p, d / f"{p:03d}.tsv") for p in range(1, n + 1)]
with ThreadPoolExecutor(4) as ex:
    list(ex.map(ocr, jobs))
print("law pages", len(jobs))
