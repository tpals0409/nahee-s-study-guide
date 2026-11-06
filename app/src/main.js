import {
	basisHtml, esc, stemHtml,
	DAILY_SIZE, MOCK_MINUTES, SUBJECTS, addDays, choiceOrder, dayComplete, dayIds, dayKey, emptyState, isCorrect,
	merge, mockHistory, pickDaily, progress, reviewIds, shuffle, solvedOn, streak, weekStart,
} from "./logic.js";
import { RADAR_PARTS, radarViews, radarFace } from "./radar.js";

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
	grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
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
let radarIndex = 0;
let selectedRecordDay = null;
let statsView = "accuracy";
let solveClosed = false;
let selectedExamYear = read("examYear", null);
let notesSubject = SUBJECTS[0];

let lastTab = null;
history.scrollRestoration = "manual";
const tabPaths = {};

const today = () => dayKey(Date.now());

/* 닫는 움직임이 끝난 뒤 닫는다. 움직임을 끄면 재생할 것이 없어서 바로 닫힌다. */
function shut(d) {
	if (!d.open) return Promise.resolve();
	return d.shutting ??= (async () => {
		d.classList.add("closing");
		await Promise.allSettled(d.getAnimations({ subtree: true }).map((a) => a.finished));
		d.shutting = null;
		if (!d.classList.contains("closing")) return; // 닫히는 중에 다시 열렸다
		d.classList.remove("closing");
		d.style.transform = "";
		d.close();
	})();
}

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

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

/* 첫 방문과 재방문 모두 콘텐츠 전체에 같은 전환을 적용한다. */
function pageMotion(key) {
	if (key === lastTab) return "";
	if (lastTab && tabOf(lastTab) === tabOf(key)) return key.split("/").length > lastTab.split("/").length ? "page-enter push" : "page-enter";
	return "page-enter";
}

function shell(tab, body) {
	const key = location.hash || "#home";
	const motion = pageMotion(key);
	lastTab = key;
	tabPaths[tab] = key;
	app.innerHTML = `<div class="shell ${motion}">
		<nav class="nav" aria-label="주요 메뉴">
			<div class="brand">${icon("note")}<span>나희의<br>합격노트</span></div>
			${TABS.map(([id, label, ic]) => `<a href="#${id}" data-tab="${id}" ${id === tab ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`).join("")}
			<button class="nav-logout" data-act="logout">${icon("logout")}<span>로그아웃</span></button>
		</nav>
		<main class="main page-${tab}"><header class="topbrand"><div class="brand">${icon("note")}<span>나희의 합격노트</span></div><button class="top-logout" data-act="logout">${icon("logout")}<span>로그아웃</span></button></header>${body}</main>
	</div>`;
	if (!motion) return;
	scrollTo(0, 0);
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
	const history = mockHistory(state.log, byId);
	const taken = (year) => SUBJECTS.filter((subject) => history.has(`${year}|${subject}`)).length;
	const record = (subject) => {
		const h = history.get(`${selectedExamYear}|${subject}`);
		return h ? ` · 최고 ${h.best}점 · ${h.count}회` : "";
	};
	const selected = rounds.get(selectedExamYear);
	if (!selected) return shell("exam", '<h1>기출 모의고사</h1><section class="card">등록된 회차 없음</section>');
	shell("exam", `<h1>기출 모의고사</h1>
	<section class="card exam-card">
		<h2 class="sr" id="round-label">연도·회차 선택</h2>
		<div class="round-select" id="round-select">
			<button class="round-trigger" id="round-trigger" data-act="round-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="round-sheet" aria-labelledby="round-label round-value">
				<span id="round-value">${selectedExamYear}년 제${selected.round}회</span><span class="round-chevron" aria-hidden="true">${icon("right")}</span>
			</button>
			<dialog class="round-sheet" id="round-sheet" aria-labelledby="round-sheet-title">
				<div class="round-grab" id="round-grab" aria-hidden="true"><span></span></div>
				<header class="round-sheet-header"><h2 id="round-sheet-title">회차 선택</h2><button class="iconbtn" data-act="round-close" aria-label="회차 선택 닫기">${icon("close")}</button></header>
				<div class="round-options" id="round-options">
					${years.map((year) => `<button class="round-option" aria-pressed="${year === selectedExamYear}" data-act="round-select" data-year="${year}"><span>${year}년 제${rounds.get(year).round}회</span><span class="link-end">${taken(year) ? `<span class="small muted">${taken(year)}/${SUBJECTS.length} 응시</span>` : ""}<span aria-hidden="true">${year === selectedExamYear ? "✓" : ""}</span></span></button>`).join("")}
				</div>
			</dialog>
		</div>
		<div class="list">${SUBJECTS.filter((subject) => selected.n[subject]).map((subject) => `<button class="link" data-act="round" data-year="${selectedExamYear}" data-subject="${subject}"><span><strong>${subject}</strong><br><span class="small muted">${selected.n[subject]}문제 · ${MOCK_MINUTES[subject]}분${record(subject)}</span></span><span class="go">시작</span></button>`).join("")}</div>
	</section>`);
}

const closeSheet = (d) => (d.id === "round-sheet" ? setRoundOpen(false, true) : shut(d));

async function setRoundOpen(open, restoreFocus = false) {
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
		await shut(sheet);
		if (restoreFocus) trigger.focus({ preventScroll: true });
	}
}


