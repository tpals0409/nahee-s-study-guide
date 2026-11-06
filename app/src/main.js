import {
	basisHtml, esc,
	DAILY_SIZE, MOCK_MINUTES, SUBJECTS, addDays, choiceOrder, dayComplete, dayIds, dayKey, emptyState, isCorrect,
	merge, pickDaily, progress, reviewIds, shuffle, solvedOn, streak, weekStart, dailyAccuracy,
} from "./logic.js";

const app = document.getElementById("app");
const NUM = "①②③④⑤";
const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
const ICONS = {
	logout: '<path d="M9 4H4v16h5M10 12h10m-4-4 4 4-4 4"/>',
	home: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
	layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
	bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
	chart: '<path d="M4 20v-7h4v7M10 20V9h4v11M16 20V4h4v16"/>',
	note: '<rect x="5" y="3" width="15" height="18" rx="3"/><path d="M3 8h4M3 12h4M3 16h4M11 8h5M11 12h5"/>',
	arrow: '<path d="M4 12h16M14 6l6 6-6 6"/>',
	close: '<path pathLength="1" d="M6 6l12 12M18 6 6 18"/>',
	check: '<path pathLength="1" d="m5 12 5 5 9-10"/>',
	left: '<path d="m15 6-6 6 6 6"/>',
	right: '<path d="m9 6 6 6-6 6"/>',
};
const icon = (name, color = "") => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" ${color && `style="color:${color}"`}>${ICONS[name]}</svg>`;
/* 원 → 표시 → 글줄 순서로 그려진 뒤 안쪽이 채워진다. 움직임을 끄면 다 그려진 상태로 보인다. */
function drawMark({ lines = false, wrong = false } = {}) {
	const sign = wrong ? "M33 33l30 30M63 33 33 63" : "M29 50l13 13 25-29";
	return `<svg class="mark" viewBox="0 0 96 ${lines ? 134 : 96}" aria-hidden="true">
		<circle class="m-ring" pathLength="1" cx="48" cy="48" r="42"/>
		<path class="m-sign" pathLength="1" d="${sign}"/>
		${lines ? '<path class="m-line" pathLength="1" d="M16 114h64"/><path class="m-line2" pathLength="1" d="M30 128h36"/>' : ""}
	</svg>`;
}
const pct = (ok, total) => (total ? Math.round((ok / total) * 100) : null);
const shortDay = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일`;

function read(key, fallback) {
	try {
		return JSON.parse(localStorage.getItem(key)) ?? fallback;
	} catch {
		return fallback;
	}
}
const write = (key, value) => {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// 저장 공간이 없어도 서버 동기화로 기록은 남는다
	}
};

let state = read("state", emptyState());
let signedIn = read("signedIn", false);
let questions = [];
let byId = new Map();
let session = null;
let calendarMonth = null;
let selectedExamYear = null;

let lastTab = null;
const scrolls = {};
const visited = new Set();
const tabPaths = {};

const today = () => dayKey(Date.now());

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* 선택 표시가 이전 자리에서 미끄러져 온다. Tween UI 의 Sliding Tabs 방식을 React 없이 옮겼다. */
const pillBoxes = {};

function placePill(key, root) {
	const pill = root?.querySelector(".pill");
	const on = root?.querySelector('[aria-current], [aria-pressed="true"]');
	if (!pill || !on) return;
	const to = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
	const put = (b) => Object.assign(pill.style, { width: `${b.w}px`, height: `${b.h}px`, transform: `translate(${b.x}px, ${b.y}px)` });
	const from = pillBoxes[key];
	pillBoxes[key] = to;
	if (!from) {
		put(to);
		pill.classList.add("appear");
		return;
	}
	put(from);
	pill.getBoundingClientRect();
	pill.classList.add("slide");
	put(to);
}

const placePills = () => {
	placePill("nav", document.querySelector(".nav"));
};

/* 숫자가 빠르게 올라가다 천천히 멈춘다. 화면 낭독기는 aria-label 의 최종 값을 읽는다. */
const num = (n, unit = "") => `<span role="img" aria-label="${n}${unit}"><span data-count="${n}">${n}</span>${unit}</span>`;

function countUp() {
	if (calm()) return;
	for (const el of document.querySelectorAll("[data-count]")) {
		const end = Number(el.dataset.count);
		const started = performance.now();
		const step = (now) => {
			const t = Math.min(1, (now - started) / 800);
			el.textContent = Math.round(end * (1 - (1 - t) ** 3));
			if (t < 1 && el.isConnected) requestAnimationFrame(step);
		};
		if (end > 0) requestAnimationFrame(step);
	}
}

/* 기기에 남기는 것은 로그인 여부 표시뿐이고 인증은 서버 쿠키가 맡는다. */
function signOut(message = "") {
	signedIn = false;
	session = null;
	write("signedIn", false);
	write("session", null);
	loginScreen(message);
}

async function post(path, body) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (res.status === 401) signOut();
	if (!res.ok) throw Object.assign(new Error(path), { status: res.status });
	return res;
}

const api = async (path, body) => (await post(path, body)).json();

/* 아직 서버 번호(r)가 없는 풀이와 최근 배정만 보내고, 서버가 준 변경분을 합친다. */
async function sync() {
	const recent = Object.keys(state.days).sort().slice(-3);
	const res = await api("/api/sync", {
		log: state.log.filter((e) => !e.r),
		days: Object.fromEntries(recent.map((k) => [k, state.days[k]])),
		flags: state.flags,
		cursor: state.cursor ?? 0,
		epoch: state.epoch ?? 1,
	});
	if (res.reset) {
		state = { ...emptyState(), epoch: res.epoch };
		return sync();
	}
	state = { ...merge(state, res), cursor: res.cursor, epoch: res.epoch };
	write("state", state);
}

let syncTimer;
function save() {
	write("state", state);
	clearTimeout(syncTimer);
	syncTimer = setTimeout(() => sync().catch(() => {}), 1000);
}

function ensureToday() {
	const day = today();
	if (state.days[day]) return;
	state.days[day] = { ids: pickDaily(questions, state.log, state.flags, DAILY_SIZE, day), c: Date.now() };
	save();
}

/* 틀 */
const TABS = [
	["home", "홈", "home"],
	["exam", "기출 모의고사", "layers"],
	["notes", "오답노트", "bookmark"],
	["stats", "학습 기록", "chart"],
];

const tabOf = (hash) => hash.slice(1).split("/")[0] || "home";

/* 첫 방문은 카드가 차례로 뜨고, 다시 온 탭은 바로 보인다. 같은 탭 안에서는 깊이에 따라 좌우로 밀린다. */
function pageMotion(key) {
	if (key === lastTab) return "";
	if (lastTab && tabOf(lastTab) === tabOf(key)) return key.split("/").length > lastTab.split("/").length ? "enter push" : "enter back";
	return visited.has(key) ? "again" : "enter";
}

function shell(tab, body) {
	const key = location.hash || "#home";
	const motion = pageMotion(key);
	if (lastTab && motion) scrolls[lastTab] = scrollY;
	lastTab = key;
	visited.add(key);
	tabPaths[tab] = key;
	app.innerHTML = `<div class="shell ${motion}">
		<nav class="nav" aria-label="주요 메뉴">
			<span class="pill" aria-hidden="true"></span>
			<div class="brand">${icon("note")}<span>나희의<br>합격노트</span></div>
			${TABS.map(([id, label, ic]) => `<a href="#${id}" data-tab="${id}" ${id === tab ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`).join("")}
			<button class="nav-logout" data-act="logout">${icon("logout")}<span>로그아웃</span></button>
		</nav>
		<main class="main"><div class="brand topbrand">${icon("note")}<span>나희의 합격노트</span></div>${body}</main>
	</div>`;
	placePills();
	if (!motion) return;
	scrollTo(0, motion.includes("push") ? 0 : scrolls[key] ?? 0);
	if (motion === "enter") countUp();
}

function weekDots(day) {
	const start = weekStart(day);
	return `<div class="week">${WEEKDAYS.map((w, i) => {
		const d = addDays(start, i);
		const on = dayComplete(state, d);
		return `<div><span aria-hidden="true">${w}</span><div class="dot ${on ? "on" : ""}" role="img" aria-label="${w}요일 ${on ? "완료" : "미완료"}">${on ? icon("check") : ""}</div></div>`;
	}).join("")}</div>`;
}

const extraReview = () => {
	const day = today();
	const solved = solvedOn(state.log, day);
	const waiting = new Set(state.days[day] && dayIds(state.days[day]).filter((id) => !solved.has(id)));
	return reviewIds(questions, progress(state.log), state.flags, day).filter((id) => !waiting.has(id));
};

function home() {
	ensureToday();
	const day = today();
	const ids = dayIds(state.days[day]);
	const solved = solvedOn(state.log, day);
	const done = ids.filter((id) => solved.has(id)).length;
	const review = extraReview();
	const finished = done === ids.length;
	shell("home", `<h1>오늘의 학습</h1>
	<div class="home">
		<section class="card hero">
			<div class="row"><h2>오늘의 기출</h2><strong>${num(done)} / ${ids.length}</strong></div>
			<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${ids.length}" aria-valuenow="${done}" aria-label="오늘 푼 문제"><i style="width:${(done / ids.length) * 100}%"></i></div>
			${finished ? `<p class="row" style="justify-content:flex-start">${drawMark()}오늘 문제 완료</p><button class="btn white" data-act="more"><span>추가 풀이</span>${icon("arrow")}</button>` : `<button class="btn white" data-act="daily"><span>${done ? "이어서 풀기" : "시작"}</span>${icon("arrow")}</button>`}
		</section>
		<section class="card">
			<h2>학습 기록</h2>
			<span class="badge">연속 ${num(streak(state, day), "일")}</span>
			${weekDots(day)}
		</section>
		<section class="card wide">
			${review.length
				? `<button class="link" data-act="review"><span class="row" style="gap:16px">${icon("bookmark", "var(--accent)")}<h2>오답 랜덤 풀기</h2></span>${icon("arrow")}</button>`
				: `<div class="row" style="justify-content:flex-start;gap:16px">${icon("bookmark", "var(--accent)")}<span><h2>오답 랜덤 풀기</h2><span class="muted">오답 없음</span></span></div>`}
		</section>
	</div>`);
}

function exam() {
	const rounds = new Map();
	for (const q of questions) {
		const r = rounds.get(q.year) ?? { round: q.round, n: {} };
		r.n[q.subject] = (r.n[q.subject] ?? 0) + 1;
		rounds.set(q.year, r);
	}
	const years = [...rounds.keys()].sort((a, b) => b - a);
	if (!rounds.has(selectedExamYear)) selectedExamYear = years[0];
	const selected = rounds.get(selectedExamYear);
	if (!selected) return shell("exam", '<h1>기출 모의고사</h1><section class="card">등록된 회차 없음</section>');
	shell("exam", `<h1>기출 모의고사</h1>
	<section class="card">
		<h2 id="round-label">연도·회차 선택</h2>
		<div class="round-select" id="round-select">
			<button class="round-trigger" id="round-trigger" data-act="round-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="round-sheet" aria-labelledby="round-label round-value">
				<span id="round-value">${selectedExamYear}년 제${selected.round}회</span><span class="round-chevron" aria-hidden="true">${icon("right")}</span>
			</button>
			<dialog class="round-sheet" id="round-sheet" aria-labelledby="round-sheet-title">
				<div class="round-grab" id="round-grab" aria-hidden="true"><span></span></div>
				<header class="round-sheet-header"><h2 id="round-sheet-title">회차 선택</h2><button class="iconbtn" data-act="round-close" aria-label="회차 선택 닫기">${icon("close")}</button></header>
				<div class="round-options" id="round-options">
					${years.map((year) => `<button class="round-option" aria-pressed="${year === selectedExamYear}" data-act="round-select" data-year="${year}"><span>${year}년 제${rounds.get(year).round}회</span><span aria-hidden="true">${year === selectedExamYear ? "✓" : ""}</span></button>`).join("")}
				</div>
			</dialog>
		</div>
		<div class="list">${SUBJECTS.filter((subject) => selected.n[subject]).map((subject) => `<button class="link" data-act="round" data-year="${selectedExamYear}" data-subject="${subject}"><span><strong>${subject}</strong><br><span class="small muted">${selected.n[subject]}문제 · ${MOCK_MINUTES[subject]}분</span></span><span>시작 ${icon("right")}</span></button>`).join("")}</div>
	</section>`);
}

function setRoundOpen(open, restoreFocus = false) {
	const trigger = document.getElementById("round-trigger");
	const sheet = document.getElementById("round-sheet");
	if (!trigger || !sheet) return;
	trigger.setAttribute("aria-expanded", String(open));
	if (open) {
		if (!sheet.open) sheet.showModal();
		const selected = sheet.querySelector('[aria-pressed="true"]');
		selected?.focus({ preventScroll: true });
		selected?.scrollIntoView({ block: "nearest" });
	} else {
		if (sheet.open) sheet.close();
		if (restoreFocus) trigger.focus({ preventScroll: true });
	}
}


const notesLink = (...path) => `#notes/${path.map(encodeURIComponent).join("/")}`;

