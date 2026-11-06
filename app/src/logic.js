// 출제·복습 규칙. 화면과 서버가 함께 쓰는 순수 함수만 둔다.
export const SUBJECTS = ["산업재산권법", "민법개론", "자연과학개론"];
export const MOCK_MINUTES = { 산업재산권법: 70, 민법개론: 70, 자연과학개론: 60 };
export const DAILY_SIZE = 12;
const INTERVALS = [1, 3, 7, 30];
const DAY_START_HOUR = 4;

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 새벽 4시에 날짜가 바뀐다. */
export const dayKey = (t) => ymd(new Date(t - DAY_START_HOUR * 3600000));

export function addDays(day, n) {
	const [y, m, d] = day.split("-").map(Number);
	return ymd(new Date(y, m - 1, d + n));
}

export const emptyState = () => ({ log: [], days: {}, flags: {}, cursor: 0 });

/**
 * 기출 모의고사 응시 기록을 풀이 기록에서 되찾는다. 제출은 문항마다 t, t+1, t+2… 로 저장되고
 * 일반 풀이는 문제마다 몇 초씩 벌어져서, 시각이 이어지는 같은 회차·과목 묶음이 한 번의 응시다.
 */
export function mockHistory(log, byId) {
	const history = new Map();
	let run = [];
	const close = () => {
		const qs = run.map((e) => byId.get(e.id));
		// ponytail: 세트는 37문제 이상이라 30을 기준으로 둔다. 짧은 세트가 생기면 기록에 응시 표시를 넣어야 한다
		if (run.length >= 30 && qs.every((q) => q && q.year === qs[0].year && q.subject === qs[0].subject)) {
			const key = `${qs[0].year}|${qs[0].subject}`;
			const score = Math.round((run.filter((e) => e.ok).length / run.length) * 100);
			const h = history.get(key) ?? { count: 0, best: 0 };
			history.set(key, { count: h.count + 1, best: Math.max(h.best, score) });
		}
		run = [];
	};
	for (const e of [...log].sort((a, b) => a.t - b.t)) {
		if (run.length && e.t !== run.at(-1).t + 1) close();
		run.push(e);
	}
	close();
	return history;
}

/** 두 기기의 기록을 합친다. 풀이 기록은 합집합, 나머지는 규칙대로 하나를 고른다. */
export function merge(a, b) {
	const log = new Map();
	for (const e of [...a.log, ...b.log]) log.set(`${e.t}|${e.id}`, e);
	const days = { ...a.days };
	for (const [k, v] of Object.entries(b.days)) {
		const [first, second] = !days[k] || v.c < days[k].c ? [v, days[k]] : [days[k], v];
		const extra = [...new Set([...(first.extra ?? []), ...(second?.extra ?? [])])];
		days[k] = extra.length ? { ...first, extra } : first;
	}
	const flags = { ...a.flags };
	for (const [k, v] of Object.entries(b.flags)) if (!flags[k] || v.t > flags[k].t) flags[k] = v;
	return { log: [...log.values()].sort((x, y) => x.t - y.t), days, flags };
}

/** 풀이 기록을 다시 재생해 문제별 복습 상태를 만든다. log 는 시간순이어야 한다. */
export function progress(log) {
	const map = new Map();
	for (const { t, id, ok, amb } of log) {
		const day = dayKey(t);
		const p = map.get(id) ?? { stage: null, due: null, done: false, last: t };
		p.last = t;
		p.failed = !ok || !!amb;
		if (!ok || amb) Object.assign(p, { stage: 0, due: addDays(day, INTERVALS[0]), done: false });
		else if (p.stage !== null && !p.done && day >= p.due) {
			p.stage += 1;
			if (p.stage === INTERVALS.length) Object.assign(p, { stage: null, due: null, done: true });
			else p.due = addDays(day, INTERVALS[p.stage]);
		}
		map.set(id, p);
	}
	return map;
}

