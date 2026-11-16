#!/usr/bin/env python3
"""기출 문항과 그 해설을 근거로 OX 문장을 만들어 data/ox/{id}.json 에 쓴다.

python3 gen_ox.py --sample 5          과목별 5문항
python3 gen_ox.py --topic 민법총칙    한 파트
python3 gen_ox.py --all               남은 전체
python3 gen_ox.py --concept [N]       비어 있는 계산·그림 과학 문항을 개념 OX로(N개 표본)

이미 만든 문항은 건너뛰므로 끊겨도 다시 돌리면 이어서 만든다.
OX로 바꿀 진술이 없는 문항(계산·그림 판독)은 빈 배열로 저장해 다시 시도하지 않는다.
멈추려면 touch work/ox.stop.
"""
import argparse, concurrent.futures, json, os, random, subprocess, time
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "data/ox"
EXPLAIN = ROOT / "data/explanations"
QUESTIONS = ROOT / "app/public/questions.json"
STOP = ROOT / "work/ox.stop"
MODEL = "claude-opus-5-5"
BATCH = 5
WORKERS = 8
LIMIT_WAIT = 1800

SYSTEM = """변리사 1차 시험 기출문제를 OX 문제로 바꿉니다. 받은 문제, 공식 정답, 보기별 해설만 근거로 씁니다. 해설에 없는 사실을 지어내지 않습니다.

문장 만들기
- 진술로 된 보기마다 OX 문장을 하나 만듭니다. 조합형("모두 고른 것은?")이면 ㄱ·ㄴ·ㄷ 같은 보기 진술을 쓰고, 번호 보기("ㄱ, ㄴ")는 쓰지 않습니다.
- 문장만 읽어도 판단할 수 있어야 합니다. 사례형이면 판단에 필요한 사실관계를 문장 앞에 짧게 넣습니다. "위 사례에서", "다음 중", "(다툼이 있으면 판례에 따름)" 같은 말은 쓰지 않습니다.
- 각 문장의 참·거짓은 해설로 판정합니다. 보기 해설이 "맞는 설명입니다"면 O, "틀린 설명입니다"면 X입니다. "~이 아닌 것은"처럼 물은 문제도 보기 내용 자체가 참인지로 판정합니다.
- 참인 문장 일부는 해설이 짚은 핵심 요소(기간, 숫자, 주체, 요건, 효과) 하나만 바꿔 거짓 문장으로 만듭니다. 전체에서 O와 X가 비슷하게 섞이게 합니다. 바꾼 경우에도 근거는 해설에 있어야 합니다.
- 물질·항목·수치·그림을 고르는 보기, 계산해야 답이 나오는 문제, 그림을 봐야 하는 진술은 문장을 만들지 않습니다. 만들 것이 없으면 빈 배열입니다.

note
- 정답 근거 한두 문장, 존댓말 '~입니다' 체. X이면 어느 말이 틀렸고 맞는 내용이 무엇인지 씁니다. 조문 번호가 해설에 있으면 밝힙니다.

choice는 근거가 된 보기 번호 1~5, 조합형의 ㄱ·ㄴ·ㄷ 진술이면 0입니다. 받은 id 그대로 문제마다 한 항목씩 돌려줍니다."""

# 계산·그림 문항은 보기가 숫자뿐이라 위 규칙으로는 비어 버린다. 그 문항이 다루는 개념으로 만든다
CONCEPT = SYSTEM + """

이번 문제들은 계산하거나 그림을 읽어야 해서 보기를 그대로 쓸 수 없는 문항입니다. 대신 이 문제를 풀 때 써야 하는 개념으로 OX 문장을 2~4개 만듭니다.
- 쓰는 법칙·공식의 내용, 물리량 사이의 비례 관계, 단위, 적용 조건, 흔한 착각(부호, 방향, 보존되는 양)을 진술합니다. 고등학교~대학 1학년 교과서 수준의 일반 사실만 씁니다.
- 이 문제의 수치나 그림 없이도 참·거짓이 정해져야 합니다. "이 문제에서", "그림에서" 같은 말을 쓰지 않습니다.
- 해설의 핵심 개념·공식과 어긋나지 않게 합니다. 확신할 수 없는 내용은 만들지 않습니다.
- choice는 0입니다."""

# 이미 보기 변형 OX가 있는 문항에 개념·키워드 OX를 더한다
EXTRA = SYSTEM + """

이번에는 보기를 바꾸지 않습니다. 이 문제가 묻는 핵심 개념과 키워드로 새 OX 문장을 2~3개 만듭니다.
- 법 과목: 해설에 나온 조문·판례의 기간, 숫자, 주체, 요건, 효과, 예외, 비슷한 제도와의 차이를 진술합니다. 해설과 조문 인용에 없는 내용은 쓰지 않습니다.
- 과학 과목: 문제를 푸는 데 쓰는 법칙·공식, 비례 관계, 단위, 정의, 흔한 착각을 진술합니다. 교과서 수준의 일반 사실만 씁니다.
- 보기 문장을 거의 그대로 되풀이하지 않습니다. 시험장에서 바로 떠올려야 하는 키워드가 드러나게 짧게 씁니다.
- O와 X를 섞습니다. choice는 0입니다."""

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["items"],
    "properties": {"items": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["id", "statements"],
        "properties": {
            "id": {"type": "string"},
            "statements": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["choice", "text", "answer", "note"],
                "properties": {
                    "choice": {"type": "integer"},
                    "text": {"type": "string"},
                    "answer": {"type": "string", "enum": ["O", "X"]},
                    "note": {"type": "string"},
                },
            }},
        },
    }}},
}