function notesItem(q, sub) {
	return `<button class="link" data-act="single" data-id="${esc(q.id)}"><span><span class="small muted">${q.year}년 · ${sub}</span><br>${esc(q.stem.slice(0, 60))}${q.stem.length > 60 ? "…" : ""}</span>${icon("right")}</button>`;
}

const reviewStage = (p) => `복습 ${p.stage + 1}/4 · ${shortDay(p.due)}`;

function notes(path = []) {
	const prog = progress(state.log);
	const active = [...prog.entries()]
		.filter(([id, p]) => p.due && byId.has(id) && !state.flags[id]?.on)
		.map(([id, p]) => ({ q: byId.get(id), p }));
	const flagged = Object.entries(state.flags).filter(([id, f]) => f.on && byId.has(id)).map(([id]) => byId.get(id));
	if (path[0] === "개정 의심") return notesFlagged(flagged);
	if (path.length) return notesTopic(path, active);

	const graduated = [...prog.values()].filter((p) => p.done).length;
	const review = reviewIds(questions, prog, state.flags, today());
	const subjectCard = (subject) => {
		const items = active.filter(({ q }) => q.subject === subject);
		const counts = {};
		for (const { q } of items) counts[q.topic] = (counts[q.topic] ?? 0) + 1;
		const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
		return `<section class="card">
			<div class="row"><h2>${subject}</h2><strong>${num(items.length, "문제")}</strong></div>
			${rows.length
				? `<div class="list">${rows.map(([topic, n]) => `<a class="link" href="${notesLink(subject, topic)}"><span class="topic"><span class="row"><span>${esc(topic)}</span><span class="muted small">${n}문제</span></span><span class="meter"><i style="width:${(n / items.length) * 100}%"></i></span></span>${icon("right")}</a>`).join("")}</div>`
				: '<p class="muted small">오답 없음</p>'}
		</section>`;
	};
	shell("notes", `<h1>오답노트</h1>
	${active.length
		? `${review.length ? `<button class="btn" data-act="review-all">복습 대기 ${review.length}문제 풀기</button>` : ""}
		<div class="subjects">${SUBJECTS.map(subjectCard).join("")}</div>`
		: `<section class="card"><div class="empty">${drawMark({ lines: true })}<strong>복습 문항 없음</strong><span class="muted small">오답·애매함 문항 자동 등록</span></div></section>`}
	${flagged.length ? `<section class="card"><a class="link" href="${notesLink("개정 의심")}"><span>개정 의심 문제 ${flagged.length}개</span>${icon("right")}</a></section>` : ""}
	${graduated ? `<p class="muted small">졸업 ${graduated}문제</p>` : ""}`);
}

