#!/usr/bin/env python3
"""A형 문제지를 골라 work/exams.json 을 만들고, 텍스트층이 없는 PDF와 3교시를 macOS Vision 으로 OCR 해 work/ocr_txt/ 에 캐시한다.

    swiftc -O tools/ocr.swift -o work/ocr && python3 ocr_stage.py
"""
import json, os, re, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).parent
WORK = ROOT / "work"
SUBJECT = {1: "산업재산권법", 2: "민법개론", 3: "자연과학개론"}
IMAGE_YEARS = {2009, 2010, 2020, 2022, 2025}  # 텍스트층이 없는 해


def session_of(name):
    if re.search(r"1교시|산업재산", name): return 1
    if re.search(r"2교시|민법", name): return 2
    if re.search(r"3교시|자연과학", name): return 3


def pick_exams():
    exams = []
    for f in sorted((ROOT / "raw_x/문제").glob("*/*")):
        if f.suffix.lower() not in (".pdf", ".hwp") or re.search(r"[BbCcDd]\s*형", f.name):
            continue
        year, s = int(f.parent.name[:4]), session_of(f.name)
        kind = "hwp" if f.suffix.lower() == ".hwp" else "ocr" if year in IMAGE_YEARS or s == 3 else "pdf"
        exams.append(dict(id=f"{year}-{s}", year=year, session=s, subject=SUBJECT[s], path=str(f.relative_to(ROOT)), kind=kind))
    return sorted(exams, key=lambda e: e["id"])


def pages(pdf):
    info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    w, h = map(float, re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", info).groups())
    return int(re.search(r"Pages:\s+(\d+)", info)[1]), w > h


def ocr_page(job):
    pdf, page, half, W, out, langs = job
    if out.exists():
        return
    with tempfile.TemporaryDirectory() as t:
        png = Path(t) / "p.png"
        cmd = ["pdftoppm", "-r", "200", "-gray", "-png", "-singlefile", "-f", str(page), "-l", str(page)]
        if half is not None:  # 가로 2단 편집면: 좌우를 따로 OCR
            cmd += ["-x", str(half * W // 2), "-y", "0", "-W", str(W // 2), "-H", "99999"]
        subprocess.run(cmd + [str(pdf), str(png.with_suffix(""))], check=True, capture_output=True)
        res = subprocess.run([str(WORK / "ocr"), str(png)], capture_output=True, text=True, check=True, env={**os.environ, "OCR_LANGS": langs})
    out.write_text(res.stdout, encoding="utf8")


def main():
    exams = pick_exams()
    (WORK / "exams.json").write_text(json.dumps(exams, ensure_ascii=False, indent=1), encoding="utf8")
    jobs = []
    for e in exams:
        if e["kind"] != "ocr":
            continue
        pdf = ROOT / e["path"]
        n, wide = pages(pdf)
        d = WORK / "ocr_txt" / e["id"]
        z = WORK / "ocr_zh" / e["id"]  # 법 과목 한자(甲乙丙丁)는 중국어 모델로 따로 읽는다
        d.mkdir(parents=True, exist_ok=True)
        z.mkdir(parents=True, exist_ok=True)
        for p in range(1, n + 1):
            for half in ((0, 1) if wide else (None,)):
                name = f"{p:03d}{'' if half is None else 'LR'[half]}.tsv"
                jobs.append((pdf, p, half, round(841.68 / 72 * 200), d / name, "ko-KR,en-US"))
                if e["session"] != 3:
                    jobs.append((pdf, p, half, round(841.68 / 72 * 200), z / name, "zh-Hans"))
    print(len(exams), "exams", len(jobs), "pages", flush=True)
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(ocr_page, jobs))
    print("done")


if __name__ == "__main__":
    main()
