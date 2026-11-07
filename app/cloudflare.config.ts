import { bindings, defineConfig } from "cf/config";
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
		env: {
			GOOGLE_CLIENT_ID: bindings.secret(),
			GOOGLE_CLIENT_SECRET: bindings.secret(),
			ALLOWED_EMAIL: bindings.secret(),
			ADDITIONAL_ALLOWED_EMAIL: bindings.text("tpals0409dev@gmail.com"),
			AUTH_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 10, period: 60 } }),
			ANTHROPIC_API_KEY: bindings.secret(),
			LAW_OC: bindings.secret(),
			TUTOR_LIMIT: bindings.rateLimit({ namespace: "1002", simple: { limit: 10, period: 60 } }),
			STORE: bindings.kv(),
			DB: bindings.d1({ id: "f4043927-ef1d-477e-b86f-c5b024cefb32", name: "hapgyeok-note" }),
		},
	},
}));
