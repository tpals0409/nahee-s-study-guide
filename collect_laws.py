#!/usr/bin/env python3
"""2008년 이후 시행된 법령 본문을 받아 data/law/{법령}.json 에 조문별 시행 구간으로 쓴다.

법제처 API는 등록된 IP에서만 열리므로 이 스크립트는 Mac에서 돌린다. Worker는 결과 파일만 읽는다.
받은 응답은 work/law/ 에 저장해 다시 돌려도 호출하지 않는다.
"""
import datetime, json, re, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
CACHE = ROOT / "work/law"
OUT = ROOT / "data/law"
LAWS = ("민법", "특허법", "실용신안법", "디자인보호법", "상표법")
# 조약일련번호. 개정문은 본문에 합쳐져 있지 않아 따로 받는다
TREATIES = {
    "파리협약": 368,
    "특허협력조약": 305,
    "특허협력조약 개정 1985": 15491,
    "특허협력조약 제22조 개정": 15397,
    "특허협력조약 제2장 유보 철회": 15461,
    "마드리드의정서": 2174,
    "마드리드의정서 공통규칙 개정": 15393,
    "마드리드의정서 제9조의6 개정": 15345,
    "헤이그협정 제네바개정협정": 8457,
    "부다페스트조약": 245,
    "부다페스트조약 규칙 개정": 15395,
    "로카르노협정": 3855,
    "니스협정": 2221,
    "상표법조약": 2175,
    "싱가포르조약": 12819,
    "TRIPS협정": 7297,
    "TRIPS 개정의정서": 12839,
}
# WTO협정 40만 자 중 이 구간만 쓴다
PARTS = {"TRIPS협정": ("[조약번호]무역관련 지적재산권에 관한 협정", "[조약번호]분쟁해결규칙")}
SINCE = "20080101"
GAP = 1.0  # 법제처 주의사항: 짧은 시간 내 과도한 호출 금지


def as_list(v):
    return v if isinstance(v, list) else [] if v is None else [v]


def flat(v):
    """API가 내용을 문자열이나 중첩 목록으로 준다."""
    return "\n".join(flat(x) for x in v) if isinstance(v, list) else (v or "").strip()


def article_text(unit):
    """조문 머리와 항·호·목을 차례로 잇는다."""
    parts = [flat(unit.get("조문내용"))]
    for hang in as_list(unit.get("항")):
        parts.append(flat(hang.get("항내용")))
        for ho in as_list(hang.get("호")):
            parts.append(flat(ho.get("호내용")))
            parts += [flat(mok.get("목내용")) for mok in as_list(ho.get("목"))]
    return "\n".join(p for p in parts if p)


def article_key(unit):
    branch = unit.get("조문가지번호")
    return f"{int(unit['조문번호'])}의{int(branch)}" if branch else str(int(unit["조문번호"]))


ANNOTATION = re.compile(r"<(?:개정|신설|전문개정|타법개정|본조신설|삭제)[^>]*>|\[(?:본조신설|전문개정|제목개정|종전|시행일|제\d|삭제|조번호|본조)[^\]]*\]")


def squeeze(text):
    """<개정 …> 같은 표시는 새 판마다 붙으므로 본문 비교에서 뺀다."""
    return re.sub(r"\s", "", ANNOTATION.sub("", text))


def in_force(rows, today, since=SINCE):
    """시행일마다 가장 늦게 공포된 판 하나를, since 당시 판부터 today 까지 고른다."""
    latest = {}
    for r in sorted(rows, key=lambda r: (r["시행일자"], r["공포일자"], int(r["법령일련번호"]))):
        if r["시행일자"] <= today:
            latest[r["시행일자"]] = r
    days = sorted(latest)
    first = max((d for d in days if d <= since), default=days[0])
    return [latest[d] for d in days if d >= first]


def intervals(versions):
    """[(시행일, {조문: (제목, 본문)})] 를 조문별 시행 구간으로 합친다. 공백과 개정 표시만 다르면 같은 본문으로 친다."""
    articles = {}
    for day, units in versions:
        for key, (title, text) in units.items():
            spans = articles.setdefault(key, [])
            last = spans[-1] if spans else None
            if last and last["to"] is None and squeeze(last["text"]) == squeeze(text):
                last["title"] = title
                continue
            if last and last["to"] is None:
                last["to"] = day
            spans.append({"from": day, "to": None, "title": title, "text": text})
        for key, spans in articles.items():
            if key not in units and spans[-1]["to"] is None:
                spans[-1]["to"] = day
    return articles