function notesTopic([subject, topic], active) {
	const items = active.filter(({ q }) => q.subject === subject && q.topic === topic).sort((a, b) => a.p.due.localeCompare(b.p.due));
	shell("notes", `<div class="row" style="justify-content:flex-start"><a class="iconbtn" href="#notes" aria-label="오답노트로 돌아가기">${icon("left")}</a><h1>${esc(topic)}</h1></div>
	${items.length ? `<button class="btn" data-act="topic-review" data-subject="${esc(subject)}" data-topic="${esc(topic)}">${items.length}문제 풀기</button>` : ""}
	<section class="card">
		<h2>${esc(subject)}</h2>
		${items.length
			? `<div class="list">${items.map(({ q, p }) => notesItem(q, reviewStage(p))).join("")}</div>`
			: `<div class="empty">${drawMark({ lines: true })}<strong>복습 문항 없음</strong></div>`}
	</section>`);
}

function notesFlagged(flagged) {
	shell("notes", `<div class="row" style="justify-content:flex-start"><a class="iconbtn" href="#notes" aria-label="오답노트로 돌아가기">${icon("left")}</a><h1>개정 의심 문제</h1></div>
	<section class="card"><div class="list">${flagged.map((q) => notesItem(q, q.subject)).join("")}</div></section>`);
}

