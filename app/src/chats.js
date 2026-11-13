// 홈 AI 질문의 여러 대화와 서버 답변. 질문을 받으면 바로 접수만 하고, 답변은 ChatRunner(Durable Object 알람)가
// 앱이 닫혀도 끝까지 만들어 D1 에 조금씩 쓴다. 앱은 열린 대화만 짧은 간격으로 읽어 흘러나오듯 보여 준다.
import { CUT_NOTE, tutorReply, validateTutor } from "./tutor.js";

const MAX_MESSAGES = 28;
const FLUSH_MS = 800;
// 알람은 최대 15분이라 그보다 오래된 pending 은 멈춘 것으로 보고 error 로 푼다
const STALE_MS = 20 * 60 * 1000;
const json = (data, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const now = () => Date.now();
const imageKey = (id) => `chatimg:${id}`;
// 모델에 넘길 대화. 답변이 실패한 질문과 그 실패 답변은 빼서 user/assistant 순서를 지킨다
const usable = (ms) => ms.filter((m, i) => m.status === "done" && !(m.role === "user" && ms[i + 1]?.status === "error"));
// 사진은 가장 최근에 보낸 것만 다시 넘긴다. 전부 넘기면 사진 질문 두세 번에 크기 한도를 넘어 대화가 막힌다
const forModel = (ms) => {
	const use = usable(ms), keep = use.findLastIndex((m) => m.images?.length);
	return use.map(({ role, content, images }, i) => !images?.length ? { role, content }
		: i === keep ? { role, content, images } : { role, content: `${content}\n[앞서 보낸 사진 ${images.length}장 생략]`.trim() });
};

async function messagesOf(env, chatId, withImages) {
	const { results } = await env.DB.prepare("SELECT id, role, content, images, sources, status FROM chat_messages WHERE chat_id = ? ORDER BY seq").bind(chatId).all();
	return Promise.all(results.map(async (m) => ({
		id: m.id, role: m.role, content: m.content, status: m.status,
		...(m.sources ? { sources: JSON.parse(m.sources) } : {}),
		...(withImages && m.images ? { images: (await env.STORE.get(imageKey(m.id), "json")) ?? [] } : {}),
	})));
}

async function list(env) {
	const { results } = await env.DB.prepare(`SELECT c.id, c.title, c.updated, EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id AND m.status = 'pending') AS pending
		FROM chats c ORDER BY c.updated DESC LIMIT 100`).all();
	return json({ chats: results.map((c) => ({ ...c, pending: !!c.pending })) });
}

async function get(env, { id }) {
	const chat = await env.DB.prepare("SELECT id, title FROM chats WHERE id = ?").bind(String(id)).first();
	return chat ? json({ ...chat, messages: await messagesOf(env, chat.id, true) }) : json({ error: "not found" }, 404);
}

async function poll(env, { id }) {
	const m = await env.DB.prepare("SELECT content, status, sources, created FROM chat_messages WHERE id = ? AND role = 'assistant'").bind(String(id)).first();
	if (m?.status === "pending" && m.created < now() - STALE_MS) {
		await env.DB.prepare("UPDATE chat_messages SET content = '', status = 'error' WHERE id = ? AND status = 'pending'").bind(String(id)).run();
		Object.assign(m, { content: "", status: "error" });
	}
	return m ? json({ content: m.content, status: m.status, ...(m.sources ? { sources: JSON.parse(m.sources) } : {}) }) : json({ error: "not found" }, 404);
}

async function remove(env, { id }) {
	const { results } = await env.DB.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND images > 0").bind(String(id)).all();
	await Promise.all(results.map((m) => env.STORE.delete(imageKey(m.id))));
	await env.DB.batch([env.DB.prepare("DELETE FROM chat_messages WHERE chat_id = ?").bind(String(id)), env.DB.prepare("DELETE FROM chats WHERE id = ?").bind(String(id))]);
	return json({ ok: true });
}

async function send(env, { chatId, content = "", images = [] }) {
	const text = String(content);
	let chat = chatId ? await env.DB.prepare("SELECT id FROM chats WHERE id = ?").bind(String(chatId)).first() : null;
	if (chatId && !chat) return json({ error: "not found" }, 404);
	if (chat) await env.DB.prepare("UPDATE chat_messages SET content = '', status = 'error' WHERE chat_id = ? AND status = 'pending' AND created < ?").bind(chat.id, now() - STALE_MS).run();
	const history = chat ? await messagesOf(env, chat.id, true) : [];
	if (history.some((m) => m.status === "pending")) return json({ error: "이전 답변을 만드는 중이에요." }, 409);
	if (history.length + 2 > MAX_MESSAGES) return json({ error: "대화가 길어졌어요. 새 대화를 시작해 주세요." }, 400);
	// 저장 전에 튜터 입력 규칙(역할 순서, 글 길이, 사진 형식·크기)을 그대로 검사한다
	try { validateTutor({ messages: forModel([...history, { role: "user", content: text, status: "done", ...(images.length ? { images } : {}) }]) }); }
	catch { return json({ error: "질문이나 사진의 크기·형식을 확인해 주세요." }, 400); }
	const at = now();
	const statements = [];
	if (!chat) {
		chat = { id: crypto.randomUUID() };
		statements.push(env.DB.prepare("INSERT INTO chats (id, title, created, updated) VALUES (?, ?, ?, ?)").bind(chat.id, (text.trim().split("\n")[0] || "사진 질문").slice(0, 40), at, at));
	} else statements.push(env.DB.prepare("UPDATE chats SET updated = ? WHERE id = ?").bind(at, chat.id));
	const userId = crypto.randomUUID(), replyId = crypto.randomUUID();
	if (images.length) await env.STORE.put(imageKey(userId), JSON.stringify(images));
	statements.push(
		env.DB.prepare("INSERT INTO chat_messages (id, chat_id, seq, role, content, images, status, created) VALUES (?, ?, ?, 'user', ?, ?, 'done', ?)").bind(userId, chat.id, history.length, text, images.length, at),
		env.DB.prepare("INSERT INTO chat_messages (id, chat_id, seq, role, content, status, created) VALUES (?, ?, ?, 'assistant', '', 'pending', ?)").bind(replyId, chat.id, history.length + 1, at),
	);
	await env.DB.batch(statements);
	// Anthropic 이 일부 지역 요청을 403 으로 막아 Worker 처럼 미국 동부에 둔다
	try { await env.CHAT.get(env.CHAT.idFromName(replyId), { locationHint: "enam" }).fetch("https://chat/start", { method: "POST", body: replyId }); }
	catch (error) {
		// 답변 작업을 못 띄웠으면 pending 을 남기지 않는다. 남기면 이 대화가 계속 409 로 막힌다
		console.error(error);
		await env.DB.prepare("UPDATE chat_messages SET status = 'error' WHERE id = ?").bind(replyId).run();
		return json({ error: "답변을 시작하지 못했어요. 다시 보내 주세요." }, 502);
	}
	return json({ chatId: chat.id, userId, replyId });
}

/* 답변 하나를 끝까지 만든다. 실패하면 error 로 남겨 앱이 다시 보내기를 안내한다 */
export async function runAnswer(env, replyId) {
	const reply = await env.DB.prepare("SELECT chat_id, seq, status FROM chat_messages WHERE id = ?").bind(replyId).first();
	if (!reply || reply.status !== "pending") return;
	const update = (content, status = "pending", sources = null) =>
		env.DB.prepare("UPDATE chat_messages SET content = ?, status = ?, sources = COALESCE(?, sources) WHERE id = ?").bind(content, status, sources, replyId).run();
	try {
		const history = (await messagesOf(env, reply.chat_id, true)).slice(0, reply.seq);
		const result = await tutorReply(env, validateTutor({ messages: forModel(history) }));
		if (result.unclear) return void (await update(result.unclear, "done"));
		const sources = JSON.stringify(result.sources);
		let text = "", flushed = 0;
		for await (const event of result.stream) {
			if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
			text += event.delta.text;
			if (now() - flushed > FLUSH_MS) { flushed = now(); await update(text, "pending", sources); }
		}
		const stop = (await result.stream.finalMessage()).stop_reason;
		if (!text || !["end_turn", "max_tokens"].includes(stop)) throw new Error("incomplete reply");
		await update(stop === "max_tokens" ? text + CUT_NOTE : text, "done", sources);
	} catch (error) {
		console.error(error);
		await update("", "error");
	}
	await env.DB.prepare("UPDATE chats SET updated = ? WHERE id = ?").bind(now(), reply.chat_id).run();
}

/* 답변 하나당 인스턴스 하나. 알람은 앱 요청과 떨어져 최대 15분 돌 수 있어 앱을 닫아도 답변이 끝까지 만들어진다 */
export class ChatRunner {
	constructor(ctx, env) { this.ctx = ctx; this.env = env; }
	async fetch(request) {
		await this.ctx.storage.put("replyId", await request.text());
		await this.ctx.storage.setAlarm(Date.now());
		return new Response("ok");
	}
	async alarm() {
		const replyId = await this.ctx.storage.get("replyId");
		if (replyId) await runAnswer(this.env, replyId);
		await this.ctx.storage.deleteAll();
	}
}

export const CHAT_ROUTES = { "/api/chats/list": list, "/api/chats/get": get, "/api/chats/poll": poll, "/api/chats/send": send, "/api/chats/delete": remove };
export async function chats(request, env) {
	const route = CHAT_ROUTES[new URL(request.url).pathname];
	let body;
	try { body = await request.json(); } catch { body = {}; }
	return route(env, body ?? {});
}