let toastTimer;
function toast(message, kind = "") {
	const el = document.getElementById("toast");
	clearTimeout(toastTimer);
	el.className = `toast ${kind ? `answer-toast ${kind}` : ""}`;
	if (kind) el.innerHTML = `${drawMark({ wrong: kind === "no" })}<strong>${esc(message)}</strong>`;
	else el.textContent = message;
	el.classList.add("visible");
	toastTimer = setTimeout(() => { el.classList.remove("visible"); el.textContent = ""; }, 2400);
}

function dismissToast() {
	clearTimeout(toastTimer);
	const el = document.getElementById("toast");
	if (el) { el.classList.remove("visible"); el.textContent = ""; }
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
	const due = new Set(review);
	const items = active.filter(({ q }) => q.subject === notesSubject);
	const counts = Object.fromEntries(RADAR_PARTS[notesSubject].map((topic) => [topic, { today: 0, total: 0 }]));
	for (const { q } of items) {
		const count = counts[q.topic] ??= { today: 0, total: 0 };
		count.total++;
		if (due.has(q.id)) count.today++;
	}
	shell("notes", `<h1>오답노트</h1>
	<section class="card notes-summary" aria-labelledby="review-heading">
		<div class="stack"><h2 id="review-heading">오늘 복습</h2><p class="notes-summary-copy">${review.length ? `풀어볼 문제가 <strong>${review.length}개</strong> 있어요.` : active.length ? "오늘 복습을 모두 마쳤어요." : "아직 등록된 오답이 없어요."}</p><p class="muted small">${active.length ? `전체 ${active.length}문제 · 오늘 수에는 밀린 복습도 포함돼요.` : "오답·애매함 문항이 자동으로 모여요."}</p></div>
		${review.length ? `<button class="btn" data-act="review-all">오늘 복습 시작 ${icon("arrow")}</button>` : ""}
	</section>
	<div class="notes-subjects" role="group" aria-label="오답노트 과목 선택">${SUBJECTS.map((subject) => `<button class="notes-subject" data-act="notes-subject" data-subject="${subject}" aria-pressed="${subject === notesSubject}">${subject}</button>`).join("")}</div>
	<section class="card notes-parts" aria-labelledby="notes-subject-heading">
		<div class="row"><h2 id="notes-subject-heading">${notesSubject}</h2><span class="muted small">전체 ${items.length}문제</span></div>
		<div class="list">${Object.entries(counts).map(([topic, count]) => `<${count.total ? `a href="${notesLink(notesSubject, topic)}"` : 'button type="button" data-act="notes-empty"'} class="link notes-part"><span class="notes-part-name">${esc(topic)}</span><span class="notes-counts"><span class="${count.today ? "notes-due" : "muted"}">오늘 <strong>${count.today}</strong></span><span aria-hidden="true">·</span><span class="muted">전체 ${count.total}</span></span>${icon("right")}</${count.total ? "a" : "button"}>`).join("")}</div>
	</section>
	${flagged.length ? `<section class="card notes-flagged"><a class="link" href="${notesLink("개정 의심")}"><span>개정 의심 문제 ${flagged.length}개</span>${icon("right")}</a></section>` : ""}
	${graduated ? `<p class="muted small">졸업 ${graduated}문제</p>` : ""}`);
}

