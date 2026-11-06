import assert from "node:assert/strict";
import { merge } from "./logic.js";
import { syncState } from "./store.js";
import { testDb } from "./test-db.js";

const db = testDb();
const device = () => ({ log: [], days: {}, flags: {}, cursor: 0 });

function push(state, res) {
	return { ...merge(state, res), cursor: res.cursor };
}
const unsent = (s) => s.log.filter((e) => !e.r);
const send = async (s) => push(s, await syncState(db, { log: unsent(s), days: s.days, flags: s.flags, cursor: s.cursor }));

let ipad = device();
let iphone = device();

// 한 기기의 풀이가 다른 기기로 넘어간다
ipad.log.push({ t: 1, id: "a", ok: false }, { t: 2, id: "b", ok: true, amb: true });
ipad.days["2026-11-06"] = { ids: ["a", "b"], c: 10 };
ipad = await send(ipad);
assert.equal(unsent(ipad).length, 0);
iphone = await send(iphone);
assert.deepEqual(iphone.log.map((e) => [e.id, e.ok, !!e.amb]), [["a", false, false], ["b", true, true]]);
assert.deepEqual(iphone.days["2026-11-06"].ids, ["a", "b"]);

// 재전송은 중복되지 않고, 이미 받은 것은 다시 내려주지 않는다
const again = await syncState(db, { log: [{ t: 1, id: "a", ok: false }], cursor: iphone.cursor });
assert.equal(again.log.length, 0);
assert.equal(again.cursor, iphone.cursor);

// 두 기기가 오프라인에서 푼 기록을 합친다
ipad.log.push({ t: 3, id: "c", ok: true });
iphone.log.push({ t: 4, id: "d", ok: false });
ipad = await send(ipad);
iphone = await send(iphone);
ipad = await send(ipad);
assert.deepEqual(ipad.log.map((e) => e.id), ["a", "b", "c", "d"]);
assert.deepEqual(iphone.log.map((e) => e.id), ["a", "b", "c", "d"]);

// 배정은 먼저 만든 쪽을 쓰고 추가 문제는 합치며, 신고는 최신 값을 쓴다
iphone.days["2026-11-06"] = { ids: ["z"], c: 20, extra: ["e"] };
ipad.flags.a = { on: true, t: 5 };
iphone.flags.a = { on: false, t: 6 };
iphone = await send(iphone);
ipad = await send(ipad);
assert.deepEqual(ipad.days["2026-11-06"], { ids: ["a", "b"], c: 10, extra: ["e"] });
assert.equal(ipad.flags.a.on, false);

// 새 기기는 전부 받고, 기존 기기는 최근 배정만 받는다
for (const day of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]) await syncState(db, { days: { [day]: { ids: ["a"], c: 1 } } });
assert.equal(Object.keys((await syncState(db, { cursor: 0 })).days).length, 5);
assert.equal(Object.keys((await syncState(db, { cursor: 999 })).days).length, 3);

// 잘못된 입력은 저장하지 않는다
await syncState(db, { log: [{ t: "x", id: "a", ok: true }, { t: 9, id: 1, ok: true }, null, { t: 9, id: "x".repeat(41), ok: true }], days: { bad: { ids: [], c: 1 }, "2026-01-01": { ids: "x", c: 1 } }, flags: { a: { on: "yes", t: 1 } } });
const all = await syncState(db, { cursor: 0 });
assert.equal(all.log.length, 4);
assert.equal(all.days.bad, undefined);
assert.equal(all.flags.a.on, false);

// 초기화 뒤에는 옛 기기의 기록을 받지 않고 사본을 버리게 한다
db.exec("DELETE FROM attempts; UPDATE meta SET value = 2 WHERE key = 'epoch'");
const stale = await syncState(db, { log: [{ t: 50, id: "old", ok: false }], cursor: 10, epoch: 1 });
assert.deepEqual(stale, { reset: true, epoch: 2 });
assert.deepEqual(await syncState(db, { log: [{ t: 51, id: "old", ok: false }], cursor: 10 }), { reset: true, epoch: 2 });
const fresh = await syncState(db, { cursor: 0, epoch: 2 });
assert.equal(fresh.log.length, 0);
assert.ok(fresh.days["2026-11-06"]);
const after = await syncState(db, { log: [{ t: 52, id: "new", ok: true }], cursor: 0, epoch: 2 });
assert.deepEqual(after.log.map((e) => e.id), ["new"]);

console.log("store ok");
