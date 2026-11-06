import assert from "node:assert/strict";
import { basisHtml, addDays, choiceOrder, dayComplete, dayIds, dayKey, dueIds, emptyState, isCorrect, merge, pickDaily, progress, reviewIds, streak, weekStart, dailyAccuracy } from "./logic.js";

const at = (day, h = 12) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00`).getTime();
const q = (id, subject) => ({ id, subject, answer: [1], fixed: false });

// 새벽 4시 전은 전날
assert.equal(dayKey(at("2026-03-02", 3)), "2026-03-01");
assert.equal(dayKey(at("2026-03-02", 4)), "2026-03-02");
assert.equal(addDays("2026-02-28", 1), "2026-03-01");
assert.equal(weekStart("2026-03-01"), "2026-02-23");

// 1·3·7·30일을 모두 맞히면 졸업
{
	const log = [{ t: at("2026-03-01"), id: "a", ok: false }];
	assert.deepEqual([progress(log).get("a").stage, progress(log).get("a").due], [0, "2026-03-02"]);
	log.push({ t: at("2026-03-02"), id: "a", ok: true });
	assert.equal(progress(log).get("a").due, "2026-03-05");
	log.push({ t: at("2026-03-05"), id: "a", ok: true });
	assert.equal(progress(log).get("a").due, "2026-03-12");
	log.push({ t: at("2026-03-12"), id: "a", ok: true });
	assert.equal(progress(log).get("a").due, "2026-04-11");
	// 때가 되기 전에 맞힌 것은 단계를 올리지 않는다
	log.push({ t: at("2026-03-20"), id: "a", ok: true });
	assert.equal(progress(log).get("a").stage, 3);
	log.push({ t: at("2026-04-11"), id: "a", ok: true });
	assert.equal(progress(log).get("a").done, true);
	assert.equal(progress(log).get("a").due, null);
}

// 틀리거나 애매하면 처음부터
{
	const log = [
		{ t: at("2026-03-01"), id: "a", ok: false },
		{ t: at("2026-03-02"), id: "a", ok: true },
		{ t: at("2026-03-05"), id: "a", ok: true, amb: true },
	];
	assert.deepEqual([progress(log).get("a").stage, progress(log).get("a").due], [0, "2026-03-06"]);
	assert.equal(progress([{ t: at("2026-03-01"), id: "b", ok: true, amb: true }]).get("b").stage, 0);
	assert.equal(progress([{ t: at("2026-03-01"), id: "c", ok: true }]).get("c").due, null);
}

const SUBJ = ["산업재산권법", "민법개론", "자연과학개론"];
const bank = SUBJ.flatMap((s, i) => Array.from({ length: 30 }, (_, k) => q(`${i}-${k}`, s)));
const bySubject = (ids) => SUBJ.map((s) => ids.filter((id) => bank.find((b) => b.id === id).subject === s).length);

// 1:1:1, 새 3 : 오답 1
{
	const log = bank.slice(0, 5).map((x, i) => ({ t: at("2026-03-01") + i, id: x.id, ok: false }));
	const ids = pickDaily(bank, log, {}, 12, "2026-03-02");
	assert.deepEqual(bySubject(ids), [4, 4, 4]);
	assert.equal(new Set(ids).size, 12);
	assert.equal(ids.filter((id) => id.startsWith("0-") && Number(id.slice(2)) < 5).length, 1);
	assert.deepEqual(bySubject(pickDaily(bank, [], {}, 36, "2026-03-02")), [12, 12, 12]);
}

// 새 문제가 없으면 오래전에 맞힌 문제부터
{
	const log = bank.map((x, i) => ({ t: at("2026-03-01") + i, id: x.id, ok: true }));
	const ids = pickDaily(bank, log, {}, 12, "2026-03-02");
	assert.deepEqual(bySubject(ids), [4, 4, 4]);
	assert.ok(["0-0", "0-1", "0-2", "0-3"].every((id) => ids.includes(id)));
}

// 신고한 문제는 나오지 않는다
{
	const flags = { "0-0": { on: true, t: 1 } };
	const log = [{ t: at("2026-03-01"), id: "0-0", ok: false }];
	assert.ok(!pickDaily(bank, log, flags, 12, "2026-03-02").includes("0-0"));
	assert.deepEqual(dueIds(bank, progress(log), flags, "2026-03-02"), []);
}

// 틀린 문제는 그날 바로 오답 복습에 뜨고, 다시 맞히면 복습일까지 빠진다. 일찍 맞혀도 일정은 그대로다
{
	const day = "2026-03-02";
	const log = [{ t: at(day), id: "0-0", ok: false }, { t: at(day) + 1, id: "0-1", ok: true, amb: true }, { t: at(day) + 2, id: "0-2", ok: true }];
	assert.deepEqual(reviewIds(bank, progress(log), {}, day).sort(), ["0-0", "0-1"]);
	log.push({ t: at(day) + 3, id: "0-0", ok: true });
	assert.deepEqual(reviewIds(bank, progress(log), {}, day), ["0-1"]);
	assert.equal(progress(log).get("0-0").due, "2026-03-03");
	assert.ok(reviewIds(bank, progress(log), {}, "2026-03-03").includes("0-0"));
	assert.deepEqual(reviewIds(bank, progress(log), { "0-1": { on: true, t: 1 } }, day), []);
}

// 정답률은 첫 학습일부터 일별로, 최대 7일
{
	const ids = new Map(bank.map((x) => [x.id, x]));
	const days = (log) => dailyAccuracy(log, ids, "2026-03-11")[SUBJ[0]];
	assert.equal(days([]).length, 1);
	assert.equal(days([{ t: at("2026-03-11"), id: "0-0", ok: true }]).length, 1);
	const two = days([{ t: at("2026-03-10"), id: "0-0", ok: true }, { t: at("2026-03-11"), id: "0-1", ok: false }]);
	assert.deepEqual(two.map((d) => [d.day, d.ok, d.total]), [["2026-03-10", 1, 1], ["2026-03-11", 0, 1]]);
	assert.equal(days([{ t: at("2025-01-01"), id: "0-0", ok: true }]).length, 7);
}

// 보기 순서
{
	assert.deepEqual(choiceOrder({ fixed: true }), [0, 1, 2, 3, 4]);
	assert.deepEqual([...choiceOrder({ fixed: false })].sort(), [0, 1, 2, 3, 4]);
	assert.ok(isCorrect({ answer: [3, 5] }, 4) && !isCorrect({ answer: [3, 5] }, 3));
}

// 두 기기 합치기
{
	const a = { ...emptyState(), log: [{ t: 1, id: "x", ok: true }], days: { d: { ids: ["x"], c: 5 } }, flags: { x: { on: true, t: 1 } } };
	const b = { ...emptyState(), log: [{ t: 1, id: "x", ok: true }, { t: 2, id: "y", ok: false }], days: { d: { ids: ["y"], c: 3 } }, flags: { x: { on: false, t: 2 } } };
	const m = merge(a, b);
	assert.equal(m.log.length, 2);
	assert.deepEqual(m.days.d.ids, ["y"]);
	assert.equal(m.flags.x.on, false);
	assert.deepEqual(merge(b, a).log, m.log);
}

// 추가 문제: 오늘 문제와 겹치지 않고 비율을 지키며, 두 기기 것을 합치고, 연속 학습에 영향을 주지 않는다
{
	const today = pickDaily(bank, [], {}, 12, "2026-03-02");
	const log = today.map((id, i) => ({ t: at("2026-03-02") + i, id, ok: true }));
	const extra = pickDaily(bank, log, {}, 12, "2026-03-02", new Set(today));
	assert.deepEqual(bySubject(extra), [4, 4, 4]);
	assert.ok(extra.every((id) => !today.includes(id)));
	const a = { ...emptyState(), log, days: { "2026-03-02": { ids: today, c: 1, extra } } };
	const b = { ...emptyState(), days: { "2026-03-02": { ids: ["z"], c: 2, extra: ["y"] } } };
	const m = merge(a, b);
	assert.deepEqual(m.days["2026-03-02"].ids, today);
	assert.equal(dayIds(m.days["2026-03-02"]).length, 25);
	assert.equal(streak(a, "2026-03-02"), 1);
}

// 연속 학습
{
	const s = emptyState();
	for (const d of ["2026-03-01", "2026-03-02"]) {
		s.days[d] = { ids: ["a"], c: 1 };
		s.log.push({ t: at(d), id: "a", ok: true });
	}
	s.days["2026-03-03"] = { ids: ["a", "b"], c: 1 };
	s.log.push({ t: at("2026-03-03"), id: "a", ok: true });
	assert.equal(dayComplete(s, "2026-03-03"), false);
	assert.equal(streak(s, "2026-03-03"), 2);
	s.log.push({ t: at("2026-03-03") + 1, id: "b", ok: true });
	assert.equal(streak(s, "2026-03-03"), 3);
	assert.equal(streak(s, "2026-03-05"), 0);
}

// 근거 표시: 조문 확인, 현행 문구 차이, 판례 미확인, 근거 없음, 과학·구형 해설 제외
{
	const law = { subject: "민법개론" };
	const ex = { basis: [
		{ choice: 1, kind: "article", source: "민법", ref: "110", quote: "<취소>", changed: false },
		{ choice: 2, kind: "article", source: "특허법", ref: "2", quote: "발명", changed: true },
		{ choice: 3, kind: "precedent", source: "판례", ref: "", quote: "", changed: false },
		{ choice: 4, kind: "treaty", source: "파리협약", ref: "", quote: "동맹", changed: false },
	] };
	assert.match(basisHtml(law, ex, 1), /민법 제110조 · 조문 확인<\/summary>/);
	assert.ok(!basisHtml(law, ex, 1).includes("<취소>"));
	assert.match(basisHtml(law, ex, 2), /현행 문구 다름/);
	assert.match(basisHtml(law, ex, 3), /판례 기반 · 원문 미확인/);
	assert.match(basisHtml(law, ex, 4), /파리협약 · 조문 확인/);
	assert.match(basisHtml(law, ex, 5), /근거 미확인/);
	assert.equal(basisHtml(law, ex, 0), "");
	assert.equal(basisHtml({ subject: "자연과학개론" }, { basis: [] }, 1), "");
	assert.equal(basisHtml(law, {}, 1), "");
}

console.log("logic ok");
