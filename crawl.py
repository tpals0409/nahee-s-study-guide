#!/usr/bin/env python3
"""Q-Net 변리사 1차시험 문제지·최종정답 첨부파일 수집기 (표준 라이브러리만 사용).

    python3 crawl.py          # raw/ 아래로 내려받고 manifest.json 기록, 받은 파일은 건너뜀

자료 출처: 한국산업인력공단 Q-Net. 공공누리 1유형(출처표시) 표시 게시물 포함.
"""
import hashlib, html, json, re, time, urllib.parse, urllib.request, http.cookiejar
from pathlib import Path

BASE = "https://www.q-net.or.kr/"
OUT = Path(__file__).parent / "raw"
DELAY = 1.0  # 요청 간격(초), 공공 사이트라 천천히
BOARDS = (("문제", "1008", "cst00309"), ("정답", "1206", "cst00310"))

opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
opener.addheaders = [("User-Agent", "Mozilla/5.0"), ("Referer", BASE + "cst003.do?id=cst00309&gSite=L&gId=51")]


def fetch(path, data=None):
    """일시적인 연결 거부가 실제로 있어서 3번까지 재시도."""
    for attempt in range(3):
        try:
            time.sleep(DELAY)
            with opener.open(BASE + path, data, timeout=60) as r:
                return r.read()
        except OSError:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))


def parse_rows(s):
    return [(m[1], re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", m[2])).strip(), m[3])
            for m in re.finditer(r"goNext\('(\d+)',\s*'\d+',\s*'\w'\)[^>]*>(.*?)</a>.*?(\d{4}\.\d{2}\.\d{2})", s, re.S)]


def parse_files(s):
    """상세 페이지의 fileDown('경로', '파일명', '번호') 호출을 뽑는다."""
    return [tuple(html.unescape(g) for g in m.groups())
            for m in re.finditer(r"fileDown\('([^']*)',\s*'(.*?)',\s*'(\d+)'\)", s)]


def is_first_exam(title):
    return re.search(r"1\s*차", title) is not None


def safe_name(name):
    return re.sub(r'[/\\:*?"<>|]', "_", name).strip(" .") or "file"


def list_board(code):
    rows, page, last = [], 1, 1
    while page <= last:
        q = urllib.parse.urlencode(dict(id="cst00301s01", gSite="L", gId="51", gName="변리사", page=page,
                                        schText="", schType="A", boardId="Q004", code=code))
        s = fetch("cst003.do?" + q).decode("utf8", "replace")
        rows += parse_rows(s)
        last = max([last] + [int(n) for n in re.findall(r"goPage\((\d+)\)", s)])
        page += 1
    return rows


def main():
    manifest, empty = [], []
    for label, code, menu in BOARDS:
        rows = [r for r in list_board(code) if is_first_exam(r[1])]
        print(f"[{label}] 1차 게시물 {len(rows)}건", flush=True)
        for seq, title, date in rows:
            body = urllib.parse.urlencode(dict(page=1, schType="A", schText="", artlSeq=seq, boardId="Q004",
                                               code=code, menuType=menu, cst="Y")).encode()
            s = fetch("cst003.do?id=cst00302&gSite=L&gId=51", body).decode("utf8", "replace")
            files = parse_files(s)
            if not files:
                empty.append((label, seq, title))
            year = (re.search(r"(20\d\d)", title) or [None, date[:4]])[1]
            for path, name, fseq in files:
                dest = OUT / label / f"{year}_{seq}" / safe_name(name)
                if not dest.exists():
                    q = urllib.parse.urlencode(dict(id="cst00302s01", gSite="L", gId="51", fileCode="R001", filePath=path,
                                                    fileName=name, fileSeq=fseq, artlSeq=seq, href=0))
                    data = fetch("cst003.do?" + q)
                    if data[:200].lstrip().lower().startswith((b"<!doctype", b"<html", b"<script")):
                        print("  ! 파일 대신 HTML 응답:", title, name, flush=True)
                        empty.append((label, seq, title + " / " + name))
                        continue
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                    print("  +", dest.relative_to(OUT), len(data), flush=True)
                manifest.append(dict(kind=label, year=year, artlSeq=seq, title=title, posted=date, file=str(dest.relative_to(OUT)),
                                     bytes=dest.stat().st_size, sha256=hashlib.sha256(dest.read_bytes()).hexdigest()))
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf8")
    print(f"완료: 파일 {len(manifest)}개, 첨부 없음/실패 {len(empty)}건")
    for e in empty:
        print("  -", *e)


if __name__ == "__main__":
    main()
