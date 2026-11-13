import assert from "node:assert/strict";
import { testDb } from "./test-db.js";
import { chats, ChatRunner, runAnswer } from "./chats.js";

const kv = new Map();
const runners = [];
const env = {
	ANTHROPIC_API_KEY: "test", DB: testDb(),
	STORE: { get: async (k, t) => kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
	CHAT: { idFromName: (n) => n, get: (id) => ({ fetch: async (url, init) => { const store = new Map(); const r = new ChatRunner({ storage: { put: async (k, v) => store.set(k, v), get: async (k) => store.get(k), setAlarm: async () => {}, deleteAll: async () => store.clear() } }, env); await r.fetch(new Request(url, init)); runners.push(r); return new Response("ok"); } }) },
};
const call = async (path, body) => (await chats(new Request(`https://x${path}`, { method: "POST", body: JSON.stringify(body) }), env)).json();

// Anthropic 응답 흉내: 검색 계획(JSON) 다음 스트리밍 답변
let answerText = "결론입니다. X_L = 2πfL";
globalThis.fetch = async (url, init) => {
	const body = JSON.parse(init.body);
	if (!body.stream) return Response.json({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: '{"query":"공진","articles":[],"date":"20261109","unclear":""}' }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
	const ev = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answerText } },
		{ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
	return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};

// 질문을 보내면 바로 접수되고 답변은 pending 으로 남는다
const sent = await call("/api/chats/send", { content: "RLC 공진 주파수\n왜 그래?", images: [{ media_type: "image/png", data: "AAAA" }] });
assert.ok(sent.chatId && sent.replyId);
assert.equal((await call("/api/chats/poll", { id: sent.replyId })).status, "pending");
let listed = await call("/api/chats/list", {});
assert.equal(listed.chats[0].title, "RLC 공진 주파수");
assert.equal(listed.chats[0].pending, true);
assert.equal((await call("/api/chats/send", { chatId: sent.chatId, content: "또" })).error, "이전 답변을 만드는 중이에요.");

// 알람이 앱과 상관없이 답변을 끝까지 만든다
await runners.at(-1).alarm();
const done = await call("/api/chats/poll", { id: sent.replyId });
assert.equal(done.status, "done");
assert.equal(done.content, answerText);
assert.ok(Array.isArray(done.sources));
const full = await call("/api/chats/get", { id: sent.chatId });
assert.equal(full.messages.length, 2);
assert.equal(full.messages[0].images[0].data, "AAAA", "photos come back from KV");

// 같은 대화에 이어 묻기, 다른 대화는 따로
const second = await call("/api/chats/send", { chatId: sent.chatId, content: "더 쉽게" });
await runners.at(-1).alarm();
assert.equal((await call("/api/chats/get", { id: sent.chatId })).messages.length, 4);
const other = await call("/api/chats/send", { content: "멘델 법칙" });
assert.notEqual(other.chatId, sent.chatId);
assert.equal((await call("/api/chats/list", {})).chats.length, 2);

// 모델 오류는 error 로 남고, 끝난 답변은 다시 돌려도 바뀌지 않는다
answerText = "";
await runners.at(-1).alarm();
assert.equal((await call("/api/chats/poll", { id: other.replyId })).status, "error");
await runAnswer(env, second.replyId);
// 실패한 질문 뒤에 다시 물어도 대화 순서가 맞아 답변이 만들어진다
answerText = "다시 답합니다";
const retry = await call("/api/chats/send", { chatId: other.chatId, content: "멘델 법칙 다시" });
await runners.at(-1).alarm();
assert.equal((await call("/api/chats/poll", { id: retry.replyId })).status, "done");
assert.equal((await call("/api/chats/poll", { id: second.replyId })).status, "done");

// 답변 작업을 못 띄우면 pending 을 남기지 않아 대화가 막히지 않는다
const realGet = env.CHAT.get;
env.CHAT.get = () => ({ fetch: async () => { throw new Error("down"); } });
const failed = await chats(new Request("https://x/api/chats/send", { method: "POST", body: JSON.stringify({ chatId: other.chatId, content: "안 뜸" }) }), env);
assert.equal(failed.status, 502);
env.CHAT.get = realGet;
// 알람이 죽어 오래 남은 pending 은 읽을 때 error 로 풀리고, 다음 질문을 받는다
const stuck = await call("/api/chats/send", { chatId: other.chatId, content: "멈춘 질문" });
await env.DB.prepare("UPDATE chat_messages SET created = created - 3600000 WHERE id = ?").bind(stuck.replyId).run();
assert.equal((await call("/api/chats/poll", { id: stuck.replyId })).status, "error");
const after = await call("/api/chats/send", { chatId: other.chatId, content: "다음 질문" });
assert.ok(after.replyId);
await runners.at(-1).alarm();
assert.equal((await call("/api/chats/poll", { id: after.replyId })).status, "done");

// 잘못된 사진은 저장 전에 거절, 삭제하면 사진도 지운다
assert.match((await call("/api/chats/send", { content: "x", images: [{ media_type: "image/gif", data: "AAAA" }] })).error, /형식/);
await call("/api/chats/delete", { id: sent.chatId });
assert.equal((await call("/api/chats/list", {})).chats.length, 1);
assert.equal([...kv.keys()].filter((k) => k.startsWith("chatimg:")).length, 0);
console.log("server chats, background answers and photos ok");
