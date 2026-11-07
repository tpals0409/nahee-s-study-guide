#!/usr/bin/env python3
"""Fetch public primary sources and retain provenance. Fetching alone is not semantic verification."""
import argparse
import datetime
import hashlib
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).parent
CACHE = ROOT / 'work/evidence-cache'
ALLOWED = {'law.go.kr', 'www.law.go.kr', 'openstax.org', 'science.nasa.gov', 'www.nasa.gov',
           'www.noaa.gov', 'www.weather.gov', 'www.usgs.gov', 'pubs.usgs.gov', 'www.nist.gov', 'www.ncbi.nlm.nih.gov'}


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        elif tag in ('p', 'br', 'div', 'h1', 'h2', 'h3', 'li', 'section') and not self.skip:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

    def text(self):
        return re.sub(r'\n\s*\n+', '\n\n', ''.join(self.parts)).strip()


def fetch(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED or parsed.username:
        raise ValueError('Primary-source HTTPS URL required')
    safe_url = urllib.parse.quote(url, safe=':/?=&()%-#')
    key = hashlib.sha256(safe_url.encode()).hexdigest()[:20]
    path = CACHE / f'{key}.json'
    if path.exists():
        return json.loads(path.read_text())
    request = urllib.request.Request(safe_url, headers={'User-Agent': 'Mozilla/5.0 (study-source-verification)'})
    with urllib.request.urlopen(request, timeout=45) as response:
        if urllib.parse.urlsplit(response.url).hostname not in ALLOWED:
            raise ValueError('Unexpected redirect host')
        html = response.read().decode('utf-8')
        actual = response.url
    # Official case short links use a transparent iframe wrapper.
    frame = re.search(r'<iframe[^>]+src=["\']([^"\']+)', html, re.I)
    if frame and 'precInfoP.do' in frame[1]:
        return fetch(urllib.parse.urljoin(actual, frame[1]).replace('/LSW//', '/LSW/'))
    parser = Text()
    parser.feed(html)
    text = parser.text()
    if len(text) < 300:
        raise ValueError('No substantive source text')
    title = re.search(r'<title>(.*?)</title>', html, re.S | re.I)
    result = {'id': key, 'url': actual, 'title': title[1].strip() if title else '', 'text': text,
              'sha256': hashlib.sha256(text.encode()).hexdigest(), 'retrievedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False))
    return result


def article_link(source, date):
    law = json.loads((ROOT / f'data/law/{source}.json').read_text())
    version = max((v for v in law['versions'] if v['from'] <= date), key=lambda v: v['from'])
    return f"https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq={version['mst']}", version['from']


def check_registered_basis(basis, question_id, exam_date):
    key = basis.get('evidenceId', '')
    if not re.fullmatch(r'[a-f0-9]{20}', key):
        return 'registered source required'
    path = ROOT / f'data/evidence/{key}.json'
    if not path.exists():
        return 'source record missing'
    source = json.loads(path.read_text())
    for field in ('kind', 'source', 'ref', 'url'):
        if basis.get(field) != source.get(field):
            return f'source {field} mismatch'
    if basis.get('quote') != source.get('excerpt') or not source.get('excerpt'):
        return 'source excerpt mismatch'
    if not source.get('reviewedMappings', {}).get(f"{question_id}:{basis.get('choice')}"):
        return 'semantic mapping not reviewed'
    if basis.get('kind') == 'precedent' and not ('00000000' < source.get('decisionDate', '') <= exam_date):
        return 'precedent postdates exam or has no decision date'
    return None


def explanation_hash(explanation):
    body = {k: v for k, v in explanation.items() if k != 'review'}
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def register_reviewed_excerpt(source, *, kind, ref, publisher, quote, mappings, decision_date=None):
    """Persist an explicitly reviewed excerpt; distinct excerpts never overwrite each other.

    Callers must review semantic support themselves. This checks provenance only.
    """
    compact = lambda value: re.sub(r'\s+', '', value)
    if not quote or compact(quote) not in compact(source['text']):
        raise ValueError('Excerpt not present in retrieved source')
    if not mappings or any(not re.fullmatch(r'\d{4}-[123]-\d{2}:[0-5]', key) or not reason
                           for key, reason in mappings.items()):
        raise ValueError('Explicit question/choice review required')
    key = hashlib.sha256((source['url'] + '\n' + quote).encode()).hexdigest()[:20]
    path = ROOT / f'data/evidence/{key}.json'
    record = dict(id=key, kind=kind, source=publisher, ref=ref, url=source['url'],
                  excerpt=quote, sourceHash=source['sha256'], cacheSourceId=source['id'],
                  retrievedAt=source['retrievedAt'], reviewedMappings=mappings)
    if source.get('retrievalMethod'):
        record['retrievalMethod'] = source['retrievalMethod']
    if source.get('textScope'):
        record['sourceHashScope'] = source['textScope']
    if decision_date:
        record['decisionDate'] = decision_date
    if path.exists():
        existing = json.loads(path.read_text())
        for field in ('kind', 'source', 'ref', 'excerpt', 'url'):
            if existing[field] != record[field]:
                raise ValueError('Conflicting source identity')
        record['reviewedMappings'] = {**existing['reviewedMappings'], **mappings}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    return dict(kind=kind, source=publisher, ref=ref, quote=quote, url=source['url'],
                evidenceId=key, verification='source-matched', changed=False)


def enrich_articles():
    from law_lookup import check_basis
    dates = json.loads((ROOT / 'data/exam_dates.json').read_text())
    count = 0
    for path in sorted((ROOT / 'data/explanations').glob('*.json')):
        ex = json.loads(path.read_text())
        changed = False
        for basis in ex.get('basis', []):
            if basis.get('kind') != 'article':
                continue
            date = dates[path.stem[:4]]
            error = check_basis(basis, date)
            if error:
                raise ValueError(f'{path.stem}: {error}')
            url, effective = article_link(basis['source'], date)
            if basis.get('url') != url or basis.get('effectiveFrom') != effective:
                basis.update(url=url, effectiveFrom=effective, verification='quote-matched')
                changed = True
            count += 1
        if changed:
            path.write_text(json.dumps(ex, ensure_ascii=False) + '\n')
    return count


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url')
    parser.add_argument('--enrich-articles', action='store_true')
    args = parser.parse_args()
    if args.enrich_articles:
        print(f'{enrich_articles()} article citations validated and linked to historical versions')
    elif args.url:
        source = fetch(args.url)
        print(json.dumps({k: v for k, v in source.items() if k != 'text'}, ensure_ascii=False))
    else:
        parser.error('--url or --enrich-articles required')
