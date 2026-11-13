import assert from "node:assert/strict";
import { createSession } from "./auth.js";
import worker from "./worker.js";
import { testDb } from "./test-db.js";

const kv = new Map();
const env = {
	ANTHROPIC_API_KEY: "test",
	DB: testDb(),
	STORE: {
		get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
		put: async (k, v) => void kv.set(k, v),
		delete: async (k) => void kv.delete(k),
	},
};
const ORIGIN = "https://note.leo0409.work";
const token = await createSession(env);
const post = (path, body, session = token, origin = ORIGIN) =>
	worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin, cookie: `session=${session}` }, body: JSON.stringify(body) }), env);

const question = { id: "q1", year: 2020, subject: "민법개론", stem: "문제", choices: ["가", "나", "다", "라", "마"], answer: [2], images: ["images/q1.webp"] };
const explanation = { summary: "요약", choices: ["1", "2", "3", "4", "5"], lawNote: "" };
const calls = [];
let streamStop = "end_turn";
const sse = (chunks) => {
	const events = [
		{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		...chunks.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: streamStop, stop_sequence: null }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
globalThis.fetch = async (url, init) => {
	const body = JSON.parse(init.body);
	calls.push({ url: String(url), headers: new Headers(init.headers), body });
	return sse(["안녕", "하세요"]);
};

assert.equal((await post("/api/sync", {}, "nope")).status, 401);
assert.equal((await post("/api/sync", {}, token, "https://evil.example")).status, 403);

// 해설은 D1에서만 읽고 Claude를 부르지 않는다
env.DB.prepare("INSERT INTO explanations (id, body) VALUES (?, ?)").bind("q1", JSON.stringify(explanation)).run();
assert.deepEqual(await (await post("/api/explain", { id: "q1" })).json(), explanation);
assert.equal((await post("/api/explain", { id: "없음" })).status, 404);
assert.equal(calls.length, 0);

// 추가 질문은 화면 순서와 고른 답을 알리고 글자를 흘려보낸다
const chat = { question, explanation, messages: [{ role: "user", content: "3번 왜 정답이에요?" }], order: [2, 0, 1, 3, 4], pick: 0 };
const chatReply = await post("/api/ask", chat);
assert.equal(await chatReply.text(), "안녕하세요");
const sent = calls.at(-1).body;
assert.equal(sent.stream, true);
assert.equal(sent.fallbacks, "default");
assert.match(sent.system, /나희 화면 기준/);
assert.match(sent.system, /\[순서도\]/);
const context = sent.messages[0].content.at(-1).text;
assert.match(context, /1\. 다\n2\. 가\n3\. 나/); // 원본 2번 "나"는 화면 3번
assert.match(context, /공식 정답: 3번/);
assert.match(context, /나희가 고른 답: 2번/);
assert.match(context, /1번: 3\n2번: 1\n3번: 2/); // 해설도 화면 순서
assert.equal(sent.messages.at(-1).content, "3번 왜 정답이에요?");

// 미리 만든 해설의 근거 인용문도 챗봇에 넘긴다
const basis = [{ choice: 1, kind: "article", source: "민법", ref: "110", quote: "취소할 수 있다", changed: false }, { choice: 2, kind: "precedent", source: "판례", ref: "", quote: "", changed: false }];
await (await post("/api/ask", { ...chat, explanation: { ...explanation, basis } })).text();
const grounded = calls.at(-1).body.messages[0].content.at(-1).text;
assert.match(grounded, /시험 당시 본문으로 확인한 근거\n민법 제110조: 취소할 수 있다$/);

// 답변 도중 거절은 스트림 오류로 끝나서 앱이 일부만 저장하지 않는다
streamStop = "refusal";
await assert.rejects((await post("/api/ask", chat)).text());
// 길이 한도에서 끊긴 답변은 끊겼다는 표시가 붙는다
streamStop = "max_tokens";
assert.match(await (await post("/api/ask", chat)).text(), /^안녕하세요\n\n※ 길이 한도로 답변 중단$/);
streamStop = "end_turn";

// 동기화는 서버 기록과 합친다
const state = (log) => ({ log, days: {}, flags: {} });
await post("/api/sync", state([{ t: 1, id: "a", ok: true }]));
const merged = await (await post("/api/sync", state([{ t: 2, id: "b", ok: false }]))).json();
assert.equal(merged.log.length, 2);

console.log("worker ok");
