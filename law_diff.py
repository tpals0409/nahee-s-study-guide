#!/usr/bin/env python3
"""법 과목: 현재 JSON 과 전 쪽 독립 OCR 을 공백 없이 글자 비교해 불일치 후보를 work/law_diff.json 으로 낸다."""
import difflib, json, re
from pathlib import Path

ROOT = Path(__file__).parent
qs = json.loads((ROOT / "data/questions.json").read_text(encoding="utf8"))["questions"]
HANJA = "甲乙丙丁戊"


def norm(t):
    t = re.sub(r"[①-⑤]", "", t)
    t = t.translate(str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "ㆍ": "·", "・": "·", "•": "·", "․": "·", "〈": "<", "〉": ">", "「": "", "」": "", "（": "(", "）": ")"}))
    return re.sub(r"\s", "", t)


def ocr_text(eid):
    out = []
    for f in sorted((ROOT / ("work/ocr_law/" + eid)).glob("*.tsv")) or sorted((ROOT / ("work/ocr_txt/" + eid)).glob("*.tsv")):
        rows = []
        for l in f.read_text(encoding="utf8").splitlines():
            pos, _, t = l.partition("\t")
            x, y, w, h = map(float, pos.split())
            rows.append((y, x, h, t))
        rows.sort()
        g = []
        for r in rows:
            if g and r[0] - g[-1][0][0] < 0.5 * r[2]:
                g[-1].append(r)
            else:
                g.append([r])
        for grp in g:
            for r in sorted(grp, key=lambda r: r[1]):
                if not re.search(r"변리사\s*1\s*차.*교시|^\S+\s*[A-D]\s*형\s*[-\d]", r[3]):
                    out.append(r[3])
    return norm("".join(out))


res = []
for e in json.loads((ROOT / "work/exams.json").read_text(encoding="utf8")):
    if e["session"] == 3 or e["kind"] == "hwp":
        continue
    items = [q for q in qs if q["id"].startswith(e["id"] + "-")]
    ocr = ocr_text(e["id"])
    sm = difflib.SequenceMatcher(None, autojunk=False)
    sm.set_seq2(ocr)
    for q in items:
        for fld, t in [("stem", q["stem"])] + [(f"choice{i + 1}", c) for i, c in enumerate(q["choices"])]:
            a = norm(t)
            if len(a) < 12:  # 짧은 보기는 위치를 못 잡는다
                continue
            sm.set_seq1(a)
            m = sm.find_longest_match(0, len(a), 0, len(ocr))
            s = max(m.b - m.a, 0)
            seg = ocr[s:s + len(a) + 6]
            s2 = difflib.SequenceMatcher(None, a, seg, autojunk=False)
            if s2.ratio() < 0.75:
                res.append(dict(id=q["id"], field=fld, json=a[:50], ocr=seg[:50], note="low similarity"))
                continue
            for tag, i1, i2, j1, j2 in s2.get_opcodes():
                if tag == "equal" or (i2 >= len(a) and tag == "insert"):
                    continue
                res.append(dict(id=q["id"], field=fld, json=a[max(0, i1 - 10):i2 + 10], ocr=seg[max(0, j1 - 10):j2 + 10], a=a[i1:i2], b=seg[j1:j2]))
(ROOT / "work/law_diff.json").write_text(json.dumps(res, ensure_ascii=False, indent=0), encoding="utf8")
print(len(res))
