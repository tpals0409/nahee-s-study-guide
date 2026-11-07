#!/usr/bin/env python3
"""data/explanations 의 해설을 운영 D1에 넣는다. 같은 id는 덮어써서 몇 번을 돌려도 된다."""
import json, subprocess, tempfile, sys
from pathlib import Path
from law_lookup import check_basis
from evidence_store import check_registered_basis

ROOT = Path(__file__).parent
DB = "f4043927-ef1d-477e-b86f-c5b024cefb32"
CHUNK = 50
PUT = "INSERT INTO explanations (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body"


def rows():
    questions = {q["id"]: q for q in json.loads((ROOT / "app/public/questions.json").read_text())}
    dates = json.loads((ROOT / 'data/exam_dates.json').read_text())
    for path in sorted((ROOT / "data/explanations").glob("*.json")):
        body = json.loads(path.read_text())
        if (path.stem not in questions or not isinstance(body.get("summary"), str)
                or not body["summary"].strip() or not isinstance(body.get("choices"), list)
                or len(body["choices"]) != len(questions[path.stem]["choices"])
                or not all(isinstance(c, str) and c.strip() for c in body["choices"])):
            raise ValueError(f"{path.name} 형식 오류")
        for basis in body.get('basis', []):
            if not isinstance(basis, dict) or type(basis.get('choice')) is not int or basis['choice'] not in range(6) or basis.get('kind') not in ('article', 'treaty', 'precedent', 'science'):
                raise ValueError(f'{path.name} 근거 형식 오류')
            date = dates[str(questions[path.stem]['year'])]
            error = check_registered_basis(basis, path.stem, date) if basis.get('evidenceId') or basis['kind'] == 'science' else check_basis(basis, date)
            if error:
                raise ValueError(f'{path.name}: {error}')
        yield path.stem, json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def main():
    items = list(rows())
    if "--check" in sys.argv:
        print(f"Validated {len(items)} explanations")
        return
    for i in range(0, len(items), CHUNK):
        batch = [{"sql": PUT, "params": list(row)} for row in items[i:i + CHUNK]]
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(batch, f, ensure_ascii=False)
            f.flush()
            result = subprocess.run(["npx", "--no-install", "cf", "d1", "query", DB, "--batch", f"@{f.name}", "-q"], cwd=ROOT / "app", capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(result.stderr or result.stdout)
        print(f"{min(i + CHUNK, len(items))}/{len(items)}", flush=True)
    subprocess.run(["npx", "--no-install", "cf", "d1", "query", DB, "--sql", "SELECT count(*) AS explanations FROM explanations", "-q"], cwd=ROOT / "app", check=True)


if __name__ == "__main__":
    main()