function chart(subject, rows) {
	const W = 280, H = 140, L = 30, R = 10, T = 10, B = 22;
	const x = (i) => (rows.length > 1 ? L + (i * (W - L - R)) / (rows.length - 1) : (L + W - R) / 2);
	const y = (v) => T + ((100 - v) * (H - T - B)) / 100;
	const pts = rows.map((r, i) => ({ ...r, i, v: pct(r.ok, r.total) })).filter((r) => r.v !== null);
	const last = pts.at(-1);
	const tip = (p) => `${shortDay(p.day)} ${p.v}% (${p.ok}/${p.total})`;
	return `<section class="card chart">
		<h2 style="font-size:18px;line-height:27px">${subject}</h2>
		<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${subject} 일별 정답률 ${last ? `최근 ${last.v}%` : "기록 없음"}">
			${[0, 50, 100].map((v) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
			${rows.length > 1 ? `<text x="${L}" y="${H - 4}">${shortDay(rows[0].day)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">오늘</text>` : `<text x="${x(0)}" y="${H - 4}" text-anchor="middle">오늘</text>`}
			${pts.length > 1 ? `<polygon class="area" points="${x(pts[0].i)},${y(0)} ${pts.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")} ${x(last.i)},${y(0)}"/><polyline class="line" pathLength="1" points="${pts.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}"/>` : ""}
			${pts.map((p) => `<circle class="pt" style="--at:${(p.i / Math.max(1, rows.length - 1)).toFixed(2)}" cx="${x(p.i)}" cy="${y(p.v)}" r="5"/><circle class="hit" cx="${x(p.i)}" cy="${y(p.v)}" r="16" data-tip="${tip(p)}"/>`).join("")}
		</svg>
		<p class="small muted tip">${last ? tip(last) : "기록 없음"}</p>
	</section>`;
}

function calendar() {
	const month = calendarMonth ?? today().slice(0, 7);
	const [y, m] = month.split("-").map(Number);
	const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
	const count = new Date(y, m, 0).getDate();
	const perDay = {};
	for (const e of state.log) perDay[dayKey(e.t)] = (perDay[dayKey(e.t)] ?? 0) + 1;
	const cells = Array.from({ length: count }, (_, i) => {
		const d = `${month}-${String(i + 1).padStart(2, "0")}`;
		const on = dayComplete(state, d);
		const label = `${i + 1}일 ${on ? "완료" : "미완료"}${perDay[d] ? ` ${perDay[d]}문제` : ""}`;
		return `<div class="cell ${on ? "on" : ""} ${d === today() ? "today" : ""}" role="img" aria-label="${label}"><span>${i + 1}</span>${on ? icon("check") : perDay[d] ? `<span class="muted" style="font-size:12px">${perDay[d]}</span>` : ""}</div>`;
	});
	return `<section class="card">
		<div class="row"><button class="iconbtn" data-act="month" data-delta="-1" aria-label="이전 달">${icon("left")}</button><h2>${y}년 ${m}월</h2><button class="iconbtn" data-act="month" data-delta="1" aria-label="다음 달">${icon("right")}</button></div>
		<div class="calendar">${WEEKDAYS.map((w) => `<div class="muted">${w}</div>`).join("")}${"<div></div>".repeat(lead)}${cells.join("")}</div>
	</section>`;
}

/* 차트는 화면에 들어올 때 한 번 그려진다. 아래쪽 차트가 안 보일 때 재생되어 버리지 않게 한다. */
function drawCharts() {
	if (calm() || !document.querySelector(".shell.enter")) return;
	const seen = new IntersectionObserver((entries) => {
		for (const { isIntersecting, target } of entries) {
			if (!isIntersecting) continue;
			target.classList.replace("pending", "draw");
			seen.unobserve(target);
		}
	}, { threshold: 0.35 });
	for (const el of document.querySelectorAll(".chart")) {
		el.classList.add("pending");
		seen.observe(el);
	}
}

function stats() {
	const table = dailyAccuracy(state.log, byId, today());
	shell("stats", `<h1>학습 기록</h1>
	<h2>과목별 정답률</h2>
	<div class="charts">${SUBJECTS.map((s) => chart(s, table[s])).join("")}</div>
	${calendar()}`);
	drawCharts();
}

/* 풀이 */
const blank = () => ({ revealed: false, committed: false, amb: false, sheet: false, error: "", chat: [], explain: null, motion: "enter" });

function start(mode, ids, title, extra = {}) {
	if (!ids.length) return;
	const from = location.hash || "#home";
	scrolls[from] = scrollY;
	history.pushState(null, "", "#solve");
	session = { ...blank(), motion: "enter present", from, pushed: true, mode, ids, title, i: 0, orders: new Map(ids.map((id) => [id, mode === "mock" ? [0, 1, 2, 3, 4] : choiceOrder(byId.get(id))])), picks: {}, score: 0, ...extra };
	solve();
	scrollTo(0, 0);
}

/* iOS 는 뒤로 간 앱을 언제든 내리므로 풀던 자리를 남겨 둔다. */
function keep() {
	const { mode, ids, title, i, orders, picks, score, deadline, from } = session;
	write("session", { mode, ids, title, i, orders: [...orders], picks, score, deadline, from });
}

function resume() {
	const saved = read("session", null);
	if (!saved?.ids?.length || saved.mode === "round" || !saved.ids.every((id) => byId.has(id))) return false;
	session = { ...blank(), ...saved, orders: new Map(saved.orders) };
	history.replaceState(null, "", "#solve");
	if (session.mode === "mock") session.timer = setInterval(mockClock, 1000);
	if (session.mode === "mock-review") session.revealed = true;
	solve();
	if (session.mode === "mock-review") loadExplain();
	return true;
}

const current = () => byId.get(session.ids[session.i]);

function commit() {
	if (!session?.revealed || session.committed || session.mode.startsWith("mock")) return;
	const q = current();
	const ok = isCorrect(q, session.picks[q.id]);
	session.score += ok ? 1 : 0;
	session.committed = true;
	state.log.push({ t: Date.now(), id: q.id, ok, ...(session.amb ? { amb: true } : {}) });
	save();
}

function closeSession() {
	commit();
	clearInterval(session?.timer);
	leave();
}

function dropSession() {
	const { from = "#home" } = session;
	session = null;
	lastTab = null;
	visited.delete(from);
	write("session", null);
}

/* 풀이 화면은 기록 한 칸을 차지한다. 그래서 닫기와 뒤로 가기가 같은 곳으로 간다. */
function leave() {
	const { pushed, from = "#home" } = session;
	dropSession();
	if (pushed) return history.back();
	history.replaceState(null, "", from);
	render();
}

function choiceHtml(q) {
	const s = session;
	const picked = s.picks[q.id];
	return `<fieldset class="choices"><legend class="sr">보기</legend>${s.orders.get(q.id).map((orig, pos) => {
		const correct = isCorrect(q, orig);
		const cls = s.revealed ? (correct ? "right" : picked === orig ? "wrong" : "") : "";
		const mark = s.revealed ? (correct ? "정답" : picked === orig ? "내 답" : "") : "";
		return `<label class="choice ${cls}"><input type="radio" name="c" value="${orig}" ${picked === orig ? "checked" : ""} ${s.revealed ? "disabled" : ""}><span aria-hidden="true">${NUM[pos]}</span><span>${esc(q.choices[orig])}</span>${mark ? `<span class="mark">${mark}</span>` : ""}</label>`;
	}).join("")}</fieldset>`;
}

/* 그림을 말하는 문제는 펼쳐 두고, 나머지는 인식 오류를 대조할 때만 연다. */
function figureHtml(q) {
	if (!q.images?.length) return "";
	const imgs = q.images.map((src, i) => {
		const alt = `${q.year}년 ${q.number}번 원본 문제${q.images.length > 1 ? ` ${i + 1}` : ""}`;
		return `<button class="zoomable" data-act="zoom" data-src="/${esc(src)}" data-alt="${alt}" aria-label="${alt} 전체화면"><img src="/${esc(src)}" alt="" loading="lazy"></button>`;
	}).join("");
	return `<details class="figure" ${q.figure ? "open" : ""}><summary>원본 문제</summary>${imgs}</details>`;
}

function explainHtml(q) {
	const s = session;
	const ex = s.explain;
	const body = ex === "loading"
		? '<div class="skeleton" role="status" aria-label="해설 불러오는 중"><i></i><i></i><i></i><i></i><i></i><i></i></div>'
		: ex === "offline"
			? '<div class="alert bad">인터넷 연결 필요</div><button class="btn quiet" data-act="retry">다시 시도</button>'
			: ex === "missing"
				? '<div class="alert">해설 준비 중</div>'
			: ex === "failed"
				? '<div class="alert bad">해설 불러오기 실패</div><button class="btn quiet" data-act="retry">다시 시도</button>'
				: ex
					? `<p>${esc(ex.summary)}</p>
					<div class="list">${s.orders.get(q.id).map((orig, pos) => `<div><strong>${NUM[pos]} ${isCorrect(q, orig) ? "정답" : "오답"}</strong><br><span class="small">${esc(ex.choices[orig])}</span>${basisHtml(q, ex, orig + 1)}</div>`).join("")}</div>
					${basisHtml(q, ex, 0)}
					${ex.lawNote ? `<div class="alert">${esc(ex.lawNote)}</div>` : ""}
					<p class="small muted">AI 생성 해설 · 오류 가능 · ${q.year}년 시험 기준, 현행법과 차이 가능</p>
					${s.pastChat && !q.fixed ? '<p class="small muted">이전 대화 · 당시 보기 번호 기준</p>' : ""}
					${s.chat.map((m) => `<div class="say ${m.role === "user" ? "me" : ""} small">${esc(m.content)}</div>`).join("")}
					${s.asking ? '<div class="skeleton" role="status" aria-label="답변 생성 중"><i></i><i></i></div>' : ""}
					${s.askError ? '<p class="error">답변 수신 실패</p>' : ""}
					<form data-form="ask" class="stack" style="gap:8px"><label class="sr" for="ask">추가 질문</label><textarea id="ask" class="field" rows="2" placeholder="추가 질문 입력" required></textarea><button class="btn quiet">질문하기</button></form>`
					: "";
	return `<div class="grab" id="grab"></div>
		<div class="row"><h2>해설</h2><span class="tag">AI 해설</span></div>${body}
		<button class="btn quiet openexplain" data-act="sheet-close">닫기</button>`;
}

function paintExplain(fresh = false) {
	const el = document.getElementById("explain");
	if (!el) return;
	el.innerHTML = explainHtml(current());
	el.classList.toggle("fresh", fresh);
}

/* 해설은 D1에서 받고, 받은 것은 오프라인에서도 보이게 캐시에 둔다. */
async function fetchExplain(q) {
	const cache = await caches.open("explain-v1");
	const key = `/explain/${q.id}`;
	const saved = await cache.match(key);
	if (saved) return saved.json();
	const result = await api("/api/explain", { id: q.id });
	await cache.put(key, Response.json(result));
	return result;
}

async function loadExplain() {
	const s = session;
	const q = current();
	s.chat = read(`chat:${q.id}`, []);
	s.pastChat = s.chat.length > 0;
	s.explain = "loading";
	paintExplain();
	try {
		const result = await fetchExplain(q);
		if (session === s && current() === q) {
			s.explain = result;
			paintExplain(true);
		}
	} catch (error) {
		if (session === s && current() === q) {
			s.explain = error.status === 404 ? "missing" : navigator.onLine ? "failed" : "offline";
			paintExplain();
		}
	}
}

function setSheet(open) {
	session.sheet = open;
	for (const id of ["explain", "scrim"]) document.getElementById(id).toggleAttribute("data-open", open);
}

function reveal() {
	const s = session;
	const q = current();
	if (s.picks[q.id] === undefined) {
		s.error = "보기 선택 필요";
		return solve();
	}
	s.error = "";
	s.revealed = true;
	commit();
	s.motion = "reveal";
	solve();
	loadExplain();
}

function next() {
	const s = session;
	commit();
	if (s.i + 1 >= s.ids.length) return finish();
	Object.assign(s, { i: s.i + 1, revealed: false, committed: false, amb: false, sheet: false, explain: null, chat: [], askError: false, motion: "enter" });
	solve();
	scrollTo(0, 0);
}

function finish() {
	const s = session;
	clearInterval(s.timer);
	write("session", null);
	const total = s.ids.length;
	session = { mode: "done", from: s.from, pushed: s.pushed };
	const percent = pct(s.score, total);
	app.innerHTML = `<div class="solve center" style="max-width:560px"><section class="card pop" style="text-align:center;justify-items:center">
		${drawMark({ lines: true })}
		<h1>${esc(s.title)}</h1>
		<p>정답 ${num(s.score)} / ${total}</p>
		${s.mode === "mock" ? `<p><strong style="font-size:30px;line-height:45px">${num(percent, "점")}</strong></p><p class="muted small">오답 문항 복습 등록 완료</p>` : ""}
		<button class="btn" data-act="leave">확인</button>
	</section></div>`;
	scrollTo(0, 0);
	countUp();
}

function solve() {
	const s = session;
	keep();
	if (s.mode === "mock") return mock();
	if (s.mode === "mock-result") return mockResult();
	const q = current();
	const ok = s.revealed && isCorrect(q, s.picks[q.id]);
	const flag = state.flags[q.id]?.on;
	const motion = s.motion ?? "";
	s.motion = null;
	app.innerHTML = `<div class="solve ${motion}">
		<header>
			<div class="row"><button class="iconbtn" data-act="close" aria-label="풀이 닫기">${icon("close")}</button><strong>${esc(s.title)}</strong><span>${s.i + 1} / ${s.ids.length}</span></div>
			<div class="bar on-white" role="progressbar" aria-valuemin="0" aria-valuemax="${s.ids.length}" aria-valuenow="${s.i + 1}" aria-label="진행"><i id="progress" style="width:${(s.i / s.ids.length) * 100}%"></i></div>
		</header>
		<div class="cols ${s.revealed ? "open" : ""}">
			<section class="card">
				<span><span class="tag">${q.year}년 · ${q.subject}</span></span>
				<p class="stem">${esc(q.stem)}</p>
				${figureHtml(q)}
				${choiceHtml(q)}
				${s.error ? `<p class="error" role="alert">${s.error}</p>` : ""}
				${s.revealed
					? `<p class="verdict ${ok ? "ok" : "no"}" role="status">${drawMark({ wrong: !ok })}${ok ? (s.amb ? "정답 · 애매함 복습 등록" : "정답") : "오답 · 복습 등록"}</p>
`
					: `<div class="actions">
						<button class="chip" aria-pressed="${s.amb}" data-act="amb">애매함</button>
						<button class="chip" aria-pressed="${!!flag}" data-act="flag">개정 의심</button>
					</div>`}
			</section>
			${s.revealed ? `<aside class="card explain" id="explain" ${s.sheet ? "data-open" : ""} aria-label="해설">${explainHtml(q)}</aside>` : ""}
		</div>
		<div class="dock">
			${s.mode === "mock-review"
				? `<button class="btn quiet" data-act="mock-review-move" data-delta="-1" ${s.i === 0 ? "disabled" : ""}>이전</button><button class="btn quiet openexplain" data-act="sheet-open">해설 보기</button>${s.i + 1 < s.ids.length ? '<button class="btn quiet" data-act="mock-review-move" data-delta="1">다음</button>' : ""}<button class="btn" data-act="mock-result">결과</button>`
				: s.revealed
				? `<button class="btn quiet openexplain" data-act="sheet-open">해설 보기</button><button class="btn" data-act="next">${s.i + 1 < s.ids.length ? "다음 문제" : "마치기"}</button>`
				: '<button class="btn" data-act="reveal">정답 확인</button>'}
		</div>
		${s.revealed ? `<div class="scrim" id="scrim" ${s.sheet ? "data-open" : ""} data-act="sheet-close"></div>` : ""}
	</div>`;
	requestAnimationFrame(() => {
		const bar = document.getElementById("progress");
		if (bar) bar.style.width = `${((s.i + 1) / s.ids.length) * 100}%`;
	});
}

function mockResult() {
	const s = session;
	app.innerHTML = `<div class="solve" style="max-width:800px">
		<section class="card">
			<h1>${esc(s.title)}</h1>
			<p><strong>${pct(s.score, s.ids.length)}점</strong> · 정답 ${s.score} / ${s.ids.length}</p>
			<p class="muted small">오답 문항 복습 등록 완료</p>
			<div class="list">${s.ids.map((id, i) => {
				const q = byId.get(id);
				const picked = s.picks[id];
				const ok = picked !== undefined && isCorrect(q, picked);
				const order = s.orders.get(id);
				const answer = q.answer.map((n) => order.indexOf(n - 1) + 1).sort().join(", ");
				return `<button class="link" data-act="mock-review" data-index="${i}"><span>${q.number}번 · ${picked === undefined ? "미응답" : ok ? "정답" : "오답"}<br><span class="small muted">내 답 ${picked === undefined ? "—" : order.indexOf(picked) + 1} · 정답 ${answer}</span></span><span>해설 ${icon("right")}</span></button>`;
			}).join("")}</div>
		</section>
		<div class="dock"><button class="btn" data-act="leave">마치기</button></div>
	</div>`;
	scrollTo(0, 0);
}

function openMockReview(index) {
	if (!["mock-result", "mock-review"].includes(session?.mode) || !Number.isInteger(index) || index < 0 || index >= session.ids.length) return;
	session = { ...session, ...blank(), mode: "mock-review", i: index, revealed: true, committed: true };
	solve();
	scrollTo(0, 0);
	loadExplain();
}

function mockClock() {
	if (session?.mode !== "mock") return;
	const left = Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));
	const el = document.getElementById("clock");
	if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
	if (left === 0) submitMock();
}

function mock() {
	const s = session;
	const q = current();
	keep();
	const motion = s.motion ?? "";
	s.motion = null;
	app.innerHTML = `<div class="solve ${motion}" style="max-width:800px">
		<header><div class="row"><button class="iconbtn" data-act="mock-quit" aria-label="모의고사 그만두기">${icon("close")}</button><strong role="timer" aria-label="남은 시간" id="clock"></strong><span>${s.i + 1} / ${s.ids.length}</span></div></header>
		<section class="card">
			<span><span class="tag">${q.year}년 제${q.round}회 · ${q.subject}</span></span>
			<p class="stem">${esc(q.stem)}</p>
			${figureHtml(q)}
			${choiceHtml(q)}
		</section>
		<div class="dock">
			<button class="btn quiet" data-act="mock-move" data-delta="-1" ${s.i === 0 ? "disabled" : ""}>이전</button>
			${s.i + 1 < s.ids.length ? '<button class="btn quiet" data-act="mock-move" data-delta="1">다음</button>' : ""}
			<button class="btn" data-act="mock-submit">제출</button>
		</div>
	</div>`;
	mockClock();
	scrollTo(0, 0);
}

function confirmDialog(message, label, act, cancel = "계속 풀기") {
	const d = document.getElementById("confirm");
	d.innerHTML = `<div class="stack">${message}<button class="btn" data-act="${act.name ?? act}" ${act.attrs ?? ""}>${label}</button><button class="btn quiet" data-act="dialog-close">${cancel}</button></div>`;
	d.showModal();
	d.focus();
}

/** 기출문제 탭은 호흡이 길어서 시작 전에 알린다. */
function notice(title, lines, act) {
	confirmDialog(`<h2>${esc(title)}</h2><ul class="notice">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`, "시작", act, "취소");
}

function submitMock() {
	const s = session;
	if (s?.mode !== "mock") return;
	document.getElementById("confirm")?.close();
	clearInterval(s.timer);
	const t = Date.now();
	s.score = 0;
	s.ids.forEach((id, i) => {
		const ok = s.picks[id] !== undefined && isCorrect(byId.get(id), s.picks[id]);
		s.score += ok ? 1 : 0;
		state.log.push({ t: t + i, id, ok });
	});
	session = { ...s, mode: "mock-result", timer: null };
	save();
	keep();
	mockResult();
}

/* 입력 */
const ACTIONS = {
	"round-toggle"() {
		setRoundOpen(document.getElementById("round-trigger").getAttribute("aria-expanded") !== "true");
	},
	"round-close": () => setRoundOpen(false, true),
	"round-select"(d) {
		setRoundOpen(false);
		selectedExamYear = Number(d.year);
		exam();
		document.getElementById("round-trigger")?.focus({ preventScroll: true });
	},
	daily() {
		const day = today();
		const solved = solvedOn(state.log, day);
		start("daily", dayIds(state.days[day]).filter((id) => !solved.has(id)), "오늘의 기출");
	},
	more() {
		notice(`${DAILY_SIZE}문제 추가`, ["과목 비율 동일", "새 문제·오답 혼합", "연속 학습 기록과 무관"], "more-start");
	},
	"more-start"() {
		const day = today();
		const d = state.days[day];
		const extra = pickDaily(questions, state.log, state.flags, DAILY_SIZE, day, new Set(dayIds(d)));
		d.extra = [...(d.extra ?? []), ...extra];
		save();
		ACTIONS.daily();
	},
	review: () => start("review", shuffle(extraReview()).slice(0, DAILY_SIZE), "오답 랜덤 풀기"),
	"review-all": () => start("review", reviewIds(questions, progress(state.log), state.flags, today()), "오답 복습"),
	single: (d) => start("single", [d.id], "다시 풀기"),
	round(d) {
		const count = questions.filter((q) => q.year === Number(d.year) && q.subject === d.subject).length;
		notice(`${d.year}년 ${d.subject} 기출 모의고사`, [
			`${count}문제 · 제한 시간 ${MOCK_MINUTES[d.subject]}분`,
			"시작 후 시간 정지 불가, 앱 이탈 시에도 진행",
			"시간 종료 시 자동 제출",
			"제출 후 일괄 채점·문항별 해설 확인",
			"미응답 문항 오답 처리·오답 문항 복습 등록",
			"중도 포기 시 기록 미저장",
		], { name: "round-start", attrs: `data-year="${d.year}" data-subject="${d.subject}"` });
	},
	"round-start"(d) {
		const ids = questions.filter((q) => q.year === Number(d.year) && q.subject === d.subject).sort((a, b) => a.number - b.number).map((q) => q.id);
		start("mock", ids, `${d.year}년 ${d.subject} 기출 모의고사`, { deadline: Date.now() + MOCK_MINUTES[d.subject] * 60000, timer: setInterval(mockClock, 1000) });
	},
	"mock-result"() {
		session = { ...session, mode: "mock-result", sheet: false };
		keep();
		mockResult();
	},
	"mock-review": (d) => openMockReview(Number(d.index)),
	"mock-review-move": (d) => openMockReview(session.i + Number(d.delta)),
	reveal,
	next,
	close: closeSession,
	leave,
	retry: loadExplain,
	amb() {
		session.amb = !session.amb;
		document.querySelector('[data-act="amb"]').setAttribute("aria-pressed", session.amb);
	},
	flag() {
		const id = current().id;
		state.flags[id] = { on: !state.flags[id]?.on, t: Date.now() };
		save();
		document.querySelector('[data-act="flag"]').setAttribute("aria-pressed", state.flags[id].on);
	},
	"sheet-open": () => setSheet(true),
	"sheet-close": () => setSheet(false),
	"mock-move"(d) {
		session.i += Number(d.delta);
		mock();
	},
	"mock-submit"() {
		const left = session.ids.filter((id) => session.picks[id] === undefined).length;
		confirmDialog(left ? `미응답 ${left}문제` : "전 문항 응답 완료", "제출", "mock-confirm");
	},
	"mock-confirm": submitMock,
	"mock-quit": () => confirmDialog("중단 시 기록 미저장", "중단", "mock-abandon"),
	"mock-abandon"() {
		clearInterval(session.timer);
		leave();
	},
	"dialog-close"() {},
	"google-login"() {
		location.href = "/api/auth/google";
	},
	logout: () => confirmDialog("<h2>로그아웃</h2>", "로그아웃", "logout-confirm", "취소"),
	"logout-confirm": () => leaveAccount("/api/auth/logout"),
	zoom({ src, alt }) {
		const d = document.getElementById("zoom");
		d.innerHTML = `<button class="iconbtn" data-act="dialog-close" aria-label="그림 닫기">${icon("close")}</button><img src="${esc(src)}" alt="${esc(alt)}">`;
		d.showModal();
	},
	"topic-review"(d) {
		const prog = progress(state.log);
		const ids = questions.filter((q) => q.subject === d.subject && q.topic === d.topic && prog.get(q.id)?.due && !state.flags[q.id]?.on).map((q) => q.id);
		start("review", ids, `${d.topic} 복습`);
	},
	month(d) {
		const [y, m] = (calendarMonth ?? today().slice(0, 7)).split("-").map(Number);
		const moved = new Date(y, m - 1 + Number(d.delta), 1);
		calendarMonth = `${moved.getFullYear()}-${String(moved.getMonth() + 1).padStart(2, "0")}`;
		stats();
	},
};

function openTab(tab) {
	const here = location.hash || "#home";
	if (tabOf(here) !== tab) location.hash = tabPaths[tab] ?? `#${tab}`;
	else if (here !== `#${tab}`) location.hash = `#${tab}`;
	else scrollTo({ top: 0, behavior: calm() ? "auto" : "smooth" });
}

document.addEventListener("click", (e) => {
	if (e.target.id === "round-sheet") {
		const r = e.target.getBoundingClientRect();
		if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) setRoundOpen(false, true);
	}
	const tab = e.target.closest("[data-tab]");
	if (tab) {
		e.preventDefault();
		return openTab(tab.dataset.tab);
	}
	const el = e.target.closest("[data-act]");
	if (!el || el.disabled) return;
	el.closest("dialog")?.close();
	ACTIONS[el.dataset.act](el.dataset);
});

