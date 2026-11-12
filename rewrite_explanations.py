#!/usr/bin/env python3
"""구독 로그인된 claude CLI로 data/explanations 의 해설 글을 1차 수험용 구조로 다시 쓴다. 근거·검토 기록은 그대로 둔다.

python3 rewrite_explanations.py --sample 4   과목별 4문항 시험
python3 rewrite_explanations.py --all        남은 전체

다시 쓴 파일에는 "style": "exam" 이 붙어 다음 실행에서 건너뛴다. 부분 해설(review.status=partial)은 손대지 않는다.
멈추려면 touch work/rewrite.stop.
"""
import argparse, concurrent.futures, json, os, random, re, subprocess, time
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "data/explanations"
STOP = ROOT / "work/rewrite.stop"
MODEL = "claude-opus-5-5"
BATCH = 10
WORKERS = 6
LIMIT_WAIT = 1800

SYSTEM = """변리사 1차 기출 해설의 글을 아래 구조로 고쳐 씁니다. 사실은 바꾸지 않습니다.
해설 구조(변리사 1차 객관식 수험용)
- summary는 한 문단 세 문장 안쪽입니다. ① 출제 포인트: 이 문제가 묻는 규칙 한 문장. ② 정답 근거: 정답인 보기를 번호가 아니라 내용으로 가리키며 왜 맞는지 또는 틀린지 한 문장. ③ 암기 포인트: 시험에 그대로 나오는 기준·기간·숫자·예외 한 줄.
- 각 보기 해설은 "맞는 설명입니다." 또는 "틀린 설명입니다."로 시작하고 근거를 한 문장으로 씁니다. 확인된 근거에 조문이 있으면 "제65조 제2항"처럼 번호를 밝힙니다. 틀린 보기는 어느 말이 틀렸는지 짚습니다(예: '출원일'이 아니라 '우선일'입니다). 보기가 진술문이 아니라 물질·항목·수치·그림처럼 고르는 대상이거나 문제가 "~이 아닌 것은", "해당하지 않는 것은"처럼 묻는다면 "정답입니다." 또는 "정답이 아닙니다."로 시작합니다.
- 과학 과목은 ① 핵심 개념·공식 ② 정답 풀이(계산식과 단위 유지) ③ 암기 포인트 순서입니다.
- 보기는 번호로 부르지 않습니다. 화면에서 보기 순서가 섞입니다. 원문이 '정답은 ②'처럼 번호로 적었으면 그 보기의 내용으로 바꿔 씁니다.
- 분량: summary는 230자 안쪽, 보기 해설 하나는 130자 안쪽입니다.

말투
- 인사말, 호칭(나희님 등), 칭찬, 감탄, 추임새, 같은 말 되풀이를 모두 뺍니다. 느낌표를 쓰지 않습니다.
- 존댓말 '~입니다' 체로 씁니다. 짧은 문장에 사실 하나씩, 핵심 결론을 먼저 말하고 이유를 붙입니다.
- 조문 번호·항, 숫자·단위·계산식, 판례 취지, 맞다·틀리다 판단, 미확인·불확실 표시는 글자 그대로 지킵니다. 새 사실이나 새 근거를 더하지 않고, 조문 번호는 원문이나 확인된 근거에 있는 것만 씁니다.
- 독자에게 지시하는 문장(기억하십시오, 보십시오, 주의하세요 등)은 쓰지 않고 사실만 서술합니다.
- lawNote는 내용을 지키고 말만 다듬습니다. 비어 있으면 비워 둡니다.
- 분량은 원문과 비슷하거나 짧게 씁니다.
결과는 받은 id마다 한 항목씩 돌려줍니다. choices는 받은 순서대로 5개입니다."""

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {"items": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["id", "summary", "choices", "lawNote"],
    "properties": {"id": {"type": "string"}, "summary": {"type": "string"}, "choices": {"type": "array", "items": {"type": "string"}}, "lawNote": {"type": "string"}}}}}}

NUM = re.compile(r"제\d+조(?:의\d+)?|제\d+항|\d[\d.,]*\d|\d")
FILLER = re.compile(r"나희|좋은 질문|기억해 ?주세요|!")


def numbers(s):
    return set(NUM.findall(s))


