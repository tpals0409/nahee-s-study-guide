#!/usr/bin/env python3
"""data/questions.json 을 앱용으로 정리해 app/public/questions.json 에 쓴다. 크롤링이 끝날 때마다 다시 실행한다."""
import json, re, subprocess
from pathlib import Path

ROOT = Path(__file__).parent
FOOTER = re.compile(r"\s*(산업재산권법|민법개론|자연과학개론)\s*[A-D]형.*$", re.S)
MARK = re.compile(r"[①-⑤]")
BLANK_PNG = 1500  # 쪽 끝을 잘라낸 빈 띠는 600바이트 이하, 내용이 있는 그림은 3.7KB 이상
FIGURE = re.compile(r"그림|그래프|도표|회로|구조식|모식도|가계도|표[는와에를이]|\(가\)|자료")


# 유형은 문제 글의 낱말로 고른다. ponytail: 낱말 점수라 일부는 틀릴 수 있음, 정확도가 문제되면 AI 일괄 분류로 교체
IP_TOPICS = {
    "특허법": r"특허|발명|출원공개|심사청구|청구범위",
    "실용신안법": r"실용신안|고안",
    "디자인보호법": r"디자인",
    "상표법": r"상표|지정상품|서비스표|상품분류",
    "조약": r"파리협약|PCT|국제출원|TRIPs|조약",
}
CIVIL_TOPICS = {
    "민법총칙": r"법률행위|의사표시|대리|시효|기간|무효|취소|조건|기한|제한능력|미성년|법인|사단|재단|착오|사기|강박|통정|허위표시|반사회|불공정|추인|종물|주물|권리능력|실종|과실",
    "물권법": r"물권|소유권|점유|저당|유치권|지상권|전세권|지역권|질권|공유|합유|총유|등기|부합|첨부|취득시효|상린|명인방법|담보",
    "채권총론": r"채무불이행|채권의 양도|이행지체|이행불능|수령지체|손해배상액|채권자대위|채권자취소|사해행위|연대|보증|변제|상계|경개|면제|혼동|공탁|채권양도|채무인수|이행인수|불가분|다수당사자|대물변제|이자",
    "채권각론": r"계약|매매|임대차|전대|도급|위임|증여|교환|소비대차|사용대차|고용|여행|현상광고|임치|조합|화해|불법행위|부당이득|사무관리|해제|해지|담보책임|위험부담|동시이행|사용자책임|공작물",
}
SCIENCE_TOPICS = ("물리", "화학", "생물", "지구과학")  # 시험지는 10문제씩 이 순서
BLOCKING = {"stem_empty", "choices_incomplete", "figures_not_available"}  # review_unsure, choice_is_figure 는 참고 표시라 출제 가능
UNANSWERABLE = {"2015-3-12"}  # 원본 인쇄에서 구조식이 비어 있음


def score(patterns, stem, body):
    """발문의 낱말을 보기보다 크게 친다."""
    points = {k: 3 * len(re.findall(p, stem)) + len(re.findall(p, body)) for k, p in patterns.items()}
    best = max(points, key=points.get)
    return best if points[best] else "기타"


