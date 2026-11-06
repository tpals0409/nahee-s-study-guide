"""파서 규칙과 생성된 data/questions.json 의 불변식을 검사한다.  python3 test_build.py"""
import json, re
from pathlib import Path
import build_json as b

assert b.split_choices("발문\n① 가 ② 나\n④ 라 ⑤ 마\n③ 다")[1] == ["가", "나", "다", "라", "마"]
assert [q["number"] for q in b.segment([("001", 0, "1. 2024. 2. 1. 甲은?"), ("001", 0, "① 가"), ("001", 0, "⑤ 마"), ("001", 0, "2. 2022. 1. 乙은?")], True)] == [1, 2]
assert b.repair(["7. 가", "L. 나", "1 보기", "② 둘"]) == ["ㄱ. 가", "ㄴ. 나", "① 보기", "② 둘"]
assert b.fix_names("F이 Z을", ["甲", "乙"]) == "甲이 乙을"
assert b.fix_names("F이 Z을", ["甲"]).endswith(b.UNSURE)  # 개수가 다르면 고치지 않고 표시

data = Path(__file__).parent / "data"
qs = json.loads((data / "questions.json").read_text(encoding="utf8"))["questions"]
assert len(qs) == 57 * 40 and len({q["id"] for q in qs}) == len(qs)
assert all(q["answer"] and set(q["answer"]) <= {1, 2, 3, 4, 5} for q in qs)
assert all(len(q["choices"]) == 5 and all(q["choices"]) and q["stem"] for q in qs)
assert not [c for q in qs for c in q["choices"] if len(c) < 30 and re.search(r"[ㄱ-ㅁ]", c) and re.search(r"(?<![0-9.])[27L](?![0-9.가-힣])|[르느드]", c)]  # 보기 기호 오독(ㄹ→2, ㄱ→7, ㄴ→L)
assert all((data / i).exists() for q in qs for i in q["images"])
assert all(q["images"] for q in qs if q["text_source"] in ("ocr", "transcribed"))
assert not [q["id"] for q in qs if q["session"] != 3 and (set(q["issues"]) - {"review_unsure"} or q["text_source"] == "ocr")]  # 법 과목에 OCR 글자가 남으면 안 됨
assert not [c for q in qs for c in q["choices"] if len(c) < 30 and re.search(r"[ㄱ-ㅂ],[ㄱ-ㅂ]", c)]
assert all((data / i).exists() for q in qs if q["id"].startswith("2008-3-") for i in q["images"])
print("ok")
