// 학습 기록 저장소(D1). 풀이는 추가만 하고, 기기는 마지막으로 받은 seq 뒤의 변경분만 받는다.
import { merge } from "./logic.js";

const CHUNK = 100;
const RECENT_DAYS = 3;

const validAttempt = (e) => Number.isSafeInteger(e?.t) && typeof e.id === "string" && e.id.length <= 40 && typeof e.ok === "boolean";
const validDay = ([day, d]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(d?.ids) && Number.isSafeInteger(d.c);
const validFlag = ([id, f]) => id.length <= 40 && typeof f?.on === "boolean" && Number.isSafeInteger(f.t);

async function inChunks(db, statements) {
	for (let i = 0; i < statements.length; i += CHUNK) await db.batch(statements.slice(i, i + CHUNK));
}

async function readDays(db) {
	const { results } = await db.prepare("SELECT day, ids, extra, c FROM days").all();
	return Object.fromEntries(results.map((r) => {
		const extra = JSON.parse(r.extra);
		return [r.day, { ids: JSON.parse(r.ids), c: r.c, ...(extra.length ? { extra } : {}) }];
	}));
}

async function readFlags(db) {
	const { results } = await db.prepare("SELECT id, active, t FROM flags").all();
	return Object.fromEntries(results.map((r) => [r.id, { on: !!r.active, t: r.t }]));
}

/** 기기의 변경분을 넣고, 그 기기가 아직 못 받은 내용을 돌려준다. */
export async function syncState(db, body) {
	const { value: epoch } = await db.prepare("SELECT value FROM meta WHERE key = 'epoch'").first();
	if ((body.epoch ?? 1) !== epoch) return { reset: true, epoch };
	const log = (Array.isArray(body.log) ? body.log : []).filter(validAttempt);
	const days = Object.fromEntries(Object.entries(body.days ?? {}).filter(validDay));
	const flags = Object.fromEntries(Object.entries(body.flags ?? {}).filter(validFlag));
	const cursor = Number.isSafeInteger(body.cursor) ? body.cursor : 0;

	const insert = db.prepare("INSERT OR IGNORE INTO attempts (t, id, ok, amb) VALUES (?, ?, ?, ?)");
	await inChunks(db, log.map((e) => insert.bind(e.t, e.id, e.ok ? 1 : 0, e.amb ? 1 : 0)));

	const saved = { log: [], days: await readDays(db), flags: await readFlags(db) };
	const merged = merge(saved, { log: [], days, flags });
	const putDay = db.prepare("INSERT INTO days (day, ids, extra, c) VALUES (?, ?, ?, ?) ON CONFLICT (day) DO UPDATE SET ids = excluded.ids, extra = excluded.extra, c = excluded.c");
	const putFlag = db.prepare("INSERT INTO flags (id, active, t) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET active = excluded.active, t = excluded.t");
	await inChunks(db, [
		...Object.entries(merged.days).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(saved.days[k])).map(([k, v]) => putDay.bind(k, JSON.stringify(v.ids), JSON.stringify(v.extra ?? []), v.c)),
		...Object.entries(merged.flags).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(saved.flags[k])).map(([k, v]) => putFlag.bind(k, v.on ? 1 : 0, v.t)),
	]);

	const { results } = await db.prepare("SELECT seq, t, id, ok, amb FROM attempts WHERE seq > ? ORDER BY seq").bind(cursor).all();
	const recent = cursor ? Object.keys(merged.days).sort().slice(-RECENT_DAYS) : Object.keys(merged.days);
	return {
		log: results.map((r) => ({ t: r.t, id: r.id, ok: !!r.ok, ...(r.amb ? { amb: true } : {}), r: r.seq })),
		days: Object.fromEntries(recent.map((k) => [k, merged.days[k]])),
		flags: merged.flags,
		cursor: results.at(-1)?.seq ?? cursor,
		epoch,
	};
}