export function shuffle(list, rng = Math.random) {
	const a = [...list];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/** 복습할 때가 된 문제. 오래 밀린 것부터. */
export function dueIds(questions, prog, flags, day) {
	return questions
		.filter((q) => !flags[q.id]?.on && prog.get(q.id)?.due && prog.get(q.id).due <= day)
		.sort((a, b) => prog.get(a.id).due.localeCompare(prog.get(b.id).due))
		.map((q) => q.id);
}

/** 오답 복습에서 지금 풀 수 있는 문제: 복습일이 됐거나, 마지막 풀이가 오답·애매함인 문제. */
export function reviewIds(questions, prog, flags, day) {
	return questions
		.filter((q) => {
			const p = prog.get(q.id);
			return p?.due && !flags[q.id]?.on && (p.due <= day || p.failed);
		})
		.sort((a, b) => prog.get(a.id).due.localeCompare(prog.get(b.id).due))
		.map((q) => q.id);
}

/** 과목마다 같은 수를 내고, 그 안에서 새 문제 3 : 오답 1. 오답이 모자라면 새 문제로, 새 문제가 없으면 오래전에 맞힌 문제로 채운다. */
export function pickDaily(questions, log, flags, n, day, exclude = new Set(), rng = Math.random) {
	const prog = progress(log);
	const quota = n / SUBJECTS.length;
	const picked = SUBJECTS.flatMap((subject) => {
		const pool = questions.filter((q) => q.subject === subject && !flags[q.id]?.on && !exclude.has(q.id));
		const due = dueIds(pool, prog, flags, day);
		const fresh = shuffle(pool.filter((q) => !prog.has(q.id)), rng).map((q) => q.id);
		const again = pool
			.filter((q) => prog.has(q.id) && !prog.get(q.id).due)
			.sort((a, b) => prog.get(a.id).last - prog.get(b.id).last)
			.map((q) => q.id);
		const review = due.slice(0, quota / 4);
		return [...review, ...[...fresh, ...due.slice(review.length), ...again].slice(0, quota - review.length)];
	});
	return shuffle(picked, rng);
}

/** 그날 풀 문제 전체. extra 는 다 푼 뒤 추가한 문제로, 연속 학습 판정에는 넣지 않는다. */
export const dayIds = (d) => [...d.ids, ...(d.extra ?? [])];

/** 보기 표시 순서(원래 번호 0~4). */
export const choiceOrder = (q, rng = Math.random) => (q.fixed ? [0, 1, 2, 3, 4] : shuffle([0, 1, 2, 3, 4], rng));

export const isCorrect = (q, index) => q.answer.includes(index + 1);

/** 그날 푼 문제 id. */
export const solvedOn = (log, day) => new Set(log.filter((e) => dayKey(e.t) === day).map((e) => e.id));

export function dayComplete(state, day) {
	const ids = state.days[day]?.ids;
	if (!ids) return false;
	const solved = solvedOn(state.log, day);
	return ids.every((id) => solved.has(id));
}

/** 오늘까지 이어진 연속 학습 일수. 오늘 아직 안 끝났으면 어제부터 센다. */
export function streak(state, today) {
	let day = dayComplete(state, today) ? today : addDays(today, -1);
	let count = 0;
	while (dayComplete(state, day)) {
		count += 1;
		day = addDays(day, -1);
	}
	return count;
}

/** day 가 속한 주의 월요일. */
export function weekStart(day) {
	const [y, m, d] = day.split("-").map(Number);
	return addDays(day, -((new Date(y, m - 1, d).getDay() + 6) % 7));
}

/** 과목별 일별 정답률. 첫 학습일부터 최대 7일. 애매함 표시와 상관없이 맞힌 수로 센다. */
export function dailyAccuracy(log, questionsById, today, maxDays = 7) {
	const first = log.length ? dayKey(log[0].t) : today;
	const days = [today];
	while (days.length < maxDays && days[0] > first) days.unshift(addDays(days[0], -1));
	const table = Object.fromEntries(SUBJECTS.map((s) => [s, days.map((day) => ({ day, ok: 0, total: 0 }))]));
	for (const e of log) {
		const subject = questionsById.get(e.id)?.subject;
		const i = days.indexOf(dayKey(e.t));
		if (!subject || i < 0) continue;
		table[subject][i].total += 1;
		if (e.ok) table[subject][i].ok += 1;
	}
	return table;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Only split an unambiguous, ordered ㄱ. ㄴ. ... list; tables and references remain intact. */
export function splitStatements(stem) {
	const marks = [...stem.matchAll(/(?:^|\s)([ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ])[ \t]*[.．)][ \t]*/g)];
	if (marks.length < 2 || marks.some((m, i) => m[1] !== "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"[i])) return null;
	const items = marks.map((m, i) => ({ label: m[1], text: stem.slice(m.index + m[0].length, marks[i + 1]?.index ?? stem.length).trim() }));
	if (items.some((item) => !item.text)) return null;
	const prompt = stem.slice(0, marks[0].index).replace(/(?:^|\n)\s*(?:<\s*보\s*기\s*>|보\s*기)\s*$/, "").trim();
	return { prompt, items };
}

export function stemHtml(q) {
	const parts = splitStatements(q.stem);
	if (!parts) return `<p class="stem${q.stem.length > 200 ? " long" : ""}">${esc(q.stem)}</p>`;
	return `<div class="question-stem">${parts.prompt ? `<p class="stem${parts.prompt.length > 200 ? " long" : ""}">${esc(parts.prompt)}</p>` : ""}<section class="statement-box" aria-label="보기 지문"><h3 class="statement-heading">보기</h3><ul class="statements" role="list">${parts.items.map((item) => `<li class="statement"><span class="statement-label">${item.label}.</span><p>${esc(item.text)}</p></li>`).join("")}</ul></section></div>`;
}

/* 조문·조약은 생성 때 본문과 대조한 근거, 판례는 원문이 없는 근거 */
export function basisHtml(q, ex, choice) {
	const items = ex.basis?.filter((b) => b.choice === choice) ?? [];
	if (ex.basis && !items.length && choice && q.subject !== "자연과학개론") return '<p class="basis muted">근거 미확인</p>';
	return items.map((b) => {
		if (b.kind === "precedent") return `<p class="basis muted">판례 기반 · 원문 미확인</p>`;
		const name = b.kind === "article" ? `${b.source} 제${b.ref}조` : b.source;
		return `<details class="basis"><summary>${esc(name)} · 조문 확인${b.changed ? " · 현행 문구 다름" : ""}</summary><blockquote>${esc(b.quote)}</blockquote></details>`;
	}).join("");
}

// Keep the resting top edge until the visible viewport cannot fit a usable sheet.
export function chatViewportLayout(baseHeight, visibleHeight, offsetTop = 0) {
	const bottom = offsetTop + visibleHeight;
	const restingTop = baseHeight - Math.min(baseHeight * .8, 720);
	const top = Math.max(offsetTop + 8, Math.min(restingTop, bottom - 240));
	return { top, height: Math.max(0, bottom - top), keyboard: baseHeight - visibleHeight > 100 };
}
