#!/usr/bin/env python3
"""data/ox 의 OX 문장을 D1 ox 테이블에 넣는다. 같은 id는 덮어쓴다. --local 이면 개발용 로컬 D1."""
import json, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).parent
DB = "f4043927-ef1d-477e-b86f-c5b024cefb32"
CHUNK = 50
PUT = "INSERT INTO ox (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body"


def rows():
    questions = {q["id"] for q in json.loads((ROOT / "app/public/questions.json").read_text())}
    for path in sorted((ROOT / "data/ox").glob("*.json")):
        items = json.loads(path.read_text())
        if path.stem not in questions or not isinstance(items, list) or not all(
                isinstance(s.get("text"), str) and s["text"].strip() and isinstance(s.get("o"), bool)
                and isinstance(s.get("note"), str) and s["note"].strip() and s.get("c") in range(6) for s in items):
            raise ValueError(f"{path.name} 형식 오류")
        if items:
            yield path.stem, json.dumps(items, ensure_ascii=False, separators=(",", ":"))


def main():
    items = list(rows())
    where = ["--local"] if "--local" in sys.argv else []
    if "--check" in sys.argv:
        return print(f"{len(items)}문항 OX 확인")
    for i in range(0, len(items), CHUNK):
        batch = [{"sql": PUT, "params": list(row)} for row in items[i:i + CHUNK]]
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(batch, f, ensure_ascii=False)
            f.flush()
            result = subprocess.run(["npx", "--no-install", "cf", "d1", "query", DB, *where, "--batch", f"@{f.name}", "-q"], cwd=ROOT / "app", capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
        print(f"{min(i + CHUNK, len(items))}/{len(items)}", flush=True)


if __name__ == "__main__":
    main()
