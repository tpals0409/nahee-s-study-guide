import assert from "node:assert/strict";
import { radarViews, radarFace } from "./radar.js";

const byId = new Map([
  ["a", { subject: "민법개론", topic: "물권법" }],
  ["b", { subject: "민법개론", topic: "채권총론" }],
  ["c", { subject: "자연과학개론", topic: "물리" }],
]);
const time = (day) => new Date(`${day}T12:00:00`).getTime();
const log = [
  { id: "a", t: time("2026-11-06"), ok: true },
  { id: "a", t: time("2026-11-06"), ok: false },
  { id: "b", t: time("2026-11-05"), ok: true, amb: true },
  { id: "c", t: time("2026-10-31"), ok: false },
  { id: "c", t: time("2026-10-30"), ok: true },
  { id: "c", t: time("2026-11-07"), ok: true },
  { id: "missing", t: time("2026-11-06"), ok: true },
];
const views = radarViews(log, byId, "2026-11-06");
assert.deepEqual(views.map((v) => v.title), ["전체", "산업재산권법", "민법개론", "자연과학개론"]);
assert.deepEqual(views.map((v) => v.rows.length), [3, 5, 4, 4]);
assert.equal(views[0].rows[0].value, null);
assert.equal(views[0].rows[1].value, 67, "weight by attempts, not average of topic percentages");
assert.equal(views[0].rows[2].value, 0, "zero accuracy differs from no attempts");
assert.equal(views[2].rows[1].value, 50);
assert.equal(views[2].rows[2].value, 100, "ambiguous correct answers retain accuracy");
const missing = radarFace(views[1], 1);
assert.match(missing, /기록 없음/);
assert.doesNotMatch(missing, /class="radar-shape"|class="radar-point"|NaN/);
const partial = radarFace(views[0], 0);
assert.doesNotMatch(partial, /class="radar-shape"/);
assert.match(partial, /0%/);
const full = { ...views[0], rows: views[0].rows.map((r) => ({ ...r, value: 100, ok: 1, total: 1 })) };
assert.match(radarFace(full, 0), /class="radar-shape"/);
assert.equal((radarFace(full, 0).match(/class="radar-grid"/g) ?? []).length, 3);
assert.doesNotMatch(radarFace(full, 0), /radar-scale|radar-dots|radar-footer/);
assert.match(missing, /기록을 더 쌓아주세요/);
assert.doesNotMatch(partial, /radar-edge/);
assert.match(radarFace(full, 0), /linearGradient/);
console.log("radar ok");