def describe(q, ex):
    choices = "\n".join(f"{i + 1}. {c}\n   해설: {n}" for i, (c, n) in enumerate(zip(q["choices"], ex["choices"])))
    figure = "있음(그림을 봐야 하는 진술은 제외)" if q.get("images") else "없음"
    return (f"[id {q['id']}] {q['year']}년 {q['subject']} {q['topic']}\n문제: {q['stem']}\n그림: {figure}\n보기:\n{choices}\n"
            f"공식 정답: {', '.join(map(str, q['answer']))}번\n요약 해설: {ex['summary']}")


def ask(prompt, system=SYSTEM):
    """구독으로 청구되도록 API 키와 프록시 주소를 뺀다(gen_explanations.py 와 같은 방식)."""
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")}
    cmd = ["claude", "-p", prompt, "--model", MODEL, "--effort", "medium", "--output-format", "json",
           "--json-schema", json.dumps(SCHEMA, ensure_ascii=False), "--system-prompt", system, "--tools", "",
           "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
    done = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=1800)
    lines = done.stdout.strip().splitlines()
    return json.loads(lines[-1]) if lines else {"is_error": True, "result": done.stderr or "빈 응답"}


def valid(s):
    return s["text"].strip() and s["note"].strip() and s["choice"] in range(6) and len(s["text"]) <= 600


def work(batch, explanations, system=SYSTEM):
    if STOP.exists():
        return
    prompt = "\n\n".join(describe(q, explanations[q["id"]]) for q in batch)
    while True:
        started = time.time()
        reply = ask(prompt, system)
        if not reply.get("is_error"):
            break
        text = str(reply.get("result"))
        if "limit" not in text.lower():
            raise RuntimeError(text[:300])
        print(f"사용 한도: {text[:120]} / {LIMIT_WAIT}초 대기", flush=True)
        time.sleep(LIMIT_WAIT)
    made = {i["id"]: i["statements"] for i in reply["structured_output"]["items"]}
    print(f"묶음 {len(batch)}문항 {time.time() - started:.0f}초 OX {sum(map(len, made.values()))}개", flush=True)
    for q in batch:
        if q["id"] not in made:
            print(f"{q['id']} 누락, 다음 실행에서 재시도", flush=True)
            continue
        items = [{"c": s["choice"], "text": s["text"].strip(), "o": s["answer"] == "O", "note": s["note"].strip()} for s in made[q["id"]] if valid(s)]
        path = OUT / f"{q['id']}.json"
        if system is not SYSTEM:
            # 개념 OX는 표시해 두고 기존 문장 뒤에 붙인다. 앱의 OX id(순번)가 바뀌지 않게 한다
            items = [*(json.loads(path.read_text()) if path.exists() else []), *({**s, "c": 0, "kind": "concept"} for s in items)]
        path.write_text(json.dumps(items, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int)
    parser.add_argument("--topic")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--extra", type=int, nargs="?", const=0, help="모든 문항에 개념·키워드 OX를 더한다(숫자는 표본 수)")
    parser.add_argument("--concept", type=int, nargs="?", const=0, help="빈 자연과학 문항을 개념 OX로 다시 만든다(숫자는 표본 수)")
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True)
    questions = json.loads(QUESTIONS.read_text())
    explanations = {p.stem: json.loads(p.read_text()) for p in EXPLAIN.glob("*.json")}
    todo = [q for q in questions if q["id"] in explanations and not (OUT / f"{q['id']}.json").exists()]
    system = SYSTEM
    if args.extra is not None:
        system = EXTRA
        has_concept = lambda items: any(s.get("kind") == "concept" for s in items)
        todo = [q for q in questions if q["id"] in explanations and (OUT / f"{q['id']}.json").exists()
                and (items := json.loads((OUT / f"{q['id']}.json").read_text())) and not has_concept(items)]
        if args.extra:
            todo = random.Random(9).sample(todo, args.extra)
    elif args.concept is not None:
        system = CONCEPT
        todo = [q for q in questions if q["subject"] == "자연과학개론" and q["id"] in explanations
                and (OUT / f"{q['id']}.json").exists() and not json.loads((OUT / f"{q['id']}.json").read_text())]
        if args.concept:
            todo = random.Random(5).sample(todo, args.concept)
    elif args.sample:
        picker = random.Random(7)
        todo = [q for s in sorted({q["subject"] for q in todo}) for q in picker.sample([q for q in todo if q["subject"] == s], args.sample)]
    elif args.topic:
        todo = [q for q in todo if q["topic"] == args.topic]
    elif not args.all:
        parser.error("--sample, --topic, --concept 또는 --all")
    todo.sort(key=lambda q: (q["subject"], q["id"]))
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f"{len(todo)}문항 {len(batches)}묶음", flush=True)
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        for future in concurrent.futures.as_completed([pool.submit(work, b, explanations, system) for b in batches]):
            if future.exception():
                print(f"묶음 실패: {future.exception()}", flush=True)


if __name__ == "__main__":
    main()