// Native modal semantics keep focus inside the sheet and support Escape.
document.addEventListener("close", (e) => {
	if (e.target.id === "round-sheet") document.getElementById("round-trigger")?.setAttribute("aria-expanded", "false");
}, true);

document.addEventListener("keydown", (e) => {
	if (!e.target.closest("#round-options") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
	e.preventDefault();
	const options = [...document.querySelectorAll("#round-options .round-option")];
	const index = options.indexOf(document.activeElement);
	const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
	options[next]?.focus({ preventScroll: true });
	options[next]?.scrollIntoView({ block: "nearest" });
});

document.addEventListener("pointerdown", (e) => {
	const handle = e.target.closest("#round-grab");
	if (!handle || e.button !== 0 || matchMedia("(min-width: 768px)").matches) return;
	const sheet = document.getElementById("round-sheet");
	const startY = e.clientY;
	handle.setPointerCapture(e.pointerId);
	const move = (event) => {
		if (event.pointerId !== e.pointerId) return;
		sheet.style.transform = `translateY(${Math.max(0, event.clientY - startY)}px)`;
	};
	const end = (event) => {
		if (event.pointerId !== e.pointerId) return;
		handle.removeEventListener("pointermove", move);
		handle.removeEventListener("pointerup", end);
		handle.removeEventListener("pointercancel", end);
		sheet.style.transform = "";
		if (event.type === "pointerup" && event.clientY - startY > 80) setRoundOpen(false, true);
	};
	handle.addEventListener("pointermove", move);
	handle.addEventListener("pointerup", end);
	handle.addEventListener("pointercancel", end);
});

document.addEventListener("change", (e) => {
	if (e.target.name === "c" && session && !session.revealed && session.mode !== "mock-result") {
		session.picks[current().id] = Number(e.target.value);
		session.error = "";
		keep();
	}
});

/* 손잡이를 끌어내려 해설 시트를 닫는다. */
document.addEventListener("pointerdown", (e) => {
	if (e.target.id !== "grab") return;
	const sheet = document.getElementById("explain");
	const startY = e.clientY;
	const move = (m) => {
		sheet.style.transition = "none";
		sheet.style.transform = `translateY(${Math.max(0, m.clientY - startY)}px)`;
	};
	const up = (u) => {
		removeEventListener("pointermove", move);
		removeEventListener("pointerup", up);
		removeEventListener("pointercancel", up);
		sheet.style.transition = sheet.style.transform = "";
		if (u.clientY - startY > 80) setSheet(false);
	};
	addEventListener("pointermove", move);
	addEventListener("pointerup", up);
	addEventListener("pointercancel", up);
});

/* 키보드가 올라오면 해설 시트를 그 위로 올린다. */
visualViewport?.addEventListener("resize", () => {
	document.documentElement.style.setProperty("--kb", `${Math.max(0, innerHeight - visualViewport.height)}px`);
});

document.addEventListener("pointerover", (e) => {
	const tip = e.target.dataset?.tip;
	if (tip) e.target.closest(".chart").querySelector(".tip").textContent = tip;
});

document.addEventListener("submit", async (e) => {
	e.preventDefault();
	if (e.target.dataset.form !== "ask") return;
	const s = session;
	const q = current();
	const text = e.target.querySelector("textarea").value.trim();
	if (!text) return;
	const chat = s.chat; // 답변 중 다음 문제로 넘어가면 s.chat 이 바뀐다
	const shown = () => session === s && current() === q;
	const before = chat.length;
	chat.push({ role: "user", content: text });
	Object.assign(s, { asking: true, askError: false });
	paintExplain();
	try {
		const res = await post("/api/ask", { question: q, explanation: s.explain, messages: chat, order: s.orders.get(q.id), pick: s.picks[q.id] });
		const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
		const reply = { role: "assistant", content: "" };
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!reply.content) {
				chat.push(reply);
				s.asking = false;
				if (shown()) paintExplain();
			}
			reply.content += value;
			if (shown()) [...document.querySelectorAll("#explain .say")].at(-1).textContent = reply.content;
		}
		if (!reply.content) throw new Error("빈 답변");
		write(`chat:${q.id}`, chat);
	} catch {
		chat.length = before;
		Object.assign(s, { asking: false, askError: true });
		if (shown()) paintExplain();
	}
});

