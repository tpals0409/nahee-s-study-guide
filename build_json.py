#!/usr/bin/env python3
"""A형 문제지 57개와 정답을 합쳐 data/questions.json 을 만든다. 먼저 extract.py, ocr_stage.py 를 실행해 둘 것.

    python3 build_json.py [--no-images]
"""
import json, re, subprocess, sys
from pathlib import Path

import hwp

ROOT = Path(__file__).parent
WORK, DATA = ROOT / "work", ROOT / "data"
MARK = "①②③④⑤"
VOCAB = set()  # 텍스트 PDF 줄 안쪽과 HWP 문단에서 모은 어절. ponytail: 말뭉치 기준이라 드문 낱말은 틀릴 수 있음, 형태소 분석기로 교체 가능
NOISE = [re.compile(p) for p in (
    r"변리사\s*1\s*차.*교시", r"^\d{4}\s*[-–].*형\s*-?$", r"^\(?\s*\d+\s*[-–—~]\s*\d+\s*\)?$", r"^[-–—]\s*\d+\s*[-–—)]*$",
    r"^[A-D]\s*형$", r"^\d{1,2}$(?<!\.)", r"^\S+\s*[A-D]\s*형\s*[-\d]",
)]


HANJA = "甲乙丙丁戊"
JOSA = r"(?:은|는|이|가|을|를|의|에게|에|과|와|도|로|으로|만|,|·|\)|\s|$)"
NAME_TOKEN = re.compile(rf"(?<![A-Za-z0-9가-힣])(?:[{HANJA}FZJT뿌뚜뛰])(?={JOSA})")
NAME_GAP = re.compile(r"(?:(?<=\s)|^)(?=(?:은|는|을|를|의|에게|과|와)\s)")
UNSURE = "\ue000"  # 이름 한자를 확정하지 못한 줄 표시


def fix_names(t, hanja):
    """오독 글자 수와 중국어 OCR 한자 수가 정확히 같을 때만 순서대로 바꾼다. 빠진 자리를 추정하면 사람이 뒤바뀌므로(甲↔乙) 그때는 고치지 않고 표시만 한다."""
    toks = list(NAME_TOKEN.finditer(t))
    if hanja and len(toks) == len(hanja):
        for m, h in zip(reversed(toks), reversed(hanja)):
            t = t[:m.start()] + h + t[m.end():]
        return t
    if hanja or NAME_GAP.search(t) or re.search(r"(?<![A-Za-z0-9가-힣])[FZJT뿌뚜뛰](?=(?:은|는|이|가|을|를|의|에게|과|와))", t):
        return t + UNSURE
    return t


def fix_ocr(t):
    """Vision 이 흔히 틀리는 글자를 되돌린다."""
    t = re.sub(r"^[(\[{]\s*([①-⑤])", r"\1", t)
    return t


def read_tsv(f):
    if not f.exists():
        return []
    rows = []
    for l in f.read_text(encoding="utf8").splitlines():
        pos, _, text = l.partition("\t")
        x, y, w, h = map(float, pos.split())
        rows.append((y, x, h, text.strip()))
    return rows


def line_hanja(row, zh_rows):
    """한국어 줄과 높이가 겹치는 중국어 줄들의 한자를 왼쪽부터."""
    y, _, h, _ = row
    hits = [z for z in zh_rows if min(y + h, z[0] + z[2]) - max(y, z[0]) > 0.5 * min(h, z[2])]
    return [c for z in sorted(hits, key=lambda z: z[1]) for c in z[3] if c in HANJA]


def ocr_lines(exam):
    """(column, y, 글) 순서대로. column 은 (page, half) 파일 이름."""
    out = []
    for f in sorted((WORK / "ocr_txt" / exam["id"]).glob("*.tsv")):
        rows = sorted(read_tsv(f))
        zh = read_tsv(WORK / "ocr_zh" / exam["id"] / f.name)
        groups = []  # 같은 높이의 글상자는 왼쪽부터
        for r in rows:
            if groups and r[0] - groups[-1][0][0] < 0.5 * r[2]:
                groups[-1].append(r)
            else:
                groups.append([r])
        for g in groups:
            for r in sorted(g, key=lambda r: r[1]):
                t = r[3]
                if exam["session"] != 3:
                    t = fix_names(t, line_hanja(r, zh))
                out.append((f.stem, r[0], fix_ocr(t)))
    return out


