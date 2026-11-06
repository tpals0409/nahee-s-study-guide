#!/usr/bin/env python3
"""data/explanations 의 해설을 운영 D1에 넣는다. 같은 id는 덮어써서 몇 번을 돌려도 된다."""
import json, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).parent
DB = "f4043927-ef1d-477e-b86f-c5b024cefb32"
CHUNK = 50
PUT = "INSERT INTO explanations (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body"


def rows():
    for path in sorted((ROOT / "data/explanations").glob("*.json")):
        body = json.loads(path.read_text())
        if len(body["choices"]) != 5 or not body["summary"]:
            raise ValueError(f"{path.name} 형식 오류")
        yield path.stem, json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def main():
    items = list(rows())
    for i in range(0, len(items), CHUNK):
        batch = [{"sql": PUT, "params": list(row)} for row in items[i:i + CHUNK]]
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(batch, f, ensure_ascii=False)
            f.flush()
            subprocess.run(["cf", "d1", "query", DB, "--batch", f"@{f.name}", "-q"], cwd=ROOT / "app", check=True, capture_output=True, text=True)
        print(f"{min(i + CHUNK, len(items))}/{len(items)}", flush=True)


if __name__ == "__main__":
    main()
