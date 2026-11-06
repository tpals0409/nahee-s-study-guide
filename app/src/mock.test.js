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
  .replace(/import \{ RADAR_PARTS, radarViews, radarFace \} from "\.\/radar\.js";/, "")
  .replaceAll("import.meta.env.PROD", "false")
  .replace(/boot\(\);\s*$/, "");
vm.runInContext(source, ctx);
const run = (code) => vm.runInContext(code, ctx);
run("const originalShell = shell;");
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
await run("ACTIONS['round-select']({year: '2024'});");
assert.match(app.innerHTML, /data-act="round" data-year="2024"/);
assert.doesNotMatch(app.innerHTML, /data-act="round" data-year="2025"/);
run("exam();");
assert.match(app.innerHTML, /data-act="round" data-year="2024"/);
run(`ACTIONS['round-start']({year: '2025', subject: '민법개론'});`);
assert.equal(run("session.mode"), "mock");
assert.equal(run("session.ids.join(',')"), "a,b");
assert.equal(run("session.orders.get('a').join(',')"), "0,1,2,3,4");
assert.doesNotMatch(app.innerHTML, /정답 확인|해설|class="mark"/);
listeners.change({ target: { name: "c", value: "1", closest: () => ({ classList: { add() {} } }) } });
listeners.change({ target: { name: "c", value: "0", closest: () => ({ classList: { add() {} } }) } });
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
listeners.change({ target: { name: "c", value: "1", closest: () => ({ classList: { add() {} } }) } });
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
// Direct selection and cycling share immediate rendering without skeleton delays.
const attributes = new Map();
const radarCard = { innerHTML: "", setAttribute: (k, v) => attributes.set(k, v) };
const radarStatus = { textContent: "" };
ctx.document.getElementById = (id) => id === "radar-card" ? radarCard : id === "radar-status" ? radarStatus : null;
ctx.document.querySelectorAll = () => [];
for (const title of ["산업재산권법", "민법개론", "자연과학개론", "전체"]) {
  run("ACTIONS['radar-next']()");
  assert.ok(radarStatus.textContent.startsWith(title));
  assert.match(radarCard.innerHTML, /content-enter/);
  assert.doesNotMatch(radarCard.innerHTML, /skeleton/);
}
run("ACTIONS['radar-select']({index: '2'})");
assert.equal(run("radarIndex"), 2);
const unchanged = radarCard.innerHTML;
run("ACTIONS['radar-select']({index: '2'})");
assert.equal(radarCard.innerHTML, unchanged);
console.log("mock flow and radar interaction ok");

// The initial route marks Home in the markup, without a separately positioned highlight.
run("location.hash = ''; countUp = () => {}; originalShell('home', '');");
assert.match(app.innerHTML, /data-tab="home" aria-current="page"/);
assert.doesNotMatch(app.innerHTML, /class="pill"/);
run("location.hash = '#stats'; originalShell('stats', '');");
assert.match(app.innerHTML, /data-tab="stats" aria-current="page"/);
assert.equal((app.innerHTML.match(/aria-current="page"/g) ?? []).length, 1);
console.log("navigation selection ok");

// Initial and repeat tab visits share one animation; same-page updates stay still.
run("lastTab = null; location.hash = '#home'; originalShell('home', '');");
assert.match(app.innerHTML, /shell page-enter/);
run("location.hash = '#exam'; originalShell('exam', '');");
assert.match(app.innerHTML, /shell page-enter/);
run("location.hash = '#home'; originalShell('home', '');");
assert.match(app.innerHTML, /shell page-enter/);
run("originalShell('home', '');");
assert.doesNotMatch(app.innerHTML, /page-enter/);
ctx.document.startViewTransition = () => { throw new Error('Tab navigation must not stack view transitions'); };
let reloads = 0;
ctx.location.reload = () => reloads++;
run("updatePending = true; session = { mode: 'mock' }; render();");
assert.equal(reloads, 0, "updates do not interrupt solving");
run("session = null; render();");
assert.equal(reloads, 1, "pending update applies after leaving the session");
run("updatePending = false;");
run("session = null; solveClosed = false; render = () => {}; paint();");
console.log("consistent tab motion ok");

// Empty notebooks still expose every standard subject and topic, with safe zero counts.
run("state = emptyState(); notes();");
for (const [subject, parts] of Object.entries(radar.RADAR_PARTS)) {
  run(`notesSubject = ${JSON.stringify(subject)}; notes();`);
  assert.ok(app.innerHTML.includes(subject));
  for (const part of parts) assert.ok(app.innerHTML.includes(part));
}
assert.doesNotMatch(app.innerHTML, /NaN|Infinity|data-act="review-all"/);
assert.match(app.innerHTML, /0문제/);
run("notes(['민법개론', '물권법']);");
assert.match(app.innerHTML, /복습 문항 없음/);
assert.doesNotMatch(app.innerHTML, /data-act="topic-review"/);
console.log("empty notebook topics ok");

assert.equal(run("notesSubject"), "민법개론", "detail preserves selected subject");
const toastNode = { textContent: "", classList: { add() {}, remove() {} } };
ctx.document.getElementById = (id) => id === "toast" ? toastNode : null;
ctx.clearTimeout = () => {};
ctx.setTimeout = () => 1;
const htmlBeforeToast = app.innerHTML;
run("ACTIONS['notes-empty']();");
assert.equal(toastNode.textContent, "등록된 오답이 없어요");
assert.equal(app.innerHTML, htmlBeforeToast, "empty topic leaves the screen intact");
run(`questions[0].topic = '물권법'; state.log = [{ id: 'b', ok: false, t: Date.now() }]; notes();`);
assert.match(app.innerHTML, /오늘 <strong>1<\/strong>/);
assert.match(app.innerHTML, /전체 1/);
assert.match(app.innerHTML, /a href="#notes\//);
assert.match(app.innerHTML, /data-act="notes-empty"/);
assert.doesNotMatch(app.innerHTML, /class="meter"/);
console.log("notebook counts and empty toast ok");

// Calendar changes update only the calendar; summaries count attempts and distinct days.
const calendarBody = { innerHTML: "" };
const detailBody = { innerHTML: "" };
ctx.document.getElementById = (id) => id === "calendar-body" ? calendarBody : id === "record-detail" ? detailBody : null;
ctx.document.querySelector = () => null;
run("calendarMonth = '2026-01'; selectedRecordDay = '2026-01-31'; ACTIONS.month({delta: '-1'});");
assert.equal(run("calendarMonth"), '2025-12');
assert.equal(run("selectedRecordDay"), '2025-12-01');
assert.equal(radarCard.innerHTML, unchanged, 'month changes leave radar untouched');
assert.match(calendarBody.innerHTML, /data-act="record-day"/);
assert.match(calendarBody.innerHTML, /풀이 횟수/);
run("ACTIONS['record-day']({day: '2025-12-02'});");
assert.match(detailBody.innerHTML, /이날은 학습 기록이 없어요/);
assert.equal(run("recordSummary([{t: Date.now(), ok:true}, {t:Date.now(),ok:false}]).rate"), '50%');
assert.equal(run("recordSummary([{t: Date.now(), ok:true}, {t:Date.now(),ok:false}]).days"), 1);
assert.equal(run("recordSummary([]).rate"), '기록 없음');
run("stats();");
assert.match(app.innerHTML, /최근 7일/);
assert.match(app.innerHTML, /학습한 날/);
assert.match(app.innerHTML, /stats-layout/);
console.log("learning records summary and calendar ok");
