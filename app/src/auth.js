// Google 로그인과 서버 세션. 항목 번호는 UI GuideBook 로그인 보안 체크리스트를 가리킨다.
const ORIGINS = new Set(["https://note.leo0409.work", "http://localhost:5173"]);
const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const DAY = 86400;
const TX_TTL = 600;
const SESSION_IDLE = 30 * DAY;
const SESSION_MAX = 90 * DAY;
const CALLBACK = "/api/auth/google/callback";

const enc = new TextEncoder();
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (text) => base64url(await crypto.subtle.digest("SHA-256", enc.encode(text)));
const now = () => Math.floor(Date.now() / 1000);

/** 인증 사건 기록. 토큰과 코드는 넣지 않는다. */
const audit = (event, request, result) => console.log(JSON.stringify({ auth: event, result, ip: request.headers.get("cf-connecting-ip"), at: new Date().toISOString() }));

function readCookie(request, name) {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, value] = part.trim().split("=");
		if (key === name) return value;
	}
	return null;
}

function cookie(request, name, value, maxAge, path = "/") {
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function redirect(location, cookies = []) {
	const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
	for (const c of cookies) headers.append("set-cookie", c);
	return new Response(null, { status: 302, headers });
}

const redirectUri = (url) => `${url.origin}${CALLBACK}`;
const allowedOrigin = (url) => ORIGINS.has(url.origin);

/** 쿠키 인증의 CSRF 방어: 상태를 바꾸는 요청은 같은 출처에서만 받는다. */
export function sameOrigin(request) {
	const url = new URL(request.url);
	return allowedOrigin(url) && request.headers.get("origin") === url.origin;
}

async function limited(request, env) {
	const { success } = await env.AUTH_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
	return !success;
}

async function start(request, env) {
	const url = new URL(request.url);
	if (!allowedOrigin(url)) return new Response("not found", { status: 404 });
	if (await limited(request, env)) return new Response("too many requests", { status: 429 });
	const [state, nonce, verifier, browser] = [randomToken(), randomToken(), randomToken(), randomToken()];
	await env.STORE.put(`oauth:${state}`, JSON.stringify({ nonce, verifier, browser: await sha256(browser) }), { expirationTtl: TX_TTL });
	const query = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri(url),
		response_type: "code",
		scope: "openid email",
		state,
		nonce,
		code_challenge: await sha256(verifier),
		code_challenge_method: "S256",
		prompt: "select_account",
	});
	return redirect(`${AUTHORIZE}?${query}`, [cookie(request, "oauth_tx", browser, TX_TTL, "/api/auth")]);
}

async function verifyIdToken(idToken, env, nonce) {
	const [head, body, signature] = idToken.split(".");
	const header = JSON.parse(new TextDecoder().decode(fromBase64url(head)));
	if (header.alg !== "RS256") throw new Error("id token alg");
	const { keys } = await (await fetch(CERTS)).json();
	const jwk = keys.find((k) => k.kid === header.kid);
	if (!jwk) throw new Error("id token key");
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(signature), enc.encode(`${head}.${body}`)))) throw new Error("id token signature");
	const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
	const valid = ISSUERS.has(claims.iss) && claims.aud === env.GOOGLE_CLIENT_ID && claims.exp > now() && claims.nonce === nonce && (!claims.azp || claims.azp === env.GOOGLE_CLIENT_ID);
	if (!valid) throw new Error("id token claims");
	return claims;
}

/** 첫 로그인은 허용 이메일로 확인해 Google 계정 고유값을 고정하고, 이후에는 그 고유값만 본다. */
async function isOwner(claims, env) {
	const account = `https://accounts.google.com|${claims.sub}`;
	const owner = await env.STORE.get("owner");
	if (owner) return owner === account;
	const allowed = claims.email_verified === true && claims.email?.toLowerCase() === env.ALLOWED_EMAIL.trim().toLowerCase();
	if (allowed) await env.STORE.put("owner", account);
	return allowed;
}

export async function createSession(env) {
	const token = randomToken();
	const at = now();
	await env.STORE.put(`session:${await sha256(token)}`, JSON.stringify({ created: at, seen: at }), { expirationTtl: SESSION_IDLE });
	return token;
}

async function callback(request, env) {
	const url = new URL(request.url);
	const clear = cookie(request, "oauth_tx", "", 0, "/api/auth");
	const fail = (reason, result = "failed") => {
		audit("login", request, reason);
		return redirect(`/?login=${result}`, [clear]);
	};
	if (!allowedOrigin(url)) return new Response("not found", { status: 404 });
	if (await limited(request, env)) return new Response("too many requests", { status: 429 });
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const browser = readCookie(request, "oauth_tx");
	if (!state || !code || !browser) return fail("missing");
	const tx = await env.STORE.get(`oauth:${state}`, "json");
	if (!tx) return fail("state");
	await env.STORE.delete(`oauth:${state}`);
	if (tx.browser !== (await sha256(browser))) return fail("browser");
	try {
		const res = await fetch(TOKEN, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: env.GOOGLE_CLIENT_ID,
				client_secret: env.GOOGLE_CLIENT_SECRET,
				redirect_uri: redirectUri(url),
				grant_type: "authorization_code",
				code_verifier: tx.verifier,
			}),
		});
		if (!res.ok) return fail("token");
		const claims = await verifyIdToken((await res.json()).id_token, env, tx.nonce);
		if (!(await isOwner(claims, env))) return fail("denied", "denied");
		const token = await createSession(env);
		audit("login", request, "ok");
		return redirect("/?login=ok", [clear, cookie(request, "session", token, SESSION_IDLE)]);
	} catch (error) {
		return fail(error.message);
	}
}

/** 세션이 유효하면 true. 저장소 오류는 그대로 던져 접근을 막는다. */
export async function authenticated(request, env) {
	const token = readCookie(request, "session");
	if (!token) return false;
	const key = `session:${await sha256(token)}`;
	const session = await env.STORE.get(key, "json");
	if (!session) return false;
	const at = now();
	if (at - session.created > SESSION_MAX || at - session.seen > SESSION_IDLE) {
		await env.STORE.delete(key);
		return false;
	}
	if (at - session.seen > DAY) await env.STORE.put(key, JSON.stringify({ ...session, seen: at }), { expirationTtl: SESSION_IDLE });
	return true;
}

async function logout(request, env) {
	const token = readCookie(request, "session");
	if (token) await env.STORE.delete(`session:${await sha256(token)}`);
	audit("logout", request, "ok");
	return new Response(null, { status: 204, headers: { "set-cookie": cookie(request, "session", "", 0), "cache-control": "no-store" } });
}

async function logoutAll(request, env) {
	const { keys } = await env.STORE.list({ prefix: "session:" });
	await Promise.all(keys.map(({ name }) => env.STORE.delete(name)));
	audit("logout-all", request, "ok");
	return new Response(null, { status: 204, headers: { "set-cookie": cookie(request, "session", "", 0), "cache-control": "no-store" } });
}

/** 인증 경로면 응답을, 아니면 null 을 돌려준다. */
export function authRoute(request, env) {
	const { pathname } = new URL(request.url);
	if (request.method === "GET" && pathname === "/api/auth/google") return start(request, env);
	if (request.method === "GET" && pathname === CALLBACK) return callback(request, env);
	if (request.method === "POST" && (pathname === "/api/auth/logout" || pathname === "/api/auth/logout-all")) {
		if (!sameOrigin(request)) return new Response("forbidden", { status: 403 });
		return pathname.endsWith("all") ? logoutAll(request, env) : logout(request, env);
	}
	return null;
}
