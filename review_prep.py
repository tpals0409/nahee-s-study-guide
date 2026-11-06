#!/usr/bin/env python3
"""회차별 점검 자료를 work/review/<연도>/ 에 만든다: 그 회차 문항(session별 json)과 원본 쪽 이미지."""
import json, re, subprocess
from pathlib import Path

ROOT = Path(__file__).parent
qs = json.loads((ROOT / "data/questions.json").read_text(encoding="utf8"))["questions"]
exams = json.loads((ROOT / "work/exams.json").read_text(encoding="utf8"))
for e in exams:
    d = ROOT / "work/review" / str(e["year"])
    d.mkdir(parents=True, exist_ok=True)
    items = [dict(id=q["id"], number=q["number"], page=q["source_page"], text_source=q["text_source"], stem=q["stem"], choices=q["choices"], issues=q["issues"])
             for q in qs if q["id"].startswith(e["id"] + "-")]
    (d / f"session{e['session']}.json").write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf8")
    if e["kind"] == "hwp":
        continue
    pdf = ROOT / e["path"]
    wide = float(re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout)[1]) > 700
    if not list(d.glob(f"s{e['session']}-*.png")):
        subprocess.run(["pdftoppm", "-r", "150" if wide else "110", "-gray", "-png", str(pdf), str(d / f"s{e['session']}")], check=True, capture_output=True)
print("ok")