def pdf_lines(exam):
    pdf = ROOT / exam["path"]
    n = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout)[1])
    out = []
    for p in range(1, n + 1):
        t = subprocess.run(["pdftotext", "-layout", "-f", str(p), "-l", str(p), str(pdf), "-"], capture_output=True).stdout.decode("utf8", "replace")
        out += [(f"{p:03d}", 0.0, re.sub(r"\s{2,}", "  ", l.strip())) for l in t.splitlines() if l.strip()]
    return out


def hwp_lines(exam):
    return [("001", 0.0, l.strip()) for p in hwp.paragraphs(ROOT / exam["path"]) for l in p.splitlines() if l.strip()]


def is_noise(t):
    return any(p.search(t) for p in NOISE)


def drop_cover(lines):
    """유의사항만 있는 표지 쪽을 뺀다(번호 목록이 문항으로 잡히는 것 방지)."""
    cols = {}
    for c, _, t in lines:
        cols.setdefault(c, []).append(t)
    cover = {c for c, ts in cols.items() if re.search(r"답안카드|유의사항|한국산업인력공단|Human Resources", " ".join(ts)) and not re.search("[①-⑤]", " ".join(ts))}
    return [l for l in lines if l[0] not in cover]


def segment(lines, strict):
    """줄 목록을 문항별로 나눈다. 번호가 기대값과 같고 앞 문항에 보기가 나온 뒤에만 새 문항으로 본다(날짜 2024. 2. 1. 오인 방지)."""
    qs, cur = [], None
    for col, y, t in drop_cover(lines):
        expected = (cur["number"] + 1) if cur else 1
        body = " ".join(cur["lines"]) if cur else ""
        m = re.match(r"^(\d{1,2})\s*[.,．]\s*(.*)$", t)
        dotless = re.match(r"^(\d{1,2})(?:\s+(.*))?$", t) if "⑤" in body or not cur else None
        m = m or dotless
        new = m and int(m[1]) == expected and (not cur or not strict or re.search("[①-⑤]", body))
        if new:
            rest = m[2] or ""
            first = [rest] if rest else []
            if len(rest) <= 8 and cur and cur["lines"] and re.search(r"\?|것은", cur["lines"][-1]) and not re.match("[①-⑤]", cur["lines"][-1]):
                first = [rest + cur["lines"].pop()]  # 일부 PDF는 발문(의 일부)이 번호보다 윗줄로 나온다
            cur = dict(number=expected, lines=first, col=col, y=y)
            qs.append(cur)
        elif cur and not is_noise(t):
            cur["lines"].append(t)
    return qs


# OCR 이 문항 번호를 아예 못 읽은 문항의 시작 문구 (시험지 id, 번호, 줄 머리)
START_HINTS = {
    "2009-1": {2: "2. 무역관련"},  # 1번 보기의 날짜 줄바꿈 "2. 1.(수)" 가 2번으로 잡히는 것 방지
    "2010-3": {5: "3. 저항이 R인"},
    "2019-3": {1: "그림과 같이 질량이 같은 물체", 2: "그림 (가)는 마찰이 없는", 3: "그림 (가)와 (나)는 수평면에서",
               8: "그림 (가)는 +2방향", 9: "그림과 같이 물체 A, B가 각각", 27: "21. 어떤 유전자의 엑손",
               33: "S3, 판의 경계부", 38: "S8. 지구 대기권"},
    "2023-3": {9: "관측자 A에 대한 관측자 B의"},
}


def segment_ocr(lines, hints=None):
    """OCR 은 번호를 잘못 읽고(5→3) 보기 ㄱ. 을 7. 로 읽는다. 번호가 증가하는 가장 그럴듯한 줄 사슬을 고른다. 번호를 끝내 못 읽은 문항은 START_HINTS 로 지정."""
    lines = [l for l in drop_cover(lines) if not is_noise(l[2]) or re.match(r"^\d{1,2}$", l[2])]
    cand = []
    for i, (col, y, t) in enumerate(lines):
        hit = [n for n, p in (hints or {}).items() if t.startswith(p)]
        if hit:
            cand.append((i, hit[0], 3.0, re.sub(r"^\w{1,2}[.,]\s*", "", t)))
            continue
        m = re.match(r"^(\d{1,2})\s*[.,:．]?(?:\s+(.*))?$", t) or re.match(r"^(\d{1,2})[.,:．](.*)$", t)
        if m and 1 <= int(m[1]) <= 40:
            rest = m[2] or ""
            dotted = re.match(r"^\d{1,2}\s*[.,:．]", t) is not None
            w = 0.2 + (0.8 if dotted else 0) + (1.0 if "?" in rest or len(rest) > 25 else 0)
            cand.append((i, int(m[1]), w, rest))
    best, prev = [c[2] for c in cand], [-1] * len(cand)
    for j in range(len(cand)):
        for k in range(j):
            if cand[k][1] < cand[j][1] and best[k] + cand[j][2] > best[j]:
                best[j], prev[j] = best[k] + cand[j][2], k
    j, chain = max(range(len(cand)), key=best.__getitem__), []
    while j >= 0:
        chain.append(cand[j])
        j = prev[j]
    chain.reverse()
    filled = chain
    qs = []
    for c, nxt in zip(filled, filled[1:] + [(len(lines), 0, 0, "")]):
        col, y, _ = lines[c[0]]
        body = [l[2] for l in lines[c[0] + 1:nxt[0]] if not is_noise(l[2])]
        qs.append(dict(number=c[1], lines=([c[3]] if c[3] else []) + repair(body), col=col, y=y))
    return qs