def verdict(s):
    """해설 첫머리의 판단만 본다. "ㄴ은 틀리지만", "FADH₂ 2만 맞습니다" 같은 부분 판단은 None."""
    if re.match(r"\s*(틀린 (설명|조합|지문|내용)(입|이[고며에라])|틀렸|옳지 않은 (설명|조합|지문|내용)(입|이[고며에라]))", s): return "x"
    if re.match(r"\s*((맞는|옳은) (설명|조합|지문|내용)(입|이[고며에라])|맞습니다|맞아요)", s): return "o"
    return None


def answer_mismatch(q, choices):
    """단일 정답·진술형 문제에서 보기 판단이 공식 정답과 어긋나는 번호. 조합형·기타 문형은 검사하지 않는다."""
    stem = q["stem"]
    if len(q["answer"]) != 1 or re.search(r"ㄱ\.|ㄱ,|보기>|모두 고른", stem):
        return []
    picked = re.search(r"아닌 것은|해당하지 않는 것은", stem)
    pol = "x" if re.search(r"옳지 않은 것은|틀린 것은|적절하지 않은 것은", stem) else "o" if re.search(r"옳은 것은|맞는 것은|적절한 것은", stem) else None
    bad = []
    for i, c in enumerate(choices, 1):
        is_answer = i == q["answer"][0]
        if re.match(r"\s*정답입니다", c): ok = is_answer
        elif re.match(r"\s*정답이 아닙니다", c): ok = not is_answer
        elif picked: ok = False  # 고르는 대상 문제는 정답입니다/정답이 아닙니다로 시작
        elif pol and (v := verdict(c)): ok = (v == pol) == is_answer
        else: ok = True
        if not ok: bad.append(i)
    return bad


def problems(orig, new, q=None):
    """고칠 내용 목록. 비어 있으면 저장해도 된다."""
    found = [] if len(new["choices"]) == 5 and all(c.strip() for c in new["choices"]) else ["보기 해설 5개 필요"]
    if not new["summary"].strip():
        found.append("요약 필요")
    before = " ".join([orig["summary"], *orig["choices"], orig.get("lawNote", "")])
    after = " ".join([new["summary"], *new["choices"], new["lawNote"]])
    allowed = numbers(before) | numbers(" ".join(basis_lines(orig)))
    if re.search(r"[①-⑤]|\d번 보기|보기 \d|(?<![형\d])[1-5]번이", after):
        found.append("보기를 ②나 2번 같은 번호로 부르지 말고 그 보기의 내용으로 가리킬 것")
    # "정답은 5번입니다"의 번호는 보기를 내용으로 가리키라는 규칙 때문에 빠지는 것이 맞다
    if lost := numbers(re.sub(r"정답은 [1-5]번", "", before)) - numbers(after):
        found.append("빠진 숫자·조문: " + ", ".join(sorted(lost))[:120])
    if added := numbers(after) - allowed:
        found.append("원문에 없는 숫자·조문: " + ", ".join(sorted(added))[:120])
    if FILLER.search(after):
        found.append("호칭·감탄·느낌표 제거")
    for i, (a, b) in enumerate(zip(orig["choices"], new["choices"])):
        if verdict(a) and verdict(b) and verdict(a) != verdict(b):
            found.append(f"{i + 1}번 보기의 맞다·틀리다 판단이 바뀜")
    if len(after) > len(before) * 1.3:
        found.append("원문보다 길어짐")
    if q and (wrong := set(answer_mismatch(q, new["choices"])) - set(answer_mismatch(q, orig["choices"]) if not re.search(r"아닌 것은|해당하지 않는 것은", q["stem"]) else [])):
        found.append(f"공식 정답({q['answer'][0]}번)과 어긋나는 보기 판단: " + ", ".join(f"{i}번" for i in sorted(wrong)) + ". 고르는 대상 문제는 '정답입니다.' 또는 '정답이 아닙니다.'로 시작")
    if orig.get("lawNote", "").strip() and not new["lawNote"].strip():
        found.append("lawNote 비우지 말 것")
    return found


def basis_lines(e):
    return [f"{'문제 전체' if b.get('choice') == 0 else str(b.get('choice')) + '번 보기'}: {b.get('source', '')}{' 제' + b['ref'] + '조' if b.get('kind') == 'article' and b.get('ref') else ''} {b.get('quote', '')[:120]}".strip() for b in e.get("basis", [])]


