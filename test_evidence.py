import copy
import json
import unittest
import tempfile
from unittest.mock import patch
from pathlib import Path
from evidence_store import check_registered_basis, article_link, explanation_hash
from evidence_store import register_reviewed_excerpt


class EvidenceTests(unittest.TestCase):
    def test_multiple_excerpts_preserve_existing_mappings(self):
        source = dict(id='cache', url='https://www.law.go.kr/example', text='first claim; second claim',
                      sha256='source-hash', retrievedAt='2026-11-06',
                      retrievalMethod='web excerpt', textScope='excerpt only')
        with tempfile.TemporaryDirectory() as directory, patch('evidence_store.ROOT', Path(directory)):
            def register(quote, choice):
                return register_reviewed_excerpt(source, kind='precedent', ref='case', publisher='대법원',
                    quote=quote, mappings={f'2008-1-01:{choice}': 'reviewed'}, decision_date='20070101')
            first = register('first claim', 1)
            second = register('second claim', 2)
            self.assertNotEqual(first['evidenceId'], second['evidenceId'])
            register('first claim', 3)
            saved = json.loads((Path(directory) / 'data/evidence' / (first['evidenceId'] + '.json')).read_text())
            self.assertEqual(saved['sourceHashScope'], 'excerpt only')
            self.assertEqual(saved['retrievalMethod'], 'web excerpt')
            self.assertIsNone(check_registered_basis(dict(first, choice=1), '2008-1-01', '20080101'))
            self.assertIsNone(check_registered_basis(dict(first, choice=3), '2008-1-01', '20080101'))
            with self.assertRaises(ValueError):
                register('fabricated claim', 4)

    def test_science_requires_the_reviewed_question_and_exact_excerpt(self):
        ex = json.loads(Path('data/explanations/2009-3-02.json').read_text())
        basis = ex['basis'][0]
        self.assertIsNone(check_registered_basis(basis, '2009-3-02', '20090301'))
        self.assertIsNotNone(check_registered_basis(basis, '2009-3-01', '20090301'))
        self.assertIsNotNone(check_registered_basis({**basis, 'quote': 'fabricated'}, '2009-3-02', '20090301'))
        self.assertIsNotNone(check_registered_basis({**basis, 'url': 'https://example.com'}, '2009-3-02', '20090301'))

    def test_precedent_cannot_postdate_exam(self):
        ex = json.loads(Path('data/explanations/2008-2-01.json').read_text())
        basis = next(b for b in ex['basis'] if b['choice'] == 5)
        self.assertIsNone(check_registered_basis(basis, '2008-2-01', '20080301'))
        self.assertIsNotNone(check_registered_basis(basis, '2008-2-01', '19920101'))

    def test_historical_version_and_stale_review(self):
        url, date = article_link('민법', '20080201')
        self.assertIn('lsiSeq=79107', url)
        self.assertEqual(date, '20080101')
        ex = {'summary': 'a', 'choices': ['b']}
        first = explanation_hash(ex)
        ex['review'] = {'contentHash': first}
        self.assertEqual(first, explanation_hash(ex))
        ex['summary'] = 'changed'
        self.assertNotEqual(first, explanation_hash(ex))


if __name__ == '__main__':
    unittest.main()