def repair(body):
    """줄 머리의 오독을 되돌린다: 7./L./2./D. → ㄱ./ㄴ./ㄹ./ㅁ., 빠진 차례의 1·(2)·U → ①②."""
    out, nxt = [], 0
    for t in body:
        t = re.sub(r"^7\s*[.,]\s*", "ㄱ. ", t)
        t = re.sub(r"^L\s*[.,]\s*", "ㄴ. ", t)
        t = re.sub(r"^2\s*[.,]\s*", "ㄹ. ", t)
        t = re.sub(r"^D\s*[.,]\s*", "ㅁ. ", t)
        if nxt < 5:
            m = re.match(r"^[(\[{]?([1-5])[)\]}]?\s+", t)
            if m and int(m[1]) == nxt + 1:
                t = MARK[nxt] + " " + t[m.end():]
            elif nxt == 0 and re.match(r"^[U•O0]\s+", t):
                t = MARK[0] + " " + t[2:].lstrip()
        for i, mk in enumerate(MARK):
            if mk in t:
                nxt = max(nxt, i + 1)
        out.append(t)
    return out


def join(lines, keep_breaks):
    s = ""
    for l in lines:
        if not s:
            s = l
        elif keep_breaks or re.match(r"[①-⑤]|[ㄱ-ㅎ]\s*[.)]|[<〈㉠-㉭]|\(\s*[가-하]\s*\)", l):
            s += "\n" + l
        else:
            a, b = s.split()[-1], l.split()[0]
            glued = re.search(r"[가-힣]$", a) and re.match(r"[가-힣]", b) and (a + b in VOCAB or a not in VOCAB or b not in VOCAB)
            s += ("" if glued else " ") + l
    return s


def unspread(t):
    """양쪽 맞춤으로 벌어진 글자(저 촉 되거나)를 어휘 사전에 있는 어절로 되붙인다."""
    w, out, i = t.split(" "), [], 0
    while i < len(w):
        for n in (4, 3, 2):
            part = w[i:i + n]
            if len(part) == n and any(len(p) == 1 for p in part) and "".join(part) in VOCAB:
                out.append("".join(part))
                i += n
                break
        else:
            out.append(w[i])
            i += 1
    return " ".join(out)


def build_vocab(exams):
    for e in exams:
        if e["kind"] == "hwp":
            VOCAB.update(w for _, _, t in hwp_lines(e) for w in t.split())
        elif e["kind"] == "pdf":
            for _, _, t in pdf_lines(e):
                ws = t.split()
                VOCAB.update(w for w in ws[1:-1] if len(w) >= 2)
    VOCAB.update(w.strip(".,()") for w in list(VOCAB))


def split_choices(text):
    parts = re.split(f"([{MARK}])", text)
    stem, choices, last = parts[0], {}, None
    for mark, body in zip(parts[1::2], parts[2::2]):
        if mark in choices:  # 보기 안에서 다른 보기를 가리키는 경우
            choices[last] += mark + body
        else:
            choices[mark] = body
            last = mark
    return unspread(stem.strip()), [unspread(re.sub(r"[ \t]+", " ", choices.get(m, "")).strip()) for m in MARK]


