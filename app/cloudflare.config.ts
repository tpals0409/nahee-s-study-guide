import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker.js" with { type: "cf-worker" };

export default defineConfig(() => ({
	worker: {
		name: "hapgyeok-note",
		compatibilityDate: "2026-10-01",
		entrypoint,
		domains: ["note.leo0409.work"],
		workersDev: false,
		// Anthropic 이 일부 지역 서버의 요청을 403 으로 막아서 실행 위치를 미국으로 고정한다
		placement: { region: "aws:us-east-1" },
		assets: { runWorkerFirst: ["/api/*"] },
		// 홈 AI 질문 답변을 앱 요청과 떨어져 끝까지 만드는 곳(src/chats.js)
		exports: { ChatRunner: exports.durableObject({ storage: "sqlite" }) },
		env: {
			GOOGLE_CLIENT_ID: bindings.secret(),
			GOOGLE_CLIENT_SECRET: bindings.secret(),
			ALLOWED_EMAIL: bindings.secret(),
			ADDITIONAL_ALLOWED_EMAIL: bindings.text("tpals0409dev@gmail.com"),
			AUTH_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 10, period: 60 } }),
			ANTHROPIC_API_KEY: bindings.secret(),
			TUTOR_LIMIT: bindings.rateLimit({ namespace: "1002", simple: { limit: 10, period: 60 } }),
			STORE: bindings.kv(),
			CHAT: bindings.durableObject({ worker: "hapgyeok-note", exportName: "ChatRunner" }),
			DB: bindings.d1({ id: "f4043927-ef1d-477e-b86f-c5b024cefb32", name: "hapgyeok-note" }),
		},
	},
}));
