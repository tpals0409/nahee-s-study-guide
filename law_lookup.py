#!/usr/bin/env python3
"""시험 당시 조문과 조약을 찾는다. 해설 생성 중 AI가 부르는 도구이자 인용 검증의 기준이다.

python3 law_lookup.py toc 민법 20130223            조문 제목 목록
python3 law_lookup.py get 민법 20130223 110 52의2  조문 본문
python3 law_lookup.py find 상표법 20130223 낱말    본문에 낱말이 있는 조문
python3 law_lookup.py treaties                     조약 이름
python3 law_lookup.py treaty 파리협약 낱말         조약 본문에서 낱말 앞뒤
"""
import functools, json, sys
from pathlib import Path

from collect_laws import LAWS, squeeze

ROOT = Path(__file__).parent


@functools.cache
def articles(law):
    return json.loads((ROOT / f"data/law/{law}.json").read_text())["articles"]


@functools.cache
def treaties():
    return json.loads((ROOT / "data/law/조약.json").read_text())


def at(law, key, date):
    """그날 시행 중이던 구간. 없으면 None."""
    return next((s for s in articles(law).get(key, []) if s["from"] <= date and (s["to"] is None or date < s["to"])), None)


def in_force(law, date):
    return {k: s for k in articles(law) if (s := at(law, k, date))}


def number(key):
    main, _, branch = key.partition("의")
    return int(main), int(branch or 0)


def quote_ok(quote, text):
    return len(squeeze(quote)) >= 8 and squeeze(quote) in squeeze(text)


def check_basis(b, date):
    """이 근거가 받은 본문과 맞으면 None, 아니면 고칠 내용."""
    if b["kind"] == "article":
        if b["source"] not in LAWS:
            return f"{b['source']}은 법령 자료에 없음"
        span = at(b["source"], b["ref"], date)
        if not span:
            return f"{b['source']} 제{b['ref']}조는 {date}에 없음"
        return None if quote_ok(b["quote"], span["text"]) else f"{b['source']} 제{b['ref']}조 인용문이 본문과 다름"
    if b["kind"] == "treaty":
        if b["source"] not in treaties():
            return f"{b['source']}은 조약 자료에 없음"
        return None if quote_ok(b["quote"], treaties()[b["source"]]["text"]) else f"{b['source']} 인용문이 본문과 다름"
    return None


def changed_since(b, date):
    """시험 당시 조문이 현행과 다른가."""
    if b["kind"] != "article" or b["source"] not in LAWS:
        return False
    then = at(b["source"], b["ref"], date)
    now = articles(b["source"]).get(b["ref"], [{}])[-1]
    return bool(then) and (now.get("to") is not None or squeeze(then["text"]) != squeeze(now["text"]))


def main(cmd, *args):
    if cmd == "toc":
        for key, s in sorted(in_force(args[0], args[1]).items(), key=lambda kv: number(kv[0])):
            print(f"{key} {s['title']}")
    elif cmd == "get":
        for key in args[2:]:
            s = at(args[0], key, args[1])
            print(f"[{args[0]} 제{key}조 {args[1]} 시행본]\n{s['text'] if s else '없음'}\n")
    elif cmd == "find":
        word = squeeze(args[2])
        for key, s in sorted(in_force(args[0], args[1]).items(), key=lambda kv: number(kv[0])):
            if word in squeeze(s["text"]):
                print(f"{key} {s['title']}")
    elif cmd == "treaties":
        print("\n".join(treaties()))
    elif cmd == "treaty":
        text, word, start = treaties()[args[0]]["text"], args[1], 0
        for _ in range(8):
            start = text.find(word, start)
            if start < 0:
                break
            print(f"…{text[max(0, start - 300):start + 900]}…\n")
            start += 900
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(*sys.argv[1:])
