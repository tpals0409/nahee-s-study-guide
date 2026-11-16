-- 기출 선지를 바꾼 OX 문장. 문항 id 하나에 문장 배열(JSON) 하나. gen_ox.py 로 만들고 load_ox.py 로 넣는다
CREATE TABLE ox (
	id TEXT PRIMARY KEY,
	body TEXT NOT NULL
);