/* 시작 */
const GOOGLE_MARK = `<svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.9 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.9c-.6 3-2.2 5.5-4.8 7.2l7.7 6c4.5-4.2 7.1-10.3 7.1-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.8-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.1 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.2C6.5 42.6 14.6 48 24 48z"/></svg>`;

/* 과목별 유형 카드가 서로 다른 속도로 흐른다. Tween UI 의 Column Drift 방식을 옮겼다. */
function loginDrift() {
	const column = (subject) => {
		const topics = [...new Set(questions.filter((q) => q.subject === subject && q.topic !== "기타").map((q) => q.topic))];
		const cards = topics.map((t) => `<div class="drift-card"><strong>${esc(t)}</strong><i></i><i></i></div>`).join("");
		return `<div class="drift-col"><div class="drift-track">${cards.repeat(6)}</div></div>`;
	};
	return `<div class="drift" aria-hidden="true">${SUBJECTS.map(column).join("")}</div>`;
}

async function leaveAccount(path) {
	try {
		await sync();
		await post(path, {});
	} catch {
		return confirmDialog("<h2>로그아웃 실패</h2><p>인터넷 연결 확인 필요</p>", "다시 시도", "logout-confirm", "취소");
	}
	state = emptyState();
	write("state", state);
	lastTab = null;
	signOut();
}