def describe(q, e, note=""):
    choices = "\n".join(f"{i + 1}. {c[:160]}" for i, c in enumerate(q["choices"]))
    notes = "\n".join(f"{i + 1}) {c}" for i, c in enumerate(e["choices"]))
    basis = "\n".join(basis_lines(e)) or "없음"
    return (f"[id {q['id']}] {q['year']}년 {q['subject']} {q.get('topic', '')} / 공식 정답: {', '.join(map(str, q['answer']))}번\n문제: {q['stem'][:400]}\n보기:\n{choices}\n"
            f"원문 요약: {e['summary']}\n원문 보기 해설:\n{notes}\n원문 lawNote: {e.get('lawNote', '')}\n확인된 근거:\n{basis}\n{note}")


def run_claude(prompt):
    """구독으로 청구되고 바깥 Claude Code 세션과 섞이지 않도록 관련 환경 변수를 뺀다."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
    cmd = ["claude", "-p", prompt, "--model", MODEL, "--effort", "medium", "--output-format", "json",
           "--json-schema", json.dumps(SCHEMA, ensure_ascii=False), "--system-prompt", SYSTEM,
           "--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
    done = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    lines = done.stdout.strip().splitlines()
    return json.loads(lines[-1]) if lines else {"is_error": True, "result": done.stderr or "빈 응답"}


def generate(batch, notes=None):
    notes = notes or {}
    prompt = "\n\n".join(describe(q, e, notes.get(q["id"], "")) for q, e in batch)
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
        print(f"묶음 {len(batch)}문항 {time.time() - started:.0f}초", flush=True)
        return {i["id"]: i for i in reply["structured_output"]["items"]}


def work(batch):
    if STOP.exists():
        return 0
    made = generate(batch)
    notes = {}
    for q, e in batch:
        item = made.get(q["id"])
        found = ["결과 누락"] if not item else problems(e, item, q)
        if found:
            notes[q["id"]] = "이전 답의 문제: " + "; ".join(found) + ". 고쳐서 다시 씁니다."
    if notes:
        made.update(generate([(q, e) for q, e in batch if q["id"] in notes], notes))
    saved = 0
    for q, e in batch:
        item = made.get(q["id"])
        if not item or problems(e, item, q):
            print(f"{q['id']} 원문 유지: {'; '.join(problems(e, item, q)) if item else '결과 누락'}", flush=True)
            if item:
                with open(ROOT / "work/rejected.jsonl", "a") as f: f.write(json.dumps(item, ensure_ascii=False) + "\n")
            continue
        (OUT / f"{q['id']}.json").write_text(json.dumps({**e, "summary": item["summary"], "choices": item["choices"], "lawNote": item["lawNote"], "style": "exam"}, ensure_ascii=False))
        saved += 1
    return saved


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--ids", nargs="*")
    args = parser.parse_args()
    questions = {q["id"]: q for q in json.loads((ROOT / "data/questions.json").read_text())["questions"]}
    questions.update({q["id"]: q for q in json.loads((ROOT / "app/public/questions.json").read_text())})
    todo = []
    for path in sorted(OUT.glob("*.json")):
        e = json.loads(path.read_text())
        if e.get("style") == "exam" or e.get("review", {}).get("status") == "partial" or path.stem not in questions:
            continue
        todo.append((questions[path.stem], e))
    if args.ids:
        todo = [t for t in todo if t[0]["id"] in args.ids]
    elif args.sample:
        picker = random.Random(63)
        subjects = sorted({q["subject"] for q, _ in todo})
        todo = [item for s in subjects for item in picker.sample([t for t in todo if t[0]["subject"] == s], args.sample)]
    elif not args.all:
        parser.error("--sample 또는 --all")
    todo.sort(key=lambda t: (t[0]["subject"], t[0]["id"]))
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f"{len(todo)}문항 {len(batches)}묶음", flush=True)
    saved = 0
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        for future in concurrent.futures.as_completed([pool.submit(work, b) for b in batches]):
            if future.exception():
                print(f"묶음 실패: {future.exception()}", flush=True)
            else:
                saved += future.result()
    print(f"저장 {saved}/{len(todo)}", flush=True)


if __name__ == "__main__":
    main()
