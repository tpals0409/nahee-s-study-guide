#!/usr/bin/env python3
"""자연과학개론: 현재 값과 블라인드 재판독을 표기 차이를 지우고 비교해 work/sci_diff.json 으로 낸다."""
import difflib, json, re, sys, unicodedata
from pathlib import Path

ROOT = Path(__file__).parent
OUTNAME = sys.argv[1] if len(sys.argv) > 1 else "out.json"
qs = {q["id"]: q for q in json.loads((ROOT / "data/questions.json").read_text(encoding="utf8"))["questions"]}
SUP = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋", "0123456789+-0123456789+-")


def norm(t):
    t = unicodedata.normalize("NFKC", t).translate(SUP)
    t = t.replace("−", "-").replace("–", "-").replace("·", "").replace("×", "x").replace("\\", "")
    t = re.sub(r"\((?:구조식 )?그림[^)]*\)|\[표\]|\[그림[^\]]*\]", "", t)
    return re.sub(r"[\s|_^(){}\[\]<>,.:;'\"`]", "", t)


out, n, same = [], 0, 0
for f in sorted((ROOT / "work/blind").glob("*/" + OUTNAME)):
    y = f.parent.name
    b = json.loads(f.read_text(encoding="utf8"))
    bad = [k for k in b if not k.startswith(y + "-3-")]
    if bad or len(b) != 40 or any(len(v.get("choices", [])) != 5 for v in b.values()):
        print("id 문제", y, len(b), bad[:3])
    for k, v in sorted(b.items()):
        q = qs[k]
        pairs = [("stem", q["stem"], v["stem"])] + [(f"choice{i + 1}", q["choices"][i], v["choices"][i] if i < len(v["choices"]) else "") for i in range(5)]
        for fld, a, c in pairs:
            n += 1
            x, z = norm(a), norm(c)
            if x == z:
                same += 1
                continue
            sm = difflib.SequenceMatcher(None, x, z, autojunk=False)
            ops = [(x[i1:i2], z[j1:j2]) for t, i1, i2, j1, j2 in sm.get_opcodes() if t != "equal"]
            out.append(dict(id=k, field=fld, cur=a, blind=c, ratio=round(sm.ratio(), 3), ops=ops[:12]))
(ROOT / "work" / ("sci_diff_" + OUTNAME)).write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf8")
print(n, same, len(out))