function loginScreen(message = "") {
	app.innerHTML = `<div class="login">
		${loginDrift()}
		<div class="login-panel">
			<img src="/apple-touch-icon.png" alt="" width="80" height="80">
			<h1>나희의 합격노트</h1>
			${message ? `<p class="error" role="alert">${message}</p>` : ""}
			<button class="btn google" data-act="google-login">${GOOGLE_MARK}Google 계정으로 로그인</button>
		</div>
	</div>`;
}

const ROUTES = { home, exam, notes, stats };

function render() {
	if (session) return;
	if (!signedIn) return loginScreen();
	if (location.hash === "#solve") history.replaceState(null, "", "#home");
	const [route, ...path] = location.hash.slice(1).split("/").map(decodeURIComponent);
	(ROUTES[route] ?? home)(path);
}

addEventListener("hashchange", () => {
	if (!session || location.hash === "#solve") return render();
	if (session.mode === "mock") {
		history.pushState(null, "", "#solve");
		return ACTIONS["mock-quit"]();
	}
	commit();
	dropSession();
	render();
});
addEventListener("resize", () => {
	for (const key of Object.keys(pillBoxes)) delete pillBoxes[key];
	placePills();
});
// 링크와 그림을 끌 때 뜨는 브라우저 미리보기를 막는다
document.addEventListener("dragstart", (e) => e.preventDefault());
// iOS Safari 는 터치 리스너가 있어야 :active 를 표시한다
document.addEventListener("touchstart", () => {}, { passive: true });
addEventListener("pagehide", () => signedIn && sync().catch(() => {}));
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState !== "visible" || !signedIn) return;
	syncAndShow();
});

/* 다른 기기 기록이 들어왔을 때만 다시 그린다. 재생 중인 화면 움직임을 끊지 않기 위해서다. */
function syncAndShow() {
	const before = JSON.stringify(state);
	sync().then(() => !session && JSON.stringify(state) !== before && render()).catch(() => {});
}

async function boot() {
	if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("/sw.js");
	questions = await (await fetch("/questions.json")).json();
	byId = new Map(questions.map((q) => [q.id, q]));
	const login = new URLSearchParams(location.search).get("login");
	localStorage.removeItem("token");
	if (login) history.replaceState(null, "", location.pathname + location.hash);
	if (login === "ok") write("signedIn", (signedIn = true));
	if (login && login !== "ok") return loginScreen(login === "denied" ? "허용되지 않은 계정" : "로그인 실패");
	if (!signedIn || !resume()) render();
	// 첫 화면이 네트워크를 기다리지 않게 뒤에서 맞춘다
	if (signedIn) syncAndShow();
}

boot();
