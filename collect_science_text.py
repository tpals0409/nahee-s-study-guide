"""과학 근거 인용 주변의 교과서·공공기관 원문 문단을 모아 data/science/에 저장한다.

해설 근거(data/evidence)의 짧은 인용만으로는 챗봇 근거가 얕다. 인용이 들어 있는 문단과
앞뒤 문단을 원문에서 가져와 절마다 하나의 긴 발췌로 만든다. 저작권 때문에 OpenStax(CC BY 4.0)와
미국 연방 기관(퍼블릭 도메인)만 받고, 논문(NCBI 계열)이나 그 밖의 사이트는 기존 짧은 인용을 그대로 쓴다.

python3 collect_science_text.py            # 아직 없는 주소만 받기
python3 collect_science_text.py --refresh  # 전부 다시 받기
"""
import concurrent.futures, datetime, hashlib, html, json, re, sys, time, urllib.parse, urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "data/science"
MAX_CHARS = 1500  # 절마다 남길 원문 길이. 번들(gzip 약 1.4MB)에 들어가야 한다
FEDERAL = ("nasa.gov", "noaa.gov", "usgs.gov", "nps.gov", "weather.gov", "tsunami.gov", "nist.gov", "epa.gov",
           "energy.gov", "usda.gov", "cdc.gov", "nih.gov", "fda.gov", "cancer.gov", "genome.gov")
NO_ARTICLES = ("ncbi.nlm.nih.gov", "pubmed", "pmc.", "nlm.nih.gov")


def allowed(url):
    host = urllib.parse.urlsplit(url).hostname or ""
    if host == "openstax.org":
        return "CC BY 4.0, OpenStax"
    if any(host == d or host.endswith("." + d) for d in FEDERAL) and not any(x in host for x in NO_ARTICLES):
        return "U.S. federal government work (public domain)"
    return None


class Paragraphs(HTMLParser):
    """<p>·<li> 글을 문단 단위로 모은다. script/style/nav/footer 안은 버린다."""
    SKIP = {"script", "style", "nav", "footer", "header", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.stack, self.skip = [], [], 0  # 문단 안에 문단(상자 글)이 끼면 따로 모은다

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP: self.skip += 1
        elif tag in ("p", "li") and not self.skip: self.stack.append([])
        elif tag in ("sub", "sup") and self.stack: self.stack[-1].append("_" if tag == "sub" else "^")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip: self.skip -= 1
        elif tag in ("p", "li") and self.stack:
            text = re.sub(r"\s+", " ", "".join(self.stack.pop())).strip()
            if len(text) > 40: self.out.append(text)

    def handle_data(self, data):
        if self.stack and not self.skip: self.stack[-1].append(data)


norm = lambda s: re.sub(r"[^a-z0-9]+", "", html.unescape(s).lower())


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (study-source-verification)"})
    with urllib.request.urlopen(req, timeout=45) as r:
        if urllib.parse.urlsplit(r.url).hostname != urllib.parse.urlsplit(url).hostname:
            raise ValueError("redirected to another host")
        return r.read().decode("utf-8", "replace")


def passage(paras, excerpts):
    """인용이 든 문단과 앞뒤 한 문단씩을 원문 순서대로 합친다. 못 찾은 인용은 그대로 붙인다."""
    keys = [norm(p).replace("_", "").replace("^", "") for p in paras]
    picked, missing = set(), []
    for ex in excerpts:
        k = norm(ex)[:60]
        hit = next((i for i, p in enumerate(keys) if k and k in p), None)
        if hit is None: missing.append(ex)
        else: picked.update(range(max(0, hit - 1), min(len(paras), hit + 2)))
    text = "\n".join(paras[i] for i in sorted(picked))
    # 인용 문단이 먼저 들어가도록, 넘치면 앞뒤 문단부터 자른다
    if len(text) > MAX_CHARS:
        core = [paras[i] for i in sorted(picked) if any(norm(ex)[:60] in keys[i] for ex in excerpts)]
        text = "\n".join(core)[:MAX_CHARS]
    return text, missing


def collect(url, excerpts, title, license_):
    path = OUT / f"{hashlib.sha256(url.encode()).hexdigest()[:16]}.json"
    if path.exists() and "--refresh" not in sys.argv:
        return "있음"
    p = Paragraphs()
    p.feed(fetch(url))
    text, missing = passage(p.out, excerpts)
    if not text:
        return "본문에서 인용을 못 찾음"
    path.write_text(json.dumps({"url": url, "title": title, "license": license_, "collected": datetime.date.today().isoformat(),
                                "text": text, "missingExcerpts": missing}, ensure_ascii=False, indent=1))
    time.sleep(0.5)
    return "저장" + (f" (인용 {len(missing)}개 못 찾음)" if missing else "")


def main():
    groups = {}
    for f in sorted((ROOT / "data/evidence").glob("*.json")):
        e = json.loads(f.read_text())
        if e.get("kind") != "science" or not e.get("url") or not e.get("excerpt"): continue
        g = groups.setdefault(e["url"], {"excerpts": [], "titles": []})
        g["excerpts"].append(e["excerpt"]); g["titles"].append(e.get("ref") or e.get("source", ""))
    jobs = [(u, g) for u, g in groups.items() if allowed(u)]
    print(f"과학 출처 {len(groups)}곳 중 수집 대상 {len(jobs)}곳")
    OUT.mkdir(exist_ok=True)
    tally = {}
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        futures = {pool.submit(collect, u, list(dict.fromkeys(g["excerpts"])), max(g["titles"], key=len), allowed(u)): u for u, g in jobs}
        for fut in concurrent.futures.as_completed(futures):
            try: status = fut.result()
            except Exception as error: status = f"실패: {type(error).__name__}"
            tally[status.split(" (")[0]] = tally.get(status.split(" (")[0], 0) + 1
            if not status.startswith(("저장", "있음")): print(status, futures[fut])
    print(tally)


if __name__ == "__main__":
    main()
