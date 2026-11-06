-- epoch 를 올리면 기기의 사본이 버려지고 서버 기록으로 다시 맞춰진다
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);

INSERT INTO meta (key, value) VALUES ('epoch', 1);
