import assert from "node:assert/strict";
import { authenticated, authRoute } from "./auth.js";

const ORIGIN = "https://note.leo0409.work";
const kv = new Map();
let allowed = true;
const env = {
	GOOGLE_CLIENT_ID: "client",
	GOOGLE_CLIENT_SECRET: "secret",
	ALLOWED_EMAIL: "Nahee@example.com",
	ADDITIONAL_ALLOWED_EMAIL: "tpals0409dev@gmail.com",
	AUTH_LIMIT: { limit: async () => ({ success: allowed }) },
	STORE: {
		get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
		put: async (k, v) => void kv.set(k, v),
		delete: async (k) => void kv.delete(k),
		list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
	},
};

const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
const b64 = (data) => Buffer.from(data).toString("base64url");
async function idToken(claims, key = privateKey, alg = "RS256") {
	const head = `${b64(JSON.stringify({ alg, kid: "k1" }))}.${b64(JSON.stringify(claims))}`;
	return `${head}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head)))}`;
}

let tokenRequest;
let tokenResponse;
globalThis.fetch = async (url, init) => {
	if (String(url).includes("/certs")) return Response.json({ keys: [jwk] });
	tokenRequest = new URLSearchParams(init.body);
	return tokenResponse;
};
console.log = () => {};

const get = (path, cookie = "") => authRoute(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), env);
const claimsFor = (nonce, extra = {}) => ({ iss: "https://accounts.google.com", aud: "client", exp: Math.floor(Date.now() / 1000) + 300, nonce, sub: "owner-sub", email: "nahee@example.com", email_verified: true, ...extra });

async function begin() {
	const res = await get("/api/auth/google");
	assert.equal(res.status, 302);
	const query = new URL(res.headers.get("location")).searchParams;
	return { query, cookie: res.headers.get("set-cookie").split(";")[0], raw: res.headers.get("set-cookie") };
}

async function finish(extra = {}, key = privateKey, alg = "RS256") {
	const { query, cookie } = await begin();
	tokenResponse = Response.json({ id_token: await idToken(claimsFor(query.get("nonce"), extra), key, alg) });
	const res = await get(`/api/auth/google/callback?code=c&state=${query.get("state")}`, cookie);
	return { res, location: res.headers.get("location"), session: res.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1] };
}

// 시작 요청: PKCE, state, nonce, 최소 scope, 안전한 쿠키
{
	const { query, raw } = await begin();
	assert.equal(query.get("code_challenge_method"), "S256");
	assert.equal(query.get("scope"), "openid email");
	assert.equal(query.get("redirect_uri"), `${ORIGIN}/api/auth/google/callback`);
	assert.match(raw, /HttpOnly/);
	assert.match(raw, /Secure/);
	assert.match(raw, /SameSite=Lax/);
}

// 요청 제한과 허용되지 않은 호스트
allowed = false;
assert.equal((await get("/api/auth/google")).status, 429);
allowed = true;
assert.equal((await authRoute(new Request("https://evil.example/api/auth/google"), env)).status, 404);

// 다른 브라우저의 콜백, 없는 state, 재사용을 거부한다
{
	const { query, cookie } = await begin();
	const state = query.get("state");
	assert.match((await get(`/api/auth/google/callback?code=c&state=${state}`, "oauth_tx=other")).headers.get("location"), /login=failed/);
	assert.match((await get(`/api/auth/google/callback?code=c&state=${state}`, cookie)).headers.get("location"), /login=failed/);
	assert.match((await get("/api/auth/google/callback?code=c&state=none", cookie)).headers.get("location"), /login=failed/);
}

// ID 토큰 검증
assert.match((await finish({}, other.privateKey)).location, /login=failed/);
assert.match((await finish({ aud: "someone" })).location, /login=failed/);
assert.match((await finish({ iss: "https://evil.example" })).location, /login=failed/);
assert.match((await finish({ exp: 1 })).location, /login=failed/);
assert.match((await finish({ nonce: "wrong" })).location, /login=failed/);

// 허용 이메일이 아니거나 미검증이면 거부하고, 소유자를 고정하지 않는다
assert.match((await finish({ email: "other@example.com" })).location, /login=denied/);
assert.match((await finish({ email_verified: false })).location, /login=denied/);
assert.equal(kv.has("owner"), false);

// 추가 계정의 선행 로그인은 기존 소유자를 차지하지 않는다.
const tester = { sub: "tester-sub", email: "TPALS0409DEV@gmail.com" };
assert.match((await finish({ ...tester, email_verified: false })).location, /login=denied/);
assert.equal((await finish(tester)).location, "/?login=ok");
assert.equal(kv.has("owner"), false);

// 성공하면 서버 세션이 생기고, PKCE verifier 와 비밀키는 서버에서 보낸다
const first = await finish();
assert.equal(first.location, "/?login=ok");
assert.equal(tokenRequest.get("client_secret"), "secret");
assert.ok(tokenRequest.get("code_verifier"));
assert.match(first.res.headers.getSetCookie().find((c) => c.startsWith("session=")), /HttpOnly; SameSite=Lax; Secure/);
const withSession = (s) => new Request(`${ORIGIN}/api/sync`, { method: "POST", headers: { cookie: `session=${s}` } });
assert.equal(await authenticated(withSession(first.session), env), true);
assert.equal(await authenticated(withSession("forged"), env), false);
assert.ok(![...kv.keys()].some((k) => k.includes(first.session)), "세션 원문을 저장하지 않는다");

// 이후에는 이메일이 아니라 Google 계정 고유값으로 판단한다
assert.match((await finish({ sub: "attacker" })).location, /login=denied/);
assert.equal((await finish({ email: "changed@example.com" })).location, "/?login=ok");
assert.equal((await finish(tester)).location, "/?login=ok");
assert.equal((await finish({ ...tester, email: "tester-changed@example.com" })).location, "/?login=ok");
assert.match((await finish({ ...tester, sub: "other-tester" })).location, /login=denied/);
assert.match((await finish({ sub: "stranger", email: "stranger@example.com" })).location, /login=denied/);
assert.equal(kv.get("owner"), "https://accounts.google.com|owner-sub");

// 유휴·절대 만료
{
	const { session } = await finish();
	const key = [...kv.keys()].filter((k) => k.startsWith("session:")).at(-1);
	const old = Math.floor(Date.now() / 1000) - 91 * 86400;
	kv.set(key, JSON.stringify({ created: old, seen: Math.floor(Date.now() / 1000) }));
	assert.equal(await authenticated(withSession(session), env), false);
	assert.equal(kv.has(key), false);
}

// 로그아웃은 서버 세션을 없애고, 다른 출처의 요청은 막는다
{
	const { session } = await finish();
	const logout = (origin) => authRoute(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin, cookie: `session=${session}` } }), env);
	assert.equal((await logout("https://evil.example")).status, 403);
	assert.equal(await authenticated(withSession(session), env), true);
	assert.equal((await logout(ORIGIN)).status, 204);
	assert.equal(await authenticated(withSession(session), env), false);
}

// 모든 기기 로그아웃
{
	const a = (await finish()).session;
	const b = (await finish()).session;
	const res = await authRoute(new Request(`${ORIGIN}/api/auth/logout-all`, { method: "POST", headers: { origin: ORIGIN } }), env);
	assert.equal(res.status, 204);
	assert.equal(await authenticated(withSession(a), env), false);
	assert.equal(await authenticated(withSession(b), env), false);
}

process.stdout.write("auth ok\n");
