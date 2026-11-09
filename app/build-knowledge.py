"""Build a server-only search corpus from collected law text, reviewed excerpts, and past exam questions."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent.parent
SITE = "https://note.leo0409.work"
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
# 과학 인용은 해설마다 따로 모은 짧은 발췌라 같은 교과서 절이 제목만 달리 여러 번 들어온다. 주소별로 하나로 합친다
import re
def section_title(url, titles):
    best = max(titles, key=lambda t: len(re.sub(r"[^A-Za-z가-힣]", "", t)))
    m = re.search(r"openstax\.org/books/([^/]+)/pages/(\d+)-(\d+)-([^/?#]+)", url)
    if re.search(r"[A-Za-z가-힣]{3}", re.sub(r"^[\d.§ ]+", "", best)) or not m: return best
    book = " ".join(w[:1].upper() + w[1:] for w in m.group(1).split("-"))
    return f"{book} {m.group(2)}.{m.group(3)} {m.group(4).replace('-', ' ').capitalize()}"
science = {}
for d in [d for d in docs if d["kind"] == "science"]:
    science.setdefault(d["url"], []).append(d)
# collect_science_text.py가 받아 둔 원문 문단이 있으면 짧은 인용 대신 그 문단을 쓴다
collected = {}
for path in sorted((root / "data/science").glob("*.json")):
    item = json.loads(path.read_text())
    collected[item["url"]] = "\n".join([item["text"], *item.get("missingExcerpts", [])])
docs = [d for d in docs if d["kind"] != "science"] + [{**group[0], "title": section_title(url, [d["title"] for d in group]),
    "text": collected.get(url) or "\n".join(dict.fromkeys(d["text"] for d in group)), "hints": " ".join(dict.fromkeys(d["hints"] for d in group if d["hints"]))[:1800],
    "collected": max(d["collected"] for d in group)} for url, group in science.items()]
# 기출은 문제 글만 넣어 "시험에서 어떻게 묻는가"로 검색한다. 해설·근거 인용은 D1에 있어 답변 직전에 붙인다
for q in json.loads((root / "app/public/questions.json").read_text()):
    text = "\n".join([f"문제: {q['stem']}", "보기:", *[f"{i+1}. {c}" for i, c in enumerate(q['choices'])], f"정답: {', '.join(str(a) for a in q['answer'])}번"])
    docs.append({"kind":"question", "id":q['id'], "title":f"{q['year']}년 {q['subject']} {q['number']}번 기출 · {q['topic']}", "text":text, "hints":q['topic'], "url":f"{SITE}/#question/{q['id']}", "collected":"", "from":"", "to":None})
out = root/'app/src/knowledge.json'
out.write_text(json.dumps(docs,ensure_ascii=False,separators=(',',':')))
print(f"Built {len(docs)} source passages ({out.stat().st_size} bytes)")
