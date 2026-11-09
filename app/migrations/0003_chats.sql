-- 홈 AI 질문의 대화 목록. 답변은 서버(ChatRunner)가 끝까지 만들어 status 를 done/error 로 바꾼다
CREATE TABLE chats (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	created INTEGER NOT NULL,
	updated INTEGER NOT NULL
);
-- images 는 사진 개수만 적고 원본은 KV(chatimg:<메시지 id>)에 둔다. D1 행 크기 제한(2MB) 때문이다
CREATE TABLE chat_messages (
	id TEXT PRIMARY KEY,
	chat_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	role TEXT NOT NULL,
	content TEXT NOT NULL,
	images INTEGER NOT NULL DEFAULT 0,
	sources TEXT,
	status TEXT NOT NULL DEFAULT 'done',
	created INTEGER NOT NULL
);
CREATE INDEX chat_messages_chat ON chat_messages (chat_id, seq);
