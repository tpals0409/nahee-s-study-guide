#!/usr/bin/env python3
"""구독 로그인된 claude CLI로 해설을 만들어 data/explanations/{id}.json 에 쓴다.

python3 gen_explanations.py --sample 10   과목별 10문항
python3 gen_explanations.py --all         남은 전체

이미 만든 문항은 건너뛰므로 끊겨도 다시 돌리면 이어서 만든다.
멈추려면 touch work/gen.stop. 다시 돌리기 전에 그 파일을 지운다.
"""
import argparse, concurrent.futures, json, os, random, subprocess, time
from pathlib import Path

from law_lookup import changed_since, check_basis

ROOT = Path(__file__).parent
OUT = ROOT / "data/explanations"
QUESTIONS = ROOT / "app/public/questions.json"
EXAM_DATES = ROOT / "data/exam_dates.json"
STOP = ROOT / "work/gen.stop"  # 이 파일을 만들면 진행 중인 묶음만 끝내고 멈춘다
MODEL = "claude-opus-5-5"
BATCH = 5
WORKERS = 8
LIMIT_WAIT = 1800  # 사용 한도에 걸리면 기다렸다가 같은 묶음을 다시 시도

SYSTEM = """당신은 변리사 1차 시험 과외 선생님입니다. 학습자 나희에게 기출문제를 설명합니다.
- 말투는 다정한 존댓말이고 짧게 씁니다.
- 공식 정답을 기준으로 설명합니다.
- 보기는 내용으로 가리키고 번호로 부르지 않습니다. 나희 화면에서는 보기 순서가 섞입니다.
- 그림 파일이 있으면 Read로 먼저 봅니다. 글과 다르면 그림을 따릅니다.

법 과목 근거 규칙
- 조문은 기억으로 쓰지 말고 python3 law_lookup.py 로 시험일 시행본을 찾아 확인합니다. toc(제목 목록), get(본문), find(낱말 검색), treaties, treaty 명령이 있습니다.
- 조문 근거는 kind=article, source=법령명, ref=조문 키(예: 110, 52의2)로 적고, quote에는 도구 출력의 문장을 글자 그대로 8자 이상 복사합니다.
- 조약 근거는 kind=treaty, source=treaties 목록의 이름으로 적습니다.
- 판례가 근거이면 kind=precedent, ref와 quote는 빈 문자열로 적고 해설에 판례 취지를 씁니다. 사건번호와 선고일은 쓰지 않습니다.
- 찾은 조문으로 공식 정답을 설명할 수 없으면 지어내지 말고 lawNote에 밝힙니다.
- 시험 후 개정으로 이 문제의 결론이 실제로 달라지면 lawNote에 씁니다. 부처명이나 용어만 바뀌었으면 빈 문자열입니다.
- 과학 과목은 basis를 빈 배열로 둡니다.

결과는 받은 문제마다 한 항목씩, 받은 id 그대로 돌려줍니다. choices는 받은 보기 순서대로 5개이고 각각 맞거나 틀린 이유를 두세 문장으로 씁니다. basis의 choice는 보기 번호 1~5이고, 문제 전체의 근거는 0입니다."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "additionalProperties": False,
        "required": ["id", "summary", "choices", "lawNote", "basis"],
        "properties": {
            "id": {"type": "string"},
            "summary": {"type": "string"},
            "choices": {"type": "array", "items": {"type": "string"}},
            "lawNote": {"type": "string"},
            "basis": {"type": "array", "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["choice", "kind", "source", "ref", "quote"],
                "properties": {
                    "choice": {"type": "integer"},
                    "kind": {"type": "string", "enum": ["article", "treaty", "precedent"]},
                    "source": {"type": "string"},
                    "ref": {"type": "string"},
                    "quote": {"type": "string"},
                },
            }},
        },
    }}},
}


def describe(q, date, notes=""):
    choices = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(q["choices"]))
    images = [f"data/{Path(p).with_suffix('.png').as_posix()}" for p in q["images"]]
    return (f"[id {q['id']}] {q['year']}년 {q['subject']} {q['topic']} / 시험일 {date}\n문제: {q['stem']}\n보기:\n{choices}\n"
            f"공식 정답: {', '.join(map(str, q['answer']))}번\n그림: {', '.join(images) or '없음'}\n{notes}")


def run_claude(prompt):
    """구독으로 청구되도록 API 키와 프록시 주소를 뺀다."""
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")}
    cmd = ["claude", "-p", prompt, "--model", MODEL, "--effort", "high", "--output-format", "json",
           "--json-schema", json.dumps(SCHEMA, ensure_ascii=False), "--system-prompt", SYSTEM,
           "--tools", "Read,Bash", "--allowedTools", "Read", "Bash(python3 law_lookup.py:*)",
           "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
    done = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=1800)
    lines = done.stdout.strip().splitlines()
    return json.loads(lines[-1]) if lines else {"is_error": True, "result": done.stderr or "빈 응답"}


def problems(item, q, date):
    """고칠 내용 목록. 비어 있으면 저장해도 된다."""
    found = [] if len(item["choices"]) == 5 and all(c.strip() for c in item["choices"]) else ["보기 해설 5개 필요"]
    if not item["summary"].strip():
        found.append("요약 필요")
    found += [p for b in item["basis"] if (p := check_basis(b, date))]
    return found


def finish(item, date):
    """검증된 근거만 남기고 개정 여부를 코드로 붙인다."""
    good = [b for b in item["basis"] if not check_basis(b, date)]
    return {
        "summary": item["summary"],
        "choices": item["choices"],
        "lawNote": item["lawNote"],
        "basis": [{**b, "changed": changed_since(b, date)} for b in good],
        "dropped": len(item["basis"]) - len(good),
    }


def generate(batch, dates, notes=None):
    """한 묶음을 만든다. 결과: {id: 해설}"""
    notes = notes or {}
    prompt = "\n\n".join(describe(q, dates[str(q["year"])], notes.get(q["id"], "")) for q in batch)
    while True:
        started = time.time()
        reply = run_claude(prompt)
        if reply.get("is_error"):
            text = str(reply.get("result"))
            if "limit" in text.lower():
                print(f"사용 한도: {text[:120]} / {LIMIT_WAIT}초 대기", flush=True)
                time.sleep(LIMIT_WAIT)
                continue
            raise RuntimeError(text[:300])
        print(f"묶음 {len(batch)}문항 {time.time() - started:.0f}초 {reply.get('num_turns')}턴", flush=True)
        return {i["id"]: i for i in reply["structured_output"]["items"]}


def work(batch, dates):
    if STOP.exists():
        return
    by_id = {q["id"]: q for q in batch}
    made = generate(batch, dates)
    notes = {}
    for q in batch:
        item = made.get(q["id"])
        found = ["결과 누락"] if not item else problems(item, q, dates[str(q["year"])])
        if found:
            notes[q["id"]] = "이전 답의 문제: " + "; ".join(found) + ". 고쳐서 다시 씁니다."
    if notes:
        made.update(generate([by_id[i] for i in notes], dates, notes))
    for q in batch:
        item = made.get(q["id"])
        date = dates[str(q["year"])]
        if not item or len(item["choices"]) != 5 or not all(c.strip() for c in item["choices"]):
            print(f"{q['id']} 실패, 다음 실행에서 재시도", flush=True)
            continue
        (OUT / f"{q['id']}.json").write_text(json.dumps(finish(item, date), ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int)
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True)
    dates = json.loads(EXAM_DATES.read_text())
    questions = json.loads(QUESTIONS.read_text())
    todo = [q for q in questions if not (OUT / f"{q['id']}.json").exists()]
    if args.sample:
        picker = random.Random(63)
        subjects = sorted({q["subject"] for q in questions})
        todo = [q for s in subjects for q in picker.sample([q for q in todo if q["subject"] == s], args.sample)]
    elif not args.all:
        parser.error("--sample 또는 --all")
    # 같은 과목끼리 묶어 도구 사용을 줄인다
    todo.sort(key=lambda q: (q["subject"], q["id"]))
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f"{len(todo)}문항 {len(batches)}묶음", flush=True)
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        for future in concurrent.futures.as_completed([pool.submit(work, b, dates) for b in batches]):
            if future.exception():
                print(f"묶음 실패: {future.exception()}", flush=True)


if __name__ == "__main__":
    main()