function notesTopic([subject, topic], active) {
	if (SUBJECTS.includes(subject)) notesSubject = subject;
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

function radarCard() {
	const views = radarViews(state.log, byId, today());
	return `<section class="card stats-chart" aria-labelledby="accuracy-title"><h2 id="accuracy-title" class="sr">과목별 정답률</h2>
	<div class="stats-subjects" role="group" aria-label="정답률 과목 선택">${views.map((view, i) => `<button class="chip" data-act="radar-select" data-index="${i}" aria-pressed="${i === radarIndex}">${view.title}</button>`).join("")}</div>
	<button class="radar-card" id="radar-card" data-act="radar-next" aria-label="${views[radarIndex].title} 정답률, 다음 분류 보기"><span class="radar-face">${radarFace(views[radarIndex], radarIndex)}</span></button>
	<p class="small muted">최근 7일 · 반복 풀이 포함 · 격자 한 칸은 약 33%</p>
	<span class="sr" id="radar-status" role="status" aria-live="polite"></span></section>`;
}

function transitionRadar(index = (radarIndex + 1) % 4) {
	if (!Number.isInteger(index) || index < 0 || index > 3 || index === radarIndex) return;
	const card = document.getElementById("radar-card");
	if (!card) return;
	radarIndex = index;
	const view = radarViews(state.log, byId, today())[index];
	card.innerHTML = `<span class="radar-face content-enter">${radarFace(view, index)}</span>`;
	card.setAttribute("aria-label", `${view.title} 정답률, 다음 분류 보기`);
	document.querySelectorAll('[data-act="radar-select"]').forEach((button) => button.setAttribute("aria-pressed", Number(button.dataset.index) === index));
	document.getElementById("radar-status").textContent = `${view.title} 정답률`;
}

function recordSummary(log) {
	const total = log.length;
	const correct = log.filter((entry) => entry.ok).length;
	return { total, correct, rate: total ? `${Math.round(correct / total * 100)}%` : "기록 없음", days: new Set(log.map((entry) => dayKey(entry.t))).size };
}

function recordDetail(day) {
	const log = state.log.filter((entry) => dayKey(entry.t) === day);
	const summary = recordSummary(log);
	return `<div class="record-detail"><h3>${shortDay(day)} 학습</h3>
	${log.length ? `<p>풀이 ${summary.total}회 · 정답률 ${summary.rate}</p><div class="record-subjects">${SUBJECTS.map((subject) => {
		const part = recordSummary(log.filter((entry) => byId.get(entry.id)?.subject === subject));
		return `<div class="row"><span>${subject}</span><span class="muted small">${part.total}회 · ${part.rate}</span></div>`;
	}).join("")}</div>` : '<p class="muted">이날은 학습 기록이 없어요.</p>'}</div>`;
}

function calendar() {
	const month = calendarMonth ?? today().slice(0, 7);
	if (!selectedRecordDay || !selectedRecordDay.startsWith(month)) selectedRecordDay = month === today().slice(0, 7) ? today() : `${month}-01`;
	const [y, m] = month.split("-").map(Number);
	const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
	const count = new Date(y, m, 0).getDate();
	const perDay = {};
	for (const e of state.log) perDay[dayKey(e.t)] = (perDay[dayKey(e.t)] ?? 0) + 1;
	const cells = Array.from({ length: count }, (_, i) => {
		const d = `${month}-${String(i + 1).padStart(2, "0")}`;
		const on = dayComplete(state, d);
		return `<button class="cell ${on ? "on" : ""} ${d === today() ? "today" : ""}" data-act="record-day" data-day="${d}" aria-pressed="${d === selectedRecordDay}" ${d === today() ? 'aria-current="date"' : ""} aria-label="${m}월 ${i + 1}일, 풀이 ${perDay[d] ?? 0}회${on ? ', 오늘의 문제 완료' : ''}"><span>${i + 1}${on ? icon("check") : ""}</span><span class="day-count">${perDay[d] ? `${perDay[d]}회` : ""}</span></button>`;
	});
	return `<div class="calendar-content"><div class="row"><button class="iconbtn" data-act="month" data-delta="-1" aria-label="이전 달">${icon("left")}</button><h3>${y}년 ${m}월</h3><button class="iconbtn" data-act="month" data-delta="1" aria-label="다음 달">${icon("right")}</button></div>
	<div class="calendar">${WEEKDAYS.map((w) => `<div class="muted">${w}</div>`).join("")}${"<div></div>".repeat(lead)}${cells.join("")}</div>
	<p class="small muted">숫자는 풀이 횟수 · ✓ 오늘의 문제 완료</p>
	<div id="record-detail">${recordDetail(selectedRecordDay)}</div></div>`;
}

function statsPanel() {
	if (statsView === "calendar") return `<section class="card stats-calendar" aria-labelledby="calendar-heading"><h2 id="calendar-heading" class="sr">학습 달력</h2><div id="calendar-body">${calendar()}</div></section>`;
	const start = addDays(today(), -6);
	const summary = recordSummary(state.log.filter((entry) => dayKey(entry.t) >= start && dayKey(entry.t) <= today()));
	return `<div class="stats-summary" aria-label="최근 7일 학습 요약"><span class="summary-period">최근 7일 <span class="muted">${shortDay(start)}–${shortDay(today())}</span></span><div class="summary-inline"><span>풀이 <strong>${summary.total}회</strong></span><span>정답률 <strong>${summary.rate}</strong></span><span>학습한 날 <strong>${summary.days}일</strong></span></div></div>
	${radarCard()}`;
}

function stats() {
	shell("stats", `<h1>학습 기록</h1>
	<div class="record-views" role="group" aria-label="학습 기록 화면 선택">${[["accuracy", "정답률"], ["calendar", "학습 달력"]].map(([value, label]) => `<button data-act="stats-view" data-view="${value}" aria-pressed="${statsView === value}">${label}</button>`).join("")}</div>
	<div class="stats-layout" id="stats-panel">${statsPanel()}</div>`);
}

/* 풀이 */
const blank = () => ({ revealed: false, committed: false, amb: false, sheet: false, error: "", chat: [], askDraft: "", explain: null, motion: "enter" });

function start(mode, ids, title, extra = {}) {
	if (!ids.length) return;
	const from = location.hash || "#home";
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
	document.getElementById("ai-chat")?.close();
	dismissToast();
	const { from = "#home" } = session;
	session = null;
	solveClosed = true;
	document.getElementById("map")?.close();
	lastTab = null;
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
	return `<fieldset class="choices"><legend class="sr">정답 선택</legend>${s.orders.get(q.id).map((orig, pos) => {
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
					<div class="list">${s.orders.get(q.id).map((orig, pos) => `<div class="explanation-choice ${isCorrect(q, orig) ? "correct" : "incorrect"}"><strong>${NUM[pos]} ${isCorrect(q, orig) ? "정답" : "오답"}</strong><br><span class="small">${esc(ex.choices[orig])}</span>${basisHtml(q, ex, orig + 1)}</div>`).join("")}</div>
					${basisHtml(q, ex, 0)}
					${ex.lawNote ? `<div class="alert">${esc(ex.lawNote)}</div>` : ""}
					<p class="small muted">AI 생성 해설 · 오류 가능 · ${q.year}년 시험 기준, 현행법과 차이 가능</p>
					<button class="btn quiet" data-act="ai-chat-open" aria-haspopup="dialog">AI 질문</button>`
					: "";
	return `<div class="grab" id="grab"></div>
		<div class="row"><h2>해설</h2><span class="tag">AI 해설</span></div>${body}
		<button class="btn quiet openexplain" data-act="sheet-close">닫기</button>`;
}

function chatMessagesHtml(q, s) {
	return `${s.pastChat && !q.fixed ? '<p class="small muted">이전 대화 · 당시 보기 번호 기준</p>' : ""}
	${s.chat.length ? s.chat.map((m) => `<div class="say ${m.role === "user" ? "me" : ""}"><span class="chat-speaker">${m.role === "user" ? "나" : "AI"}</span><div class="chat-text">${esc(m.content)}</div></div>`).join("") : '<div class="chat-empty"><h3>어떤 부분이 궁금한가요?</h3><p class="muted">현재 문제와 해설을 바탕으로 답변해 드려요.</p></div>'}
	${s.asking ? '<p class="small muted" role="status">답변 작성 중…</p>' : ""}
	${s.askError ? '<p class="error" role="alert">답변을 받지 못했어요. 다시 전송해 주세요.</p>' : ""}`;
}

function paintChat() {
	const dialog = document.getElementById("ai-chat");
	if (!dialog?.open || !session) return;
	const messages = dialog.querySelector(".chat-messages");
	const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
	messages.innerHTML = chatMessagesHtml(current(), session);
	dialog.querySelector('button[type="submit"]').disabled = !!session.asking;
	dialog.querySelector("textarea").disabled = !!session.asking;
	if (atBottom) messages.scrollTop = messages.scrollHeight;
}

function openChat() {
	const s = session;
	if (!s?.revealed || !s.explain || typeof s.explain !== "object") return;
	const q = current();
	const dialog = document.getElementById("ai-chat");
	dialog.innerHTML = `<div class="round-grab" aria-hidden="true"><span></span></div>
	<header class="chat-header"><div><h2 id="ai-chat-title">AI 질문</h2><p class="small muted">${q.year}년 · ${esc(q.subject)} · ${q.number}번</p></div><button class="iconbtn" data-act="dialog-close" aria-label="AI 질문 닫기">${icon("close")}</button></header>
	<div class="chat-messages" role="log" aria-label="문제에 대한 대화">${chatMessagesHtml(q, s)}</div>
	<form data-form="ask" class="chat-compose"><label class="sr" for="ask">AI에게 질문</label><textarea id="ask" class="field" rows="2" placeholder="궁금한 내용을 입력하세요" required ${s.asking ? "disabled" : ""}>${esc(s.askDraft ?? "")}</textarea><button type="submit" class="btn" ${s.asking ? "disabled" : ""}>전송</button><p class="small muted">AI 답변에는 오류가 있을 수 있어요.</p></form>`;
	dialog.showModal();
	dialog.querySelector(".chat-messages").scrollTop = dialog.querySelector(".chat-messages").scrollHeight;
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
	if (s.revealed) return;
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
	const feedback = answerFeedback(q, s);
	toast(feedback.message, feedback.ok ? "ok" : "no");
	loadExplain();
}

function next() {
	document.getElementById("ai-chat")?.close();
	dismissToast();
	const s = session;
	commit();
	if (s.i + 1 >= s.ids.length) return finish();
	Object.assign(s, { i: s.i + 1, revealed: false, committed: false, amb: false, sheet: false, explain: null, chat: [], askDraft: "", askError: false, motion: "enter" });
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

function answerFeedback(q, s) {
	const ok = isCorrect(q, s.picks[q.id]);
	const answers = s.orders.get(q.id).flatMap((original, position) => isCorrect(q, original) ? [NUM[position]] : []).join("·");
	return { ok, message: ok ? "정답이에요" : `아쉬워요. 정답은 ${answers}번이에요` };
}

function solve() {
	const s = session;
	keep();
	if (s.mode === "mock") return mock();
	if (s.mode === "mock-result") return mockResult();
	const q = current();
	const flag = state.flags[q.id]?.on;
	const motion = s.motion ?? "";
	s.motion = null;
	app.innerHTML = `<div class="solve ${motion}">
		<header>
			<div class="row"><button class="iconbtn" data-act="close" aria-label="풀이 닫기">${icon("close")}</button><strong>${esc(s.title)}</strong><span>${s.i + 1} / ${s.ids.length}</span></div>
			<div class="bar on-white" role="progressbar" aria-valuemin="0" aria-valuemax="${s.ids.length}" aria-valuenow="${s.i + 1}" aria-label="진행"><i id="progress" style="width:${(s.i / s.ids.length) * 100}%"></i></div>
		</header>
		<div class="cols ${s.revealed ? "open" : ""}">
			<section class="card q">
				<span><span class="tag">${q.year}년 · ${q.subject}</span></span>
				${stemHtml(q)}
				${figureHtml(q)}
				${choiceHtml(q)}
				${s.error ? `<p class="error" role="alert">${s.error}</p>` : ""}
				${s.revealed
					? ""
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

const RESULT = { ok: "정답", no: "오답", skip: "미응답" };

function mockResult() {
	const s = session;
	const filter = s.filter ?? "all";
	const rows = s.ids.map((id, i) => {
		const q = byId.get(id);
		const picked = s.picks[id];
		const status = picked === undefined ? "skip" : isCorrect(q, picked) ? "ok" : "no";
		return { q, i, picked, status, order: s.orders.get(id) };
	});
	const count = (status) => rows.filter((r) => r.status === status).length;
	const shown = rows.filter((r) => filter === "all" || r.status === filter);
	const chip = (key, label, n) => `<button class="chip" data-act="mock-filter" data-filter="${key}" aria-pressed="${filter === key}">${label} ${n}</button>`;
	app.innerHTML = `<div class="solve plain" style="max-width:800px">
		<section class="card">
			<div class="notice-head"><h1 class="small muted score-title">${esc(s.title)}</h1><p class="score">${pct(s.score, s.ids.length)}점</p></div>
			<div class="facts">${Object.keys(RESULT).map((k) => `<div><strong>${count(k)}</strong><span class="small muted">${RESULT[k]}</span></div>`).join("")}</div>
			<p class="muted small">오답 문항 복습 등록 완료</p>
			<div class="actions filter" role="group" aria-label="문항 보기">${chip("all", "전체", rows.length)}${chip("no", "오답", count("no"))}${chip("skip", "미응답", count("skip"))}</div>
			<div class="list">${shown.map(({ q, i, picked, status, order }) => {
				const answer = q.answer.map((n) => order.indexOf(n - 1) + 1).sort().join(", ");
				return `<button class="link" data-act="mock-review" data-index="${i}"><span><strong class="res-${status}">${q.number}번 · ${RESULT[status]}</strong><br><span class="small muted">내 답 ${picked === undefined ? "—" : order.indexOf(picked) + 1} · 정답 ${answer}</span></span><span class="link-end">해설${icon("right")}</span></button>`;
			}).join("") || '<p class="muted small">해당 문항 없음</p>'}</div>
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
	if (el) {
		el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
		el.classList.toggle("soon", left <= 600);
		el.classList.toggle("last", left <= 300);
	}
	/* 타이머는 매초 낭독되지 않으니 경고 구간에 들어갈 때만 알린다 */
	const warning = left <= 300 ? "남은 시간 5분 이내" : left <= 600 ? "남은 시간 10분 이내" : "";
	if (warning !== session.warned) {
		session.warned = warning;
		const note = document.getElementById("clock-note");
		if (note) note.textContent = warning;
	}
	if (left === 0) submitMock();
}

/* 번호가 커지면 오른쪽에서, 작아지면 왼쪽에서 들어온다 */
function moveMock(i) {
	if (i === session.i) return;
	session.motion = i > session.i ? "fwd" : "rev";
	session.i = i;
	mock();
}

const answered = (s) => s.ids.filter((id) => s.picks[id] !== undefined).length;

function mock() {
	const s = session;
	const q = current();
	keep();
	const motion = s.motion ?? "";
	s.motion = null;
	app.innerHTML = `<div class="solve ${motion}" style="max-width:800px">
		<header><div class="row"><button class="iconbtn" data-act="mock-quit" aria-label="모의고사 그만두기">${icon("close")}</button><strong role="timer" aria-label="남은 시간" id="clock"></strong><button class="map-open" data-act="mock-map" aria-haspopup="dialog" aria-label="문항표 열기, ${s.ids.length}문제 중 ${s.i + 1}번">${icon("grid")}${s.i + 1} / ${s.ids.length}</button></div><div class="bar on-white" id="answered" role="progressbar" aria-valuemin="0" aria-valuemax="${s.ids.length}" aria-valuenow="${answered(s)}" aria-label="응답한 문제"><i style="width:${(answered(s) / s.ids.length) * 100}%"></i></div><span class="sr" id="clock-note" role="status"></span></header>
		<section class="card q">
			<span><span class="tag">${q.year}년 제${q.round}회 · ${q.subject}</span></span>
			${stemHtml(q)}
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

/* 40문제를 순서대로만 넘기면 건너뛴 문제를 찾을 수 없어서 번호로 바로 이동한다 */
function openMap() {
	const s = session;
	const d = document.getElementById("map");
	const left = s.ids.length - answered(s);
	d.classList.remove("closing");
	d.innerHTML = `<div class="round-grab" aria-hidden="true"><span></span></div>
		<header class="round-sheet-header"><div><h2 id="map-title">문항표</h2><p class="small muted">미응답 ${left}문제</p></div><button class="iconbtn" data-act="dialog-close" aria-label="문항표 닫기">${icon("close")}</button></header>
		<div class="round-options map-grid">${s.ids.map((id, i) => {
			const done = s.picks[id] !== undefined;
			return `<button class="map-cell ${done ? "done" : ""}" data-act="mock-go" data-index="${i}" ${i === s.i ? 'aria-current="true"' : ""} aria-label="${i + 1}번 ${done ? "응답" : "미응답"}">${i + 1}</button>`;
		}).join("")}</div>`;
	if (!d.open) d.showModal();
	d.querySelector("[aria-current]")?.focus({ preventScroll: true });
}

function confirmDialog(message, label, act, cancel = "계속 풀기") {
	const d = document.getElementById("confirm");
	d.classList.remove("closing");
	d.innerHTML = `<div class="stack">${message}<div class="dialog-actions"><button class="btn quiet" data-act="dialog-close">${cancel}</button><button class="btn" data-act="${act.name ?? act}" ${act.attrs ?? ""}>${label}</button></div></div>`;
	if (!d.open) d.showModal();
	d.focus();
}

/** 기출문제 탭은 호흡이 길어서 시작 전에 알린다. */
function notice(title, lines, act, { eyebrow = "", facts = [] } = {}) {
	const head = `<div class="notice-head">${eyebrow ? `<p class="small muted">${esc(eyebrow)}</p>` : ""}<h2>${esc(title)}</h2></div>`;
	const tiles = facts.length ? `<div class="facts">${facts.map(([n, unit]) => `<div><strong>${n}</strong><span class="small muted">${unit}</span></div>`).join("")}</div>` : "";
	confirmDialog(`${head}${tiles}<ul class="notice">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`, "시작", act, "취소");
}

function submitMock() {
	const s = session;
	if (s?.mode !== "mock") return;
	document.getElementById("confirm")?.close();
	document.getElementById("map")?.close();
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
	"radar-next": () => transitionRadar(),
	"radar-select": (d) => transitionRadar(Number(d.index)),
	"round-toggle"() {
		setRoundOpen(document.getElementById("round-trigger").getAttribute("aria-expanded") !== "true");
	},
	"round-close": () => setRoundOpen(false, true),
	async "round-select"(d) {
		await setRoundOpen(false);
		selectedExamYear = Number(d.year);
		write("examYear", selectedExamYear);
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
		const set = questions.filter((q) => q.year === Number(d.year) && q.subject === d.subject);
		notice(d.subject, [
			"시작 후 시간 정지 불가, 앱 이탈 시에도 진행",
			"시간 종료 시 자동 제출",
			"제출 후 일괄 채점·문항별 해설 확인",
			"미응답 문항 오답 처리·오답 문항 복습 등록",
			"중도 포기 시 기록 미저장",
		], { name: "round-start", attrs: `data-year="${d.year}" data-subject="${d.subject}"` }, {
			eyebrow: `${d.year}년 제${set[0].round}회 기출 모의고사`,
			facts: [[set.length, "문제"], [MOCK_MINUTES[d.subject], "분"]],
		});
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
	"ai-chat-open": openChat,
	"sheet-open": () => setSheet(true),
	"sheet-close": () => setSheet(false),
	"mock-map": openMap,
	"mock-filter"(d) {
		const y = scrollY;
		session.filter = d.filter;
		mockResult();
		scrollTo(0, y);
	},
	"mock-go": (d) => moveMock(Number(d.index)),
	"mock-move": (d) => moveMock(session.i + Number(d.delta)),
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
	"notes-empty": () => toast("등록된 오답이 없어요"),
	"notes-subject"(d) {
		if (!SUBJECTS.includes(d.subject) || d.subject === notesSubject) return;
		notesSubject = d.subject;
		notes();
		document.querySelector(".notes-parts")?.classList.add("subject-enter");
		document.querySelector('[data-act="notes-subject"][aria-pressed="true"]')?.focus({ preventScroll: true });
	},
	"topic-review"(d) {
		const prog = progress(state.log);
		const ids = questions.filter((q) => q.subject === d.subject && q.topic === d.topic && prog.get(q.id)?.due && !state.flags[q.id]?.on).map((q) => q.id);
		start("review", ids, `${d.topic} 복습`);
	},
	"stats-view"(d) {
		if (!["accuracy", "calendar"].includes(d.view) || d.view === statsView) return;
		statsView = d.view;
		document.querySelectorAll('[data-act="stats-view"]').forEach((button) => button.setAttribute("aria-pressed", button.dataset.view === statsView));
		document.getElementById("stats-panel").innerHTML = `<div class="stats-view-content content-enter">${statsPanel()}</div>`;
		scrollTo(0, 0);
	},
	"record-day"(d) {
		selectedRecordDay = d.day;
		document.querySelectorAll('[data-act="record-day"]').forEach((button) => button.setAttribute("aria-pressed", button.dataset.day === d.day));
		document.getElementById("record-detail").innerHTML = `<div class="content-enter">${recordDetail(d.day)}</div>`;
	},
	month(d) {
		const [y, m] = (calendarMonth ?? today().slice(0, 7)).split("-").map(Number);
		const moved = new Date(y, m - 1 + Number(d.delta), 1);
		calendarMonth = `${moved.getFullYear()}-${String(moved.getMonth() + 1).padStart(2, "0")}`;
		document.getElementById("calendar-body").innerHTML = `<div class="content-enter">${calendar()}</div>`;
		document.querySelector(`[data-act="month"][data-delta="${d.delta}"]`)?.focus({ preventScroll: true });
	},
};

function openTab(tab) {
	const here = location.hash || "#home";
	if (tabOf(here) !== tab) location.hash = tabPaths[tab] ?? `#${tab}`;
	else if (here !== `#${tab}`) location.hash = `#${tab}`;
	else scrollTo({ top: 0, behavior: calm() ? "auto" : "smooth" });
}

document.addEventListener("click", (e) => {
	if (e.target.matches("dialog.round-sheet, dialog.chat-sheet")) {
		const r = e.target.getBoundingClientRect();
		if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(e.target);
	}
	const tab = e.target.closest("[data-tab]");
	if (tab) {
		e.preventDefault();
		return openTab(tab.dataset.tab);
	}
	const el = e.target.closest("[data-act]");
	if (!el || el.disabled) return;
	const dialog = el.closest("dialog");
	if (dialog) shut(dialog);
	if (el.classList.contains("chip")) el.classList.add("picked");
	ACTIONS[el.dataset.act](el.dataset);
});

document.addEventListener("cancel", (e) => {
	if (!e.target.matches("dialog")) return;
	e.preventDefault();
	shut(e.target);
}, true);

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

/* 손잡이를 끌어내려 시트를 닫는다. 놓으면 제자리로 돌아가거나 끌린 자리에서 이어서 내려간다. */
document.addEventListener("pointerdown", (e) => {
	const handle = e.target.closest("#grab, .round-grab");
	if (!handle || e.button !== 0) return;
	const dialog = handle.closest("dialog");
	const sheet = dialog ?? document.getElementById("explain");
	const startY = e.clientY;
	handle.setPointerCapture(e.pointerId);
	const move = (event) => {
		if (event.pointerId !== e.pointerId) return;
		sheet.style.transition = "none";
		sheet.style.transform = `translateY(${Math.max(0, event.clientY - startY)}px)`;
	};
	const end = (event) => {
		if (event.pointerId !== e.pointerId) return;
		handle.removeEventListener("pointermove", move);
		handle.removeEventListener("pointerup", end);
		handle.removeEventListener("pointercancel", end);
		sheet.style.transition = "";
		if (event.type === "pointerup" && event.clientY - startY > 80) {
			if (dialog) return closeSheet(dialog);
			setSheet(false);
		}
		sheet.style.transform = "";
	};
	handle.addEventListener("pointermove", move);
	handle.addEventListener("pointerup", end);
	handle.addEventListener("pointercancel", end);
});

document.addEventListener("change", (e) => {
	if (e.target.name === "c" && session && !session.revealed && session.mode !== "mock-result") {
		session.picks[current().id] = Number(e.target.value);
		e.target.closest(".choice").classList.add("picked");
		const bar = document.getElementById("answered");
		if (bar) {
			bar.setAttribute("aria-valuenow", answered(session));
			bar.firstElementChild.style.width = `${(answered(session) / session.ids.length) * 100}%`;
		}
		session.error = "";
		keep();
	}
});

/* 키보드가 올라오면 해설 시트를 그 위로 올린다. */
visualViewport?.addEventListener("resize", () => {
	document.documentElement.style.setProperty("--kb", `${Math.max(0, innerHeight - visualViewport.height)}px`);
});

document.addEventListener("pointerover", (e) => {
	const tip = e.target.dataset?.tip;
	if (tip) e.target.closest(".chart").querySelector(".tip").textContent = tip;
});

document.addEventListener("input", (e) => {
	if (e.target.id === "ask" && session) session.askDraft = e.target.value;
});

document.addEventListener("submit", async (e) => {
	e.preventDefault();
	if (e.target.dataset.form !== "ask" || !session || session.asking) return;
	const s = session;
	const q = current();
	const text = e.target.querySelector("textarea").value.trim();
	if (!text) return;
	const chat = s.chat;
	const shown = () => session === s && current() === q && document.getElementById("ai-chat")?.open;
	const before = chat.length;
	chat.push({ role: "user", content: text });
	Object.assign(s, { asking: true, askError: false, askDraft: "" });
	e.target.querySelector("textarea").value = "";
	paintChat();
	try {
		const res = await post("/api/ask", { question: q, explanation: s.explain, messages: chat, order: s.orders.get(q.id), pick: s.picks[q.id] });
		const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
		const reply = { role: "assistant", content: "" };
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!reply.content) chat.push(reply);
			reply.content += value;
			if (shown()) paintChat();
		}
		if (!reply.content) throw new Error("빈 답변");
		write(`chat:${q.id}`, chat);
	} catch {
		chat.length = before;
		Object.assign(s, { askError: true, askDraft: text });
		if (shown()) document.getElementById("ai-chat").querySelector("textarea").value = text;
	} finally {
		s.asking = false;
		if (shown()) paintChat();
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

/* 이전 화면이 바로 사라지지 않게 겹쳐서 넘긴다. 풀이를 닫을 때는 아래로 내려간다. */
function paint() {
	const down = solveClosed;
	solveClosed = false;
	if (!down || session || calm() || !document.startViewTransition) return render();
	document.documentElement.classList.toggle("vt-down", down);
	document.startViewTransition(render);
}

function render() {
	if (session) return;
	if (updatePending) { location.reload(); return; }
	if (!signedIn) return loginScreen();
	if (location.hash === "#solve") history.replaceState(null, "", "#home");
	const [route, ...path] = location.hash.slice(1).split("/").map(decodeURIComponent);
	(ROUTES[route] ?? home)(path);
}

addEventListener("hashchange", () => {
	if (!session || location.hash === "#solve") return paint();
	if (session.mode === "mock") {
		history.pushState(null, "", "#solve");
		return ACTIONS["mock-quit"]();
	}
	commit();
	dropSession();
	paint();
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

let updatePending = false;
function watchUpdates() {
	if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
	let controlled = !!navigator.serviceWorker.controller;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (controlled) {
			updatePending = true;
			if (!session) location.reload();
		}
		controlled = true;
	});
	navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
		const check = () => { if (document.visibilityState === "visible") registration.update().catch(() => {}); };
		document.addEventListener("visibilitychange", check);
		setInterval(check, 5 * 60 * 1000);
	}).catch(() => {});
}

async function boot() {
	watchUpdates();
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
