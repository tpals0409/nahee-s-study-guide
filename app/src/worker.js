import Anthropic from "@anthropic-ai/sdk";
import { tutor } from "./tutor.js";
import { authenticated, authRoute, sameOrigin } from "./auth.js";
import { syncState } from "./store.js";

const MODEL = "claude-opus-5-5";
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
// ponytail: 그림은 공개 주소를 Claude가 직접 받는다. 사이트를 잠그면 base64로 바꿔야 한다
const SITE = "https://note.leo0409.work";

const SYSTEM = `당신은 변리사 1차 시험 과외 선생님입니다. 학습자 나희에게 기출문제를 설명합니다.
- 말투는 다정한 존댓말이고, 근거가 되는 법 조문이나 판례, 과학 개념을 짧게 밝힙니다.
- 확실하지 않은 조문 번호나 판례를 지어내지 말고, 모르면 모른다고 씁니다.
- 공식 정답을 기준으로 설명합니다. 출제 후 법 개정으로 지금은 답이 달라질 수 있으면 그 내용을 따로 밝힙니다.
- 그림은 원본 시험지입니다. 글과 다르면 그림을 따릅니다.`;
const CHAT_SYSTEM = `${SYSTEM}
- 보기 번호는 나희 화면 기준입니다. 보기를 가리킬 때는 번호와 내용을 함께 씁니다.
- 이전 대화의 번호는 그때 화면 기준이라 지금과 다를 수 있습니다.
- 화면에 글자 그대로 나오므로 마크다운 기호 없이 짧은 문단으로 씁니다.`;

const describe = (q, order) => {
	const choices = order.map((orig, pos) => `${pos + 1}. ${q.choices[orig]}`).join("\n");
	const answer = q.answer.map((a) => order.indexOf(a - 1) + 1).sort().join(", ");
	return `${q.year}년 ${q.subject}\n문제: ${q.stem}\n보기:\n${choices}\n공식 정답: ${answer}번`;
};

const withImages = (q, text) => [
	...q.images.map((src) => ({ type: "image", source: { type: "url", url: `${SITE}/${src}` } })),
	{ type: "text", text },
];

// 해설은 원본 순서로 저장돼 있어서 화면 순서로 바꿔 넘긴다
function chatContext(q, explanation, order, pick) {
	const notes = order.map((orig, pos) => `${pos + 1}번: ${explanation.choices[orig]}`).join("\n");
	const lawNote = explanation.lawNote ? `\n개정 참고: ${explanation.lawNote}` : "";
	const quotes = (explanation.basis ?? []).filter((b) => b.quote).map((b) => `${b.source} ${b.kind === "article" ? `제${b.ref}조` : ""}: ${b.quote}`);
	const basis = quotes.length ? `\n\n시험 당시 본문으로 확인한 근거\n${[...new Set(quotes)].join("\n")}` : "";
	return `${describe(q, order)}\n나희가 고른 답: ${order.indexOf(pick) + 1}번\n\n앞서 드린 해설\n요약: ${explanation.summary}\n${notes}${lawNote}${basis}`;
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const anthropic = (env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/* 답변 글자만 흘려보낸다. 도중에 실패하면 스트림 오류로 앱에 알린다. */
function streamReply(env, params) {
	const stream = anthropic(env).beta.messages.stream({ model: MODEL, max_tokens: 16000, system: CHAT_SYSTEM, ...FALLBACK, ...params });
	const encoder = new TextEncoder();
	const body = new ReadableStream({
		async start(controller) {
			try {
				for await (const event of stream) {
					if (event.type === "content_block_delta" && event.delta.type === "text_delta") controller.enqueue(encoder.encode(event.delta.text));
				}
				if ((await stream.finalMessage()).stop_reason === "refusal") throw new Error("refusal");
				controller.close();
			} catch (error) {
				console.error(error);
				controller.error(error);
			}
		},
		cancel: () => stream.abort(),
	});
	return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function sync(request, env) {
	return json(await syncState(env.DB, await request.json()));
}

async function explain(request, env) {
	const { id } = await request.json();
	const row = await env.DB.prepare("SELECT body FROM explanations WHERE id = ?").bind(id).first();
	return row ? json(JSON.parse(row.body)) : json({ error: "not found" }, 404);
}

async function followUp(request, env) {
	const { question, explanation, messages, order, pick } = await request.json();
	const context = withImages(question, chatContext(question, explanation, order, pick));
	return streamReply(env, {
		messages: [{ role: "user", content: context }, { role: "assistant", content: "네, 이 문제에서 궁금한 점을 물어보세요." }, ...messages],
		output_config: { effort: "medium" },
	});
}

const ROUTES = { "/api/sync": sync, "/api/explain": explain, "/api/ask": followUp, "/api/tutor": tutor };

const HSTS = "max-age=31536000";
const MAX_BODY = 4_000_000;

async function handle(request, env) {
	try {
		const auth = await authRoute(request, env);
		if (auth) return auth;
		const route = ROUTES[new URL(request.url).pathname];
		if (!route || request.method !== "POST") return json({ error: "not found" }, 404);
		if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
		if (Number(request.headers.get("content-length")) > MAX_BODY) return json({ error: "too large" }, 413);
		if (!(await authenticated(request, env))) return json({ error: "unauthorized" }, 401);
		if (route === tutor && env.TUTOR_LIMIT && !(await env.TUTOR_LIMIT.limit({key:request.headers.get("cf-connecting-ip") ?? "shared"})).success) return json({error:"잠시 후 다시 질문해 주세요."},429);
		return await route(request, env);
	} catch (error) {
		console.error(error);
		return json({ error: "failed" }, 502);
	}
}

export default {
	async fetch(request, env) {
		const response = await handle(request, env);
		if (new URL(request.url).protocol !== "https:") return response;
		const secured = new Response(response.body, response);
		secured.headers.set("strict-transport-security", HSTS);
		return secured;
	},
};
