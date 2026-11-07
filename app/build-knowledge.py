"""Build a server-only search corpus from collected law text and reviewed excerpts."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent.parent
docs = []
for path in sorted((root / "data/law").glob("*.json")):
    data = json.loads(path.read_text())
    for ref, spans in data.get("articles", {}).items():
        for span in spans:
            docs.append({"kind":"law", "title":f"{data['law']} 제{ref}조 {span['title']}", "text":span['text'], "from":span['from'], "to":span['to'], "collected":data['collected'], "url":"https://www.law.go.kr/법령/"+data['law']+"/제"+ref+"조"})
questions = {q['id']:q for q in json.loads((root/'data/questions.json').read_text())['questions']}
for path in sorted((root / "data/evidence").glob("*.json")):
    data = json.loads(path.read_text())
    if data.get('kind') not in ('science', 'precedent') or not data.get('excerpt') or not data.get('url'): continue
    mapped = [questions.get(k.rsplit(':',1)[0], {}) for k in data.get('reviewedMappings', {})]
    hints = ' '.join(dict.fromkeys(q.get('stem','')[:200] for q in mapped))[:1800]
    docs.append({"kind":data["kind"], "title":data.get('ref',data['source']), "text":data['excerpt'], "hints":hints, "url":data['url'], "collected":data.get('retrievedAt','')[:10], "from":data.get("decisionDate", ""), "to":None})
out = root/'app/src/knowledge.json'
out.write_text(json.dumps(docs,ensure_ascii=False,separators=(',',':')))
print(f"Built {len(docs)} source passages ({out.stat().st_size} bytes)")
