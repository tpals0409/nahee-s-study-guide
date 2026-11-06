import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as logic from "./logic.js";
import * as radar from "./radar.js";

// Exercise the actual screen handlers with browser storage and DOM boundaries stubbed.
const storage = new Map();
const listeners = {};
const app = { innerHTML: "" };
let explanationLoads = 0;
let dialogClosed = 0;
const ctx = vm.createContext({
  ...logic, ...radar, console, Date, setInterval: () => 1, clearInterval: () => {},
  document: {
    getElementById: (id) => id === "app" ? app : id === "confirm" ? { close: () => dialogClosed++ } : null,
    addEventListener: (type, fn) => { listeners[type] = fn; },
  },
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
  location: { hash: "#exam" }, history: { pushState() {}, replaceState() {} },
  scrollY: 0, scrollTo() {}, requestAnimationFrame() {}, addEventListener() {}, visualViewport: null,
  explanationLoaded: () => explanationLoads++,
});
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8")
  .replace(/^import\s*\{[\s\S]*?from "\.\/logic\.js";/, "")
  .replace(/import \{ radarViews, radarFace \} from "\.\/radar\.js";/, "")
  .replaceAll("import.meta.env.PROD", "false")
  .replace(/boot\(\);\s*$/, "");
vm.runInContext(source, ctx);
const run = (code) => vm.runInContext(code, ctx);
run(`
  questions = [
    {id: 'b', year: 2025, round: 62, subject: '민법개론', number: 2, stem: 'B', choices: ['a','b','c','d','e'], answer: [2]},
    {id: 'a', year: 2025, round: 62, subject: '민법개론', number: 1, stem: 'A', choices: ['a','b','c','d','e'], answer: [1]},
    {id: 'other', year: 2024, round: 61, subject: '민법개론', number: 1, choices: [], answer: [1]}
  ];
  byId = new Map(questions.map(q => [q.id, q]));
  save = () => {};
  loadExplain = () => explanationLoaded();
  shell = (tab, body) => { app.innerHTML = body; };
  exam();
`);
assert.match(app.innerHTML, /기출 모의고사/);
assert.doesNotMatch(app.innerHTML, /실전 모의고사|연도 회차별 풀기|data-act="mock"/);
assert.match(app.innerHTML, /aria-haspopup="dialog"/);
assert.doesNotMatch(app.innerHTML, /<select/);
run("ACTIONS['round-select']({year: '2024'});");
assert.match(app.innerHTML, /data-act="round" data-year="2024"/);
assert.doesNotMatch(app.innerHTML, /data-act="round" data-year="2025"/);
run("exam();");
assert.match(app.innerHTML, /data-act="round" data-year="2024"/);
run(`ACTIONS['round-start']({year: '2025', subject: '민법개론'});`);
assert.equal(run("session.mode"), "mock");
assert.equal(run("session.ids.join(',')"), "a,b");
assert.equal(run("session.orders.get('a').join(',')"), "0,1,2,3,4");
assert.doesNotMatch(app.innerHTML, /정답 확인|해설|class="mark"/);
listeners.change({ target: { name: "c", value: "1" } });
listeners.change({ target: { name: "c", value: "0" } });
assert.equal(run("session.picks.a"), 0);
assert.equal(run("state.log.length"), 0);
run("submitMock(); submitMock();");
assert.equal(run("state.log.length"), 2, "submission must only grade once");
assert.equal(run("session.score"), 1);
assert.equal(run("state.log[1].ok"), false, "unanswered questions count as wrong");
assert.match(app.innerHTML, /50점/);
assert.match(app.innerHTML, /미응답/);
assert.match(app.innerHTML, /data-act="mock-review"/);
run("openMockReview(1);");
assert.equal(explanationLoads, 1);
assert.match(app.innerHTML, /aria-label="해설"/);
assert.match(app.innerHTML, /disabled/);
listeners.change({ target: { name: "c", value: "1" } });
assert.equal(run("session.picks.b"), undefined, "review cannot change submitted answers");
run("commit(); ACTIONS['mock-review-move']({delta: '-1'}); commit();");
assert.equal(run("state.log.length"), 2, "review must not record more attempts");
run("session = null; resume();");
assert.equal(run("session.mode"), "mock-review");
assert.equal(run("session.revealed"), true);
run("ACTIONS['mock-result'](); commit(); session = null; resume(); commit();");
assert.equal(run("state.log.length"), 2, "leaving restored results must not record attempts");
assert.equal(run("session.mode"), "mock-result");
assert.match(app.innerHTML, /50점/);
run(`ACTIONS['round-start']({year: '2025', subject: '민법개론'}); session.deadline = 0; mockClock(); mockClock();`);
assert.equal(run("session.mode"), "mock-result");
assert.equal(run("state.log.length"), 4, "timeout grades all questions once");
assert.ok(dialogClosed >= 2, "timeout closes submission/abandon confirmation");
// Card cycling uses the actual click handler; reduced motion switches without rotation.
const radarCard = { innerHTML: "", isConnected: true, setAttribute() {}, getAnimations: () => [] };
const radarStatus = { textContent: "" };
ctx.matchMedia = () => ({ matches: true });
ctx.document.getElementById = (id) => id === "radar-card" ? radarCard : id === "radar-status" ? radarStatus : null;
for (const title of ["산업재산권법", "민법개론", "자연과학개론", "전체"]) {
  await run("ACTIONS['radar-next']()");
  assert.ok(radarStatus.textContent.startsWith(title));
  assert.ok(radarCard.innerHTML.includes(title));
}
assert.equal(run("radarFlipping"), false);
console.log("mock flow and radar interaction ok");
