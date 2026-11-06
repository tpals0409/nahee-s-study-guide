// 테스트용 D1: 실제 마이그레이션을 Node 의 SQLite 로 돌린다.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function testDb() {
	const db = new DatabaseSync(":memory:");
	const migrations = new URL("../migrations/", import.meta.url);
	for (const name of fs.readdirSync(migrations).sort()) db.exec(fs.readFileSync(new URL(name, migrations), "utf8"));
	const statement = (sql, args = []) => ({
		bind: (...values) => statement(sql, values),
		all: async () => ({ results: db.prepare(sql).all(...args) }),
		first: async () => db.prepare(sql).get(...args) ?? null,
		run: () => db.prepare(sql).run(...args),
	});
	return { exec: (sql) => db.exec(sql), prepare: (sql) => statement(sql), batch: async (list) => list.map((s) => s.run()) };
}