def parse_answers():
    ans = {}

    def put(key, n, v):
        ans.setdefault(key, {})[n] = [1, 2, 3, 4, 5] if v == "A" else [int(x) for x in re.findall(r"\d", v)]

    for l in (ROOT / "answers_image.txt").read_text(encoding="utf8").splitlines():
        if l and l[0] != "#":
            k, v = l.split(":")
            for i, tok in enumerate(v.split(), 1):
                put(k.strip(), i, tok)
    # 2008 HWP: 번호와 정답이 문단으로 번갈아 나온다
    key = None
    ps = hwp.paragraphs(next((ROOT / "raw_x/정답").glob("2008_*/*.hwp")))
    i = 0
    while i < len(ps):
        m = re.search(r"\((\d)교시\s*:\s*([A-D])형\)", ps[i])
        if m:
            key = f"2008-{m[1]}" if m[2] == "A" else None
        elif key and re.fullmatch(r"\d{1,2}", ps[i]) and i + 1 < len(ps):
            put(key, int(ps[i]), ps[i + 1])
            i += 1
        i += 1
    # 2009, 2014: 텍스트 PDF 표. 2014 는 한 쪽에 표가 좌우로 있어 반씩 읽는다
    for year, glob, boxes in ((2009, "2009_5027196/*.pdf", [None]), (2014, "2014_*/*.pdf", [(0, 421), (421, 421)])):
        pdf = next((ROOT / "raw_x/정답").glob(glob))
        n = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout)[1])
        for p in range(1, n + 1):
            for box in boxes:
                cmd = ["pdftotext", "-layout", "-f", str(p), "-l", str(p)]
                if box:
                    cmd += ["-x", str(box[0]), "-y", "0", "-W", str(box[1]), "-H", "600"]
                t = subprocess.run(cmd + [str(pdf), "-"], capture_output=True).stdout.decode("utf8", "replace")
                key = None
                for l in t.splitlines():
                    m = re.search(r"(\d)교시\s*:\s*([A-D])형", l)
                    if m:
                        key = f"{year}-{m[1]}" if m[2] == "A" else None
                    elif key:
                        m = re.match(r"\s*(\d{1,2})\s{2,}([\d, ]+?)\s{2,}(\d{1,2})\s{2,}([\d, ]+?)\s*$", l)
                        if m:
                            put(key, int(m[1]), m[2])
                            put(key, int(m[3]), m[4])
    return ans


def crop_plan(exam, qs, cols):
    """문항별 (col, top, bottom) 구간. 다음 문항 시작 전까지 자른다."""
    plan = {}
    for i, q in enumerate(qs):
        nxt = qs[i + 1] if i + 1 < len(qs) else None
        a = cols.index(q["col"])
        b = cols.index(nxt["col"]) if nxt else a
        segs = []
        for c in range(a, b + 1):
            top = q["y"] - 0.008 if c == a else 0.05
            bottom = nxt["y"] - 0.004 if nxt and c == b else 0.945
            if bottom - top > 0.02:
                segs.append((cols[c], top, bottom))
        plan[q["number"]] = segs
    return plan


