#!/usr/bin/env python3
"""Inventory missing explanations and unresolved evidence, without treating placeholders as proof."""
import argparse
import collections
import json
from pathlib import Path
from law_lookup import check_basis
from evidence_store import check_registered_basis, explanation_hash

ROOT = Path(__file__).parent


def audit():
    questions = json.loads((ROOT / 'app/public/questions.json').read_text())
    dates = json.loads((ROOT / 'data/exam_dates.json').read_text())
    report = {'total': len(questions), 'explanations': 0, 'subjects': {}, 'kinds': collections.Counter(),
              'missing': [], 'invalid': [], 'unresolved': [], 'uncovered': [], 'semanticPending': []}
    for q in questions:
        row = report['subjects'].setdefault(q['subject'], {'total': 0, 'explained': 0})
        row['total'] += 1
        path = ROOT / f"data/explanations/{q['id']}.json"
        if not path.exists():
            report['missing'].append(q['id'])
            continue
        ex = json.loads(path.read_text())
        review = ex.get('review', {})
        if review.get('status') != 'verified' or review.get('contentHash') != explanation_hash(ex):
            report['semanticPending'].append(q['id'])
        report['explanations'] += 1
        row['explained'] += 1
        if not isinstance(ex.get('summary'), str) or not ex['summary'].strip() or len(ex.get('choices', [])) != 5 or not all(isinstance(c, str) and c.strip() for c in ex['choices']):
            report['invalid'].append({'id': q['id'], 'reason': 'invalid explanation structure'})
        verified_slots = set()
        for i, b in enumerate(ex.get('basis', [])):
            kind = b.get('kind', 'unknown')
            report['kinds'][kind] += 1
            error = check_basis(b, dates[str(q['year'])]) if kind in ('article', 'treaty') else check_registered_basis(b, q['id'], dates[str(q['year'])])
            if error:
                report['unresolved'].append({'id': q['id'], 'basisIndex': i, 'choice': b.get('choice'), 'kind': kind, 'reason': error})
            elif b.get('choice') in range(6):
                verified_slots.add(b['choice'])
        missing_slots = [] if 0 in verified_slots else sorted(set(range(1, 6)) - verified_slots)
        if missing_slots:
            report['uncovered'].append({'id': q['id'], 'choices': missing_slots})
    report['quoteMatchedEvidenceOnly'] = True
    report['semanticReviewRequired'] = 'Matching a quote proves its origin, not that it entails every explanation claim.'
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    parser.add_argument('--require-complete', action='store_true')
    args = parser.parse_args()
    report = audit()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: len(v) if isinstance(v, list) else v for k, v in report.items()}, ensure_ascii=False, indent=2))
    if args.require_complete and any(report[k] for k in ('missing', 'invalid', 'unresolved', 'uncovered', 'semanticPending')):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
