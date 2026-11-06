from crawl import is_first_exam, parse_files, parse_rows, safe_name

row = """<a href="#" onclick="goNext('5255124', '1', 'Y')">2026년 제63회 변리사 1차시험 문제지</a></td><td>부서</td><td>2026.03.03</td>"""
assert parse_rows(row) == [("5255124", "2026년 제63회 변리사 1차시험 문제지", "2026.03.03")]
assert parse_files("""onclick="fileDown('bbs/Q004/Q004_1', '1차 문제&amp;답.zip', '2251015');" """) == [("bbs/Q004/Q004_1", "1차 문제&답.zip", "2251015")]
assert is_first_exam("변리사 1 차 시험") and not is_first_exam("2025년 제62회 변리사 2차시험 기출문제")
assert safe_name("../a/b.zip") == "_a_b.zip"
print("ok")