def reverted(articles):
    """A→B→A 로 되돌아간 조문. 공포 순서가 엇갈린 판을 골랐을 때 생기므로 검토 대상이다."""
    bad = []
    for key, spans in articles.items():
        texts = [squeeze(s["text"]) for s in spans]
        if any(texts[i] == texts[i + 2] for i in range(len(texts) - 2)):
            bad.append(key)
    return bad


def oc():
    line = next(l for l in (ROOT / "app/.dev.vars").read_text().splitlines() if l.startswith("LAW_OC="))
    return line.split("=", 1)[1].strip().strip('"')


def fetch(path, key, **params):
    params = {"OC": key, "type": "JSON", **params}
    time.sleep(GAP)
    url = f"https://www.law.go.kr/DRF/{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(3):
        try:
            raw = urllib.request.urlopen(url, timeout=60).read().decode("utf8")
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(5)
    data = json.loads(raw.replace(key, "OC"))  # 응답 속 링크에 인증값이 들어 있다
    if "result" in data:
        raise RuntimeError(data["result"])
    return data


def version_rows(law, key):
    path = CACHE / law / "versions.json"
    if path.exists():
        return json.loads(path.read_text())
    rows, page = [], 1
    while True:
        found = fetch("lawSearch.do", key, target="eflaw", query=law, display=100, page=page, nw="1,2,3")["LawSearch"]
        rows += [r for r in as_list(found.get("law")) if r.get("법령명한글") == law]
        if page * 100 >= int(found["totalCnt"]):
            break
        page += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False))
    return rows


def version_units(law, row, key):
    day, mst = row["시행일자"], row["법령일련번호"]
    path = CACHE / law / f"{day}_{mst}.json"
    if path.exists():
        data = json.loads(path.read_text())
    else:
        data = fetch("lawService.do", key, target="eflaw", MST=mst, efYd=day)
        path.write_text(json.dumps(data, ensure_ascii=False))
    units = as_list(data["법령"]["조문"]["조문단위"])
    return {
        article_key(u): (flat(u.get("조문제목")), article_text(u))
        for u in units
        if u.get("조문여부") == "조문"
    }


def treaty_text(data, part=None):
    """본문은 [조약번호]…[/조약번호][본문]… 꼴의 문자열 하나로 온다. [ 납부 ] 같은 소제목은 남긴다."""
    body = flat(data["MultTrtyService"]["조약내용"]["조약내용"])
    if part:
        start = body.index(part[0])
        body = body[start:body.index(part[1], start)]
    return re.sub(r"\[/?(?:조약번호|전문|본문|부속서|공고문|서명)\]", "\n", body).replace("\t", " ").strip()


def collect_treaties(key):
    """조약은 판이 나뉘지 않아 조문으로 쪼개지 않고 전문을 둔다. ponytail: 긴 조약의 조문 조회가 필요해지면 그때 나눈다."""
    treaties = {}
    for name, number in TREATIES.items():
        path = CACHE / "조약" / f"{number}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            data = json.loads(path.read_text())
        else:
            data = fetch("lawService.do", key, target="trty", ID=number)
            path.write_text(json.dumps(data, ensure_ascii=False))
        info = data["MultTrtyService"]["조약기본정보"]
        treaties[name] = {"id": number, "title": flat(info.get("조약명_한글") or info.get("조약명")), "from": info.get("발효일자"), "text": treaty_text(data, PARTS.get(name))}
        print(f"{name}: {len(treaties[name]['text'])}자", flush=True)
    (OUT / "조약.json").write_text(json.dumps(treaties, ensure_ascii=False))


def main():
    key = oc()
    today = datetime.date.today().strftime("%Y%m%d")
    OUT.mkdir(parents=True, exist_ok=True)
    for law in LAWS:
        rows = in_force(version_rows(law, key), today)
        versions = [(r["시행일자"], version_units(law, r, key)) for r in rows]
        articles = intervals(versions)
        (OUT / f"{law}.json").write_text(json.dumps({
            "law": law,
            "collected": today,
            "versions": [{"from": r["시행일자"], "promulgated": r["공포일자"], "mst": r["법령일련번호"]} for r in rows],
            "articles": articles,
        }, ensure_ascii=False))
        spans = sum(len(s) for s in articles.values())
        print(f"{law}: 판 {len(rows)} 조문 {len(articles)} 구간 {spans} 되돌림 {reverted(articles)}", flush=True)
    collect_treaties(key)


if __name__ == "__main__":
    main()
