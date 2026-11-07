#!/usr/bin/env python3
"""Resolve proposed case numbers to official decisions. Candidates remain unverified mappings."""
import argparse
import json
import re
import time
from pathlib import Path
from evidence_store import ROOT, fetch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=30)
    args = parser.parse_args()
    index_path = ROOT / 'work/evidence-candidates.json'
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    candidates = set()
    for path in sorted((ROOT / 'work/evidence-proposals').glob('*.json')):
        for match in json.loads(path.read_text())['matches']:
            candidates.update(match['caseNumbers'])
    count = 0
    for case in sorted(candidates):
        if case in index:
            continue
        if count >= args.limit:
            break
        count += 1
        try:
            if not re.fullmatch(r'\d{2,4}[가-힣]{1,8}\d+', case):
                raise ValueError('case number requires manual normalization')
            source = fetch(f'https://www.law.go.kr/판례/({case})')
            headers = re.findall(r'\[([^\]]{10,160})\]', source['text'])
            header = next((h for h in headers if case in h and ('선고' in h or '결정' in h)), None)
            if not header:
                raise ValueError('case number not found in decision heading')
            date = re.search(r'(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.', header)
            if not date:
                raise ValueError('decision date unavailable')
            record = {'sourceId': source['id'], 'url': source['url'], 'decisionDate': f'{int(date[1]):04}{int(date[2]):02}{int(date[3]):02}', 'heading': header.strip(), 'status': 'retrieved-not-matched'}
        except Exception as error:
            record = {'status': 'needs-search', 'error': str(error)}
        index[case] = record
        index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'case': case, **record}, ensure_ascii=False), flush=True)
        time.sleep(.5)


if __name__ == '__main__':
    main()