def topic(subject, number, stem, choices):
    if subject == "자연과학개론":
        return SCIENCE_TOPICS[min((number - 1) // 10, 3)]
    return score(IP_TOPICS if subject == "산업재산권법" else CIVIL_TOPICS, stem, " ".join(choices))


def app_images(q):
    """자연과학 문항의 원본 그림만 앱에 싣는다. 법 과목은 글자로 다 옮겨져 있다."""
    if q["subject"] != "자연과학개론":
        return []
    return [p for p in q.get("images", []) if (ROOT / "data" / p).stat().st_size > BLANK_PNG]


def to_webp(path):
    """무손실이라 글자가 뭉개지지 않고 크기는 절반 아래로 준다."""
    dest = ROOT / "app/public" / Path(path).with_suffix(".webp")
    if not dest.exists():
        subprocess.run(["cwebp", "-quiet", "-lossless", "-z", "6", str(ROOT / "data" / path), "-o", str(dest)], check=True)
    return Path(path).with_suffix(".webp").as_posix()


def clean(q):
    """출제할 수 없으면 None."""
    if BLOCKING & set(q["issues"]) or q["id"] in UNANSWERABLE or len(q["choices"]) != 5 or not q["stem"].strip():
        return None
    stem, choices = q["stem"], [FOOTER.sub("", c).strip() for c in q["choices"]]
    # 발문이 첫 보기에 붙어 뽑힌 문제: "…\n① 10 400"
    head, sep, tail = choices[0].rpartition("\n①")
    if sep:
        stem, choices[0] = f"{stem}\n{head}", tail.strip()
    if not all(choices):
        return None
    # 보기가 서로를 가리키거나 숫자 순서에 뜻이 있으면 섞지 않는다
    # 원본 그림에 보기 번호가 찍혀 있어서 그림이 있으면 섞지 않는다
    images = app_images(q)
    fixed = bool(images or MARK.search(stem + "".join(choices))) or all(re.match(r"\s*\d", c) for c in choices)
    return {k: q[k] for k in ("id", "year", "round", "session", "subject", "number", "answer")} | {
        "stem": stem.strip(), "choices": choices, "fixed": fixed,
        "topic": topic(q["subject"], q["number"], stem, choices),
        "images": images, "figure": bool(images and FIGURE.search(stem + "".join(choices)))}


def main():
    src = json.loads((ROOT / "data/questions.json").read_text(encoding="utf8"))["questions"]
    out = [c for c in map(clean, src) if c]
    (ROOT / "app/public/images").mkdir(exist_ok=True)
    for q in out:
        q["images"] = [to_webp(p) for p in q["images"]]
    (ROOT / "app/public/questions.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    print(f"{len(src)}문항 중 {len(out)}문항 출제 가능, 섞지 않는 문항 {sum(q['fixed'] for q in out)}개, "
          f"그림 {sum(len(q['images']) for q in out)}장, 그림 펼침 {sum(q['figure'] for q in out)}문항")


def check():
    base = {"id": "x", "year": 2020, "round": 1, "session": 1, "subject": "민법개론", "number": 1, "answer": [1], "issues": []}
    a = clean(base | {"stem": "발문", "choices": ["표 내용\n① 10", "20", "30", "40", "50"]})
    assert a["stem"] == "발문\n표 내용" and a["choices"][0] == "10" and a["fixed"]
    b = clean(base | {"stem": "발문", "choices": ["가", "나", "다", "라", "마 민법개론 A형 3-2-[2교시]"]})
    assert b["choices"][4] == "마" and not b["fixed"]
    assert topic("자연과학개론", 21, "", []) == "생물" and topic("자연과학개론", 40, "", []) == "지구과학"
    assert topic("민법개론", 1, "표현대리에 관한 설명", ["가"]) == "민법총칙"
    assert topic("민법개론", 1, "저당권에 관한 설명", ["가"]) == "물권법"
    assert topic("산업재산권법", 1, "상표법상 상표에 관한 설명", ["특허"]) == "상표법"
    sample = next(q for q in json.loads((ROOT / "data/questions.json").read_text(encoding="utf8"))["questions"] if q["id"] == "2009-3-06")
    c = clean(sample)
    assert c["images"] == ["images/2009-3-06_1.png"] and c["fixed"] and c["figure"]  # 빈 띠 _2 는 빠진다
    assert clean(base | {"subject": "산업재산권법", "stem": "발문", "choices": list("가나다라마"), "images": ["images/없음.png"]})["images"] == []
    assert clean(base | {"issues": ["stem_empty"], "stem": "x", "choices": list("가나다라마")}) is None
    assert clean(base | {"issues": ["review_unsure"], "stem": "x", "choices": list("가나다라마")})


if __name__ == "__main__":
    check()
    main()