def render(exam, number, segs):
    pdf = ROOT / exam["path"]
    info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    w, h = map(float, re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", info).groups())
    dpi = 130
    W, H = round(w / 72 * dpi), round(h / 72 * dpi)
    names = []
    for i, (col, top, bottom) in enumerate(segs):
        page, half = int(col[:3]), col[3:]
        x, cw = (0, W) if not half else ((0, W // 2) if half == "L" else (W // 2, W // 2))
        name = f"{exam['id']}-{number:02d}" + (f"_{i + 1}" if len(segs) > 1 else "") + ".png"
        names.append("images/" + name)
        out = DATA / "images" / name
        if out.exists():
            continue
        subprocess.run(["pdftoppm", "-r", str(dpi), "-gray", "-png", "-singlefile", "-f", str(page), "-l", str(page),
                        "-x", str(x), "-y", str(round(top * H)), "-W", str(cw), "-H", str(round((bottom - top) * H)),
                        str(pdf), str(out.with_suffix(""))], check=True, capture_output=True)
    return names


def build(images=True):
    exams = json.loads((WORK / "exams.json").read_text(encoding="utf8"))
    answers = parse_answers()
    build_vocab(exams)
    (DATA / "images").mkdir(parents=True, exist_ok=True)
    out = []
    for e in exams:
        lines = {"ocr": ocr_lines, "pdf": pdf_lines, "hwp": hwp_lines}[e["kind"]](e)
        qs = segment_ocr(lines, START_HINTS.get(e["id"])) if e["kind"] == "ocr" else segment(lines, strict=True)
        cols = sorted({c for c, _, _ in lines})
        plan = crop_plan(e, qs, cols) if e["kind"] == "ocr" else {}
        for q in qs:
            text = join(q["lines"], e["kind"] == "hwp")
            stem, choices = split_choices(text.replace(UNSURE, ""))
            n = q["number"]
            issues = ["names_uncertain"] if UNSURE in text else []
            if not stem:
                issues.append("stem_empty")
            if sum(bool(c) for c in choices) < 5:
                issues.append("choices_incomplete")
            if n not in answers.get(e["id"], {}):
                issues.append("answer_missing")
            if e["id"] == "2008-3":
                issues.append("figures_not_available")
            imgs = render(e, n, plan[n]) if images and n in plan else []
            out.append(dict(id=f"{e['id']}-{n:02d}", year=e["year"], round=e["year"] - 1963, session=e["session"], subject=e["subject"],
                            form="A", number=n, stem=stem, choices=choices, answer=answers.get(e["id"], {}).get(n, []),
                            text_source=e["kind"], images=imgs, source_file=e["path"], source_page=int(q["col"][:3]), issues=issues))
    return exams, out


DRAWN_2008 = {"2008-3-06", "2008-3-08", "2008-3-10"}  # 그림이 HWP 도형 객체라 파일로 꺼낼 수 없는 문항


def apply_review(qs):
    """회차별 원본 대조에서 나온 수정(review_fixes.json)을 순서대로 적용한다."""
    review = json.loads((ROOT / "review_fixes.json").read_text(encoding="utf8"))
    by_id = {q["id"]: q for q in qs}
    failed = []
    for f in review["fixes"]:
        q = by_id[f["id"]]
        i = None if f["field"] == "stem" else int(f["field"][-1]) - 1
        cur = q["stem"] if i is None else q["choices"][i]
        if f["before"] == "*":
            new = f["after"]
        elif f["before"] in cur:
            new = cur.replace(f["before"], f["after"], 1)
        else:
            failed.append(f)
            continue
        if i is None:
            q["stem"] = new
        else:
            q["choices"][i] = new
    unsure = {u["id"]: u["note"] for u in review["unsure"]}
    figs = json.loads((ROOT / "figures_2008.json").read_text(encoding="utf8"))  # HWP 안 그림 파일을 꺼낸 것
    for q in qs:
        q["reviewed"] = True
        q["choices"] = [re.sub(r"([ㄱ-ㅂ]),(?=[ㄱ-ㅂ])", r"\1, ", c) if len(c) < 30 else c for c in q["choices"]]
        q["images"] = q["images"] + figs.get(q["id"], [])
        keep = ["figures_not_available"] if q["id"] in DRAWN_2008 else []
        if not q["stem"]:
            keep.append("stem_empty")
        if not all(q["choices"]):
            keep.append("choices_incomplete")
        if any("(그림 보기)" in c for c in q["choices"]):
            keep.append("choice_is_figure")
        if q["id"] in unsure:
            keep.append("review_unsure")
            q["review_note"] = unsure[q["id"]]
        q["issues"] = keep
    if failed:
        print("적용 실패", len(failed), [(f["id"], f["field"], f["before"][:30]) for f in failed[:40]])


def main():
    exams, qs = build("--no-images" not in sys.argv)
    fixed = json.loads((ROOT / "transcribed_law.json").read_text(encoding="utf8"))  # OCR 이 불확실했던 법 과목을 이미지 보고 옮긴 값
    for q in qs:
        if q["id"] in fixed:
            q.update(fixed[q["id"]], text_source="transcribed", issues=[])
    apply_review(qs)
    doc = dict(title="변리사 1차시험 기출문제 (2008~2026, A형)",
               source="한국산업인력공단 Q-Net 기출문제·최종정답 게시판",
               license="2014년 자료부터 공공누리 1유형(출처표시). 2013년 이전 자료는 별도 확인 필요",
               notes={"answer": "최종정답 보기 번호 배열. 복수정답이면 여러 개, 전항 정답이면 [1,2,3,4,5]",
                      "text_source": "pdf/hwp=원문 글자, transcribed=원본 이미지를 보고 옮김, ocr=자동 인식이라 오타가 있을 수 있음",
                      "images": "ocr 문항의 원본 잘라낸 그림(data/ 기준 경로). 그림·복잡한 수식은 이미지가 기준",
                      "reviewed": "회차별로 원본 쪽 이미지와 대조해 고친 문항(2008년은 HWP 텍스트 대조)",
                      "issues": {"choices_incomplete": "보기 글자를 일부 못 뽑음, images 참고",
                                 "choice_is_figure": "보기가 그래프·구조식이라 (그림 보기)로 표기, images 참고",
                                 "review_unsure": "대조에서 확정 못 한 부분이 있음, review_note 참고",
                                 "stem_empty": "발문을 못 뽑음, images 참고",
                                 "figures_not_available": "2008년 3교시: 그림이 HWP 도형이라 이미지가 없거나 일부만 있음, source_file 참고"}},
               questions=qs)
    (DATA / "questions.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf8")
    print(len(qs), "questions")


if __name__ == "__main__":
    main()
